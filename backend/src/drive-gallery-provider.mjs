import { ApiError, DriveError } from './errors.mjs';
import { googleErrorReason, safeDiagnostic } from './diagnostics.mjs';

const API = 'https://www.googleapis.com/drive/v3/files';
const FIELDS = 'id,size,mimeType,appProperties,trashed,thumbnailLink,description';
const ID = /^[A-Za-z0-9_-]{1,256}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_GRID_ORIGINAL_BYTES = 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);

function preparing(reason = 'unknown') {
  return new ApiError(503, 'Preview is being prepared. Please try again in a moment.', {
    retryable: true, retryAfter: 3,
    diagnostics: { upstream: 'drive', operation: 'get_thumbnail', reason },
  });
}

function thumbnailUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || !/^lh[1-6]\.googleusercontent\.com$/.test(url.hostname)
      || url.port || url.username || url.password || url.hash) return null;
  return url;
}

async function bytesFrom(response, limit, operation) {
  const invalid = () => new DriveError(502, { operation, reason: 'invalid_response', upstreamStatus: response.status });
  const length = response.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > limit)) {
    await response.body?.cancel().catch(() => {});
    throw invalid();
  }
  const reader = response.body?.getReader();
  if (!reader) throw invalid();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > limit) {
      await reader.cancel().catch(() => {});
      throw invalid();
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, received);
}

async function jsonFrom(response, operation) {
  const bytes = await bytesFrom(response, 65536, operation);
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new DriveError(502, { operation, reason: 'invalid_response', upstreamStatus: response.status }); }
}

export function createDriveGalleryProvider({ auth, fetchImpl = globalThis.fetch, timeoutMs = 25000 }) {
  async function token() {
    let timer;
    try {
      const response = await Promise.race([
        auth.getAccessToken(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new DriveError(503, {
          upstream: 'oauth', operation: 'refresh_token', reason: 'timeout', upstreamStatus: undefined,
        })), timeoutMs); }),
      ]);
      const value = typeof response === 'string' ? response : response?.token;
      if (!value) throw new DriveError(503, { upstream: 'oauth', operation: 'refresh_token', reason: 'invalid_response', upstreamStatus: undefined });
      return value;
    } catch (error) {
      if (error instanceof DriveError) throw error;
      throw new DriveError(503, { upstream: 'oauth', operation: 'refresh_token', reason: safeDiagnostic(error).reason, upstreamStatus: error?.response?.status });
    } finally { clearTimeout(timer); }
  }

  async function request(url, operation, accessToken) {
    try {
      return await fetchImpl(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new DriveError(503, {
        operation, upstreamStatus: undefined,
        reason: ['TimeoutError', 'AbortError'].includes(error?.name) ? 'timeout' : 'network_error',
      });
    }
  }

  async function failure(response, operation) {
    const body = await jsonFrom(response, operation).catch(() => null);
    throw new DriveError(response.status, { operation, upstreamStatus: response.status, reason: googleErrorReason(body) });
  }

  async function imageFrom(url, accessToken, limit = MAX_IMAGE_BYTES) {
    const operation = 'get_thumbnail';
    const response = await request(url, operation, accessToken);
    if (!response.ok) return failure(response, operation);
    const contentType = (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
    if (!IMAGE_TYPES.has(contentType)) {
      await response.body?.cancel().catch(() => {});
      throw preparing('invalid_response');
    }
    const bytes = await bytesFrom(response, limit, operation);
    if (!bytes.length) throw preparing('invalid_response');
    return { bytes, contentType };
  }

  return {
    async getFolderFileIds(folderId, uploadIds) {
      const operation = 'list_files';
      if (typeof folderId !== 'string' || !ID.test(folderId) || !Array.isArray(uploadIds)
          || uploadIds.length > 36 || uploadIds.some((id) => typeof id !== 'string' || !UUID.test(id))) {
        throw new DriveError(502, { operation, reason: 'invalidParameter', upstreamStatus: undefined });
      }
      const ids = [...new Set(uploadIds)];
      const files = new Set();
      if (!ids.length) return files;
      // Search current folder contents instead of comparing file.parents.
      // Restrict the query to this page's upload markers, so large wedding
      // albums do not need a full Drive folder scan on every image request.
      const markers = ids.map((id) => `appProperties has { key='uploadId' and value='${id}' }`).join(' or ');
      const query = new URLSearchParams({
        q: `'${folderId}' in parents and trashed = false and (${markers})`,
        fields: 'nextPageToken,incompleteSearch,files(id)', pageSize: '100', spaces: 'drive',
        supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
      });
      const accessToken = await token();
      const invalid = (status) => new DriveError(502, { operation, reason: 'invalid_response', upstreamStatus: status });
      for (let page = 0; page < 10; page += 1) {
        const response = await request(`${API}?${query}`, operation, accessToken);
        if (!response.ok) return failure(response, operation);
        const body = await jsonFrom(response, operation);
        if (!body || !Array.isArray(body.files) || body.files.length > 100 || body.incompleteSearch === true
            || (body.incompleteSearch !== undefined && typeof body.incompleteSearch !== 'boolean')
            || body.files.some((file) => typeof file?.id !== 'string' || !ID.test(file.id))) {
          throw invalid(response.status);
        }
        for (const file of body.files) files.add(file.id);
        if (body.nextPageToken === undefined || body.nextPageToken === null || body.nextPageToken === '') return files;
        if (typeof body.nextPageToken !== 'string' || body.nextPageToken.length > 4096) throw invalid(response.status);
        query.set('pageToken', body.nextPageToken);
      }
      // An incomplete result cannot establish that an indexed file is absent.
      throw invalid(undefined);
    },

    async getMetadata(fileId) {
      const operation = 'get_file';
      if (typeof fileId !== 'string' || !ID.test(fileId)) throw new DriveError(502, { operation, reason: 'invalidParameter', upstreamStatus: undefined });
      const query = new URLSearchParams({ fields: FIELDS, supportsAllDrives: 'true' });
      const response = await request(`${API}/${fileId}?${query}`, operation, await token());
      if (response.status === 404) {
        await response.body?.cancel().catch(() => {});
        return null;
      }
      if (!response.ok) return failure(response, operation);
      return jsonFrom(response, operation);
    },

    async thumbnail(metadata, { variant = 'thumbnail' } = {}) {
      if (!metadata || typeof metadata.id !== 'string' || !ID.test(metadata.id)
          || !['thumbnail', 'preview'].includes(variant)) throw preparing('invalid_response');
      const original = thumbnailUrl(metadata.thumbnailLink);
      // Never send an OAuth token to an arbitrary link or follow redirects.
      // An explicitly present but unsafe Google metadata URL is rejected.
      if (metadata.thumbnailLink && !original) throw preparing('invalid_response');
      const candidates = [];
      if (original) {
        if (!original.search && /=s\d{1,5}$/.test(original.pathname)) {
          const resized = new URL(original.toString());
          resized.pathname = resized.pathname.replace(/=s\d{1,5}$/, variant === 'preview' ? '=s1600' : '=s480');
          if (resized.toString() !== original.toString()) candidates.push(resized.toString());
        }
        candidates.push(original.toString());
      }
      const originalLimit = variant === 'thumbnail' ? MAX_GRID_ORIGINAL_BYTES : MAX_IMAGE_BYTES;
      const canUseOriginal = ['image/jpeg', 'image/png'].includes(metadata.mimeType)
        && Number.isSafeInteger(Number(metadata.size)) && Number(metadata.size) > 0 && Number(metadata.size) <= originalLimit;
      if (!candidates.length && !canUseOriginal) throw preparing();
      const accessToken = await token();
      for (const url of candidates) {
        try { return await imageFrom(url, accessToken); }
        catch { /* A resized thumbnail can be unavailable; retry its original. */ }
      }
      if (canUseOriginal) {
        try { return await imageFrom(`${API}/${metadata.id}?alt=media&supportsAllDrives=true`, accessToken, originalLimit); }
        catch { /* Original reads are also bounded, and only small JPEG/PNG. */ }
      }
      throw preparing();
    },
  };
}
