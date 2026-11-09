import { DriveError } from './errors.mjs';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';
const FILE_FIELDS = 'id,size,mimeType,parents,appProperties,trashed';
const ID = /^[A-Za-z0-9_-]{1,256}$/;

function sessionAddress(value) {
  if (typeof value !== 'string') throw new DriveError(502);
  let url;
  try { url = new URL(value); } catch { throw new DriveError(502); }
  if (url.origin !== 'https://www.googleapis.com' || url.pathname !== '/upload/drive/v3/files'
      || !url.searchParams.get('upload_id') || url.username || url.password) throw new DriveError(502);
  return url.toString();
}

async function limitedJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new DriveError(502);
  const parts = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 65536) {
      await reader.cancel();
      throw new DriveError(502);
    }
    parts.push(Buffer.from(value));
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw new DriveError(502); }
}

async function boundedToken(auth, timeoutMs) {
  let timer;
  try {
    const result = await Promise.race([
      auth.getAccessToken(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new DriveError(503)), timeoutMs); }),
    ]);
    const token = typeof result === 'string' ? result : result?.token;
    if (!token) throw new DriveError(503);
    return token;
  } finally { clearTimeout(timer); }
}

export function createDriveProvider({ auth, fetchImpl = globalThis.fetch, timeoutMs = 25000 }) {
  async function request(url, options = {}) {
    const token = await boundedToken(auth, timeoutMs);
    try {
      return await fetchImpl(url, {
        ...options,
        headers: { ...options.headers, Authorization: `Bearer ${token}` },
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch { throw new DriveError(503); }
  }

  async function failure(response) {
    let status = response.status;
    // Drive returns some per-user API limits as403 rather than429.
    if (status === 403) {
      const body = await limitedJson(response).catch(() => null);
      if (body?.error?.errors?.some((entry) => ['rateLimitExceeded', 'userRateLimitExceeded'].includes(entry.reason))) status = 429;
    } else await response.body?.cancel().catch(() => {});
    throw new DriveError(status);
  }

  async function progress(response, total) {
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
      if (range && !match) throw new DriveError(502);
      const uploadedBytes = match ? Number(match[1]) + 1 : 0;
      if (!Number.isSafeInteger(uploadedBytes) || uploadedBytes < 0 || uploadedBytes > total) throw new DriveError(502);
      return { status: 'uploading', uploadedBytes };
    }
    return failure(response);
  }

  return {
    async generateFileId() {
      const response = await request(`${API}/files/generateIds?count=1&space=drive&type=files`);
      if (!response.ok) return failure(response);
      const body = await limitedJson(response);
      if (!Array.isArray(body.ids) || body.ids.length !== 1 || typeof body.ids[0] !== 'string' || !ID.test(body.ids[0])) throw new DriveError(502);
      return body.ids[0];
    },

    async getFile(fileId) {
      if (typeof fileId !== 'string' || !ID.test(fileId)) throw new DriveError(502);
      const query = new URLSearchParams({ fields: FILE_FIELDS, supportsAllDrives: 'true' });
      const response = await request(`${API}/files/${fileId}?${query}`);
      if (response.status === 404) {
        await response.body?.cancel();
        return null;
      }
      if (!response.ok) return failure(response);
      return limitedJson(response);
    },

    async createSession({ fileId, uploadId, name, mimeType, size, folderId, guestName }) {
      if (typeof fileId !== 'string' || typeof folderId !== 'string' || !ID.test(fileId) || !ID.test(folderId)) throw new DriveError(502);
      const response = await request(`${UPLOAD_API}?uploadType=resumable&supportsAllDrives=true&fields=${encodeURIComponent(FILE_FIELDS)}`, {
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
      if (!response.ok) return failure(response);
      const location = response.headers.get('location');
      await response.body?.cancel();
      return sessionAddress(location);
    },

    async querySession(sessionUrl, size) {
      const response = await request(sessionAddress(sessionUrl), {
        method: 'PUT',
        headers: { 'Content-Length': '0', 'Content-Range': `bytes */${size}` },
        body: Buffer.alloc(0),
      });
      return progress(response, size);
    },

    async putChunk(sessionUrl, range, bytes) {
      const response = await request(sessionAddress(sessionUrl), {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(bytes.length),
          'Content-Range': `bytes ${range.start}-${range.end}/${range.total}`,
        },
        body: bytes,
      });
      return progress(response, range.total);
    },
  };
}
