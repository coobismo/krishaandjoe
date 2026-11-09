import { DriveError } from './errors.mjs';
import { googleErrorReason, safeDiagnostic } from './diagnostics.mjs';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';
const FILE_FIELDS = 'id,size,mimeType,appProperties,trashed';
const ID = /^[A-Za-z0-9_-]{1,256}$/;

function sessionAddress(value, operation) {
  const invalid = () => new DriveError(502, { operation, reason: 'invalid_session_url', upstreamStatus: undefined });
  if (typeof value !== 'string') throw invalid();
  let url;
  try { url = new URL(value); } catch { throw invalid(); }
  if (url.origin !== 'https://www.googleapis.com' || url.pathname !== '/upload/drive/v3/files'
      || !url.searchParams.get('upload_id') || url.username || url.password) throw invalid();
  return url.toString();
}

async function limitedJson(response, operation) {
  const invalid = () => new DriveError(502, { operation, reason: 'invalid_response', upstreamStatus: response.status });
  const reader = response.body?.getReader();
  if (!reader) throw invalid();
  const parts = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 65536) {
      await reader.cancel();
      throw invalid();
    }
    parts.push(Buffer.from(value));
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw invalid(); }
}

async function boundedToken(auth, timeoutMs) {
  let timer;
  try {
    const result = await Promise.race([
      auth.getAccessToken(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new DriveError(503, {
        upstream: 'oauth', operation: 'refresh_token', reason: 'timeout', upstreamStatus: undefined,
      })), timeoutMs); }),
    ]);
    const token = typeof result === 'string' ? result : result?.token;
    if (!token) throw new DriveError(503, {
      upstream: 'oauth', operation: 'refresh_token', reason: 'invalid_response', upstreamStatus: undefined,
    });
    return token;
  } catch (error) {
    if (error instanceof DriveError) throw error;
    const diagnostic = safeDiagnostic(error);
    const timedOut = ['ETIMEDOUT', 'ECONNABORTED'].includes(error?.code) || ['TimeoutError', 'AbortError'].includes(error?.name);
    throw new DriveError(503, {
      upstream: 'oauth', operation: 'refresh_token',
      reason: timedOut ? 'timeout' : diagnostic.reason,
      upstreamStatus: error?.response?.status,
    });
  } finally { clearTimeout(timer); }
}

export function createDriveProvider({ auth, fetchImpl = globalThis.fetch, timeoutMs = 25000 }) {
  async function request(operation, url, options = {}) {
    const token = await boundedToken(auth, timeoutMs);
    try {
      return await fetchImpl(url, {
        ...options,
        headers: { ...options.headers, Authorization: `Bearer ${token}` },
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new DriveError(503, {
        operation, upstreamStatus: undefined,
        reason: ['TimeoutError', 'AbortError'].includes(error?.name) ? 'timeout' : 'network_error',
      });
    }
  }

  async function failure(response, operation) {
    let status = response.status;
    const body = await limitedJson(response, operation).catch(() => null);
    const reason = googleErrorReason(body);
    // Drive returns some per-user API limits as403 rather than429.
    if (status === 403) {
      if (body?.error?.errors?.some((entry) => ['rateLimitExceeded', 'userRateLimitExceeded'].includes(entry.reason))) status = 429;
    }
    throw new DriveError(status, { operation, reason, upstreamStatus: response.status });
  }

  async function progress(response, total, operation) {
    if ([200, 201].includes(response.status)) {
      await response.body?.cancel();
      return { status: 'complete', uploadedBytes: total };
    }
    if ([404, 410].includes(response.status)) {
      await response.body?.cancel();
      return { status: 'expired', uploadedBytes: 0 };
    }
    if (response.status === 308) {
      const range = response.headers.get('range');
      await response.body?.cancel();
      const match = range && /^bytes=0-(\d+)$/.exec(range);
      if (range && !match) throw new DriveError(502, { operation, reason: 'invalid_response', upstreamStatus: response.status });
      const uploadedBytes = match ? Number(match[1]) + 1 : 0;
      if (!Number.isSafeInteger(uploadedBytes) || uploadedBytes < 0 || uploadedBytes > total) throw new DriveError(502, { operation, reason: 'invalid_response', upstreamStatus: response.status });
      return { status: 'uploading', uploadedBytes };
    }
    return failure(response, operation);
  }

  return {
    async generateFileId() {
      const operation = 'generate_file_id';
      const response = await request(operation, `${API}/files/generateIds?count=1&space=drive&type=files`);
      if (!response.ok) return failure(response, operation);
      const body = await limitedJson(response, operation);
      if (!Array.isArray(body.ids) || body.ids.length !== 1 || typeof body.ids[0] !== 'string' || !ID.test(body.ids[0])) throw new DriveError(502, { operation, reason: 'invalid_response', upstreamStatus: response.status });
      return body.ids[0];
    },

    async getFile(fileId) {
      const operation = 'get_file';
      if (typeof fileId !== 'string' || !ID.test(fileId)) throw new DriveError(502, { operation, reason: 'invalidParameter', upstreamStatus: undefined });
      const query = new URLSearchParams({ fields: FILE_FIELDS, supportsAllDrives: 'true' });
      const response = await request(operation, `${API}/files/${fileId}?${query}`);
      if (response.status === 404) {
        await response.body?.cancel();
        return null;
      }
      if (!response.ok) return failure(response, operation);
      return limitedJson(response, operation);
    },

    async createSession({ fileId, uploadId, name, mimeType, size, folderId, guestName }) {
      const operation = 'create_session';
      if (typeof fileId !== 'string' || typeof folderId !== 'string' || !ID.test(fileId) || !ID.test(folderId)) throw new DriveError(502, { operation, reason: 'invalidParameter', upstreamStatus: undefined });
      const response = await request(operation, `${UPLOAD_API}?uploadType=resumable&supportsAllDrives=true&fields=${encodeURIComponent(FILE_FIELDS)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'X-Upload-Content-Type': mimeType,
          'X-Upload-Content-Length': String(size),
        },
        body: JSON.stringify({
          id: fileId, name, mimeType, parents: [folderId], appProperties: { uploadId },
          ...(guestName ? { description: `Shared by ${guestName}` } : {}),
        }),
      });
      if (!response.ok) return failure(response, operation);
      const location = response.headers.get('location');
      await response.body?.cancel();
      return sessionAddress(location, operation);
    },

    async querySession(sessionUrl, size) {
      const operation = 'query_session';
      const response = await request(operation, sessionAddress(sessionUrl, operation), {
        method: 'PUT',
        headers: { 'Content-Length': '0', 'Content-Range': `bytes */${size}` },
        body: Buffer.alloc(0),
      });
      return progress(response, size, operation);
    },

    async putChunk(sessionUrl, range, bytes) {
      const operation = 'put_chunk';
      const response = await request(operation, sessionAddress(sessionUrl, operation), {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(bytes.length),
          'Content-Range': `bytes ${range.start}-${range.end}/${range.total}`,
        },
        body: bytes,
      });
      return progress(response, range.total, operation);
    },
  };
}
