import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError } from './errors.mjs';

export const MAX_GALLERY_VIDEO_BYTES = 500 * 1024 * 1024;
export const PLAYBACK_TOKEN_TTL_MS = 30 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = (value) => createHash('sha256').update(value).digest();

// This capability authorizes one gallery UUID for playback only. It never
// contains a Drive file ID, Google access token, or the shared guest password.
export function createPlaybackAuth({ tokenSecret, now = Date.now }) {
  const signature = (id, expiresAt) => createHmac('sha256', tokenSecret)
    .update(`gallery-video:v1:${id}:${expiresAt}`).digest('base64url');
  return {
    issue(id) {
      const expiresAt = Math.floor(now()) + PLAYBACK_TOKEN_TTL_MS;
      return { token: `${expiresAt}.${signature(id, expiresAt)}`, expiresAt: new Date(expiresAt).toISOString() };
    },
    check(id, value) {
      if (typeof id !== 'string' || !UUID.test(id) || typeof value !== 'string' || value.length > 100) return false;
      const match = /^([1-9]\d{0,14})\.([A-Za-z0-9_-]{43})$/.exec(value);
      if (!match) return false;
      const expiresAt = Number(match[1]);
      const instant = now();
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= instant) return false;
      return timingSafeEqual(digest(match[2]), digest(signature(id, expiresAt)));
    },
  };
}

// Native video controls request single byte ranges for metadata and seeking.
// Multipart responses are deliberately unsupported; all bounds stay within
// the independently verified file size before any bytes are requested.
export function parseVideoRange(value, size) {
  const invalid = () => {
    const error = new ApiError(416, 'This video byte range is not available.');
    error.rangeSize = size;
    return error;
  };
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_GALLERY_VIDEO_BYTES) throw invalid();
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 128) throw invalid();
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match || (!match[1] && !match[2])) throw invalid();
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw invalid();
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) throw invalid();
  return { start, end: Math.min(end, size - 1) };
}
