import { createUploadAuth } from './auth.mjs';
import { ApiError } from './errors.mjs';
import { GALLERY_IMAGE_MIME_TYPES } from './gallery-index.mjs';
import { safeDiagnostic } from './diagnostics.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SERVED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
export const MAX_GALLERY_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_CACHE_TTL_MS = 5 * 60 * 1000;

const notFound = () => new ApiError(404, 'Photo not found.');
const unavailable = (error) => new ApiError(503, 'The photo album is temporarily unavailable. Please try again.', {
  retryable: true, retryAfter: 3, diagnostics: safeDiagnostic(error),
});

function validPhoto(photo, id = photo?.id) {
  return photo && typeof id === 'string' && UUID.test(id) && photo.id === id
    && typeof photo.fileId === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(photo.fileId)
    && GALLERY_IMAGE_MIME_TYPES.has(photo.mimeType)
    && Number.isSafeInteger(photo.size) && photo.size > 0;
}

export function createGalleryService({
  repository, drive, uploadCode, tokenSecret, now = Date.now,
  cacheBytes = MAX_CACHE_BYTES, cacheTtlMs = MAX_CACHE_TTL_MS,
}) {
  const auth = createUploadAuth({ uploadCode, tokenSecret });
  const capacity = Number.isSafeInteger(cacheBytes) && cacheBytes >= 0 ? Math.min(cacheBytes, MAX_CACHE_BYTES) : MAX_CACHE_BYTES;
  const ttl = Number.isSafeInteger(cacheTtlMs) && cacheTtlMs >= 0 ? Math.min(cacheTtlMs, MAX_CACHE_TTL_MS) : MAX_CACHE_TTL_MS;
  const cache = new Map();
  const inflight = new Map();
  let cachedBytes = 0;
  const timestamp = () => { const value = now(); return value instanceof Date ? value.getTime() : value; };

  function authenticate(code) {
    if (!auth.checkCode(code)) throw new ApiError(401, 'The guest code is incorrect. Please reopen the wedding website.');
  }

  function remove(key) {
    const item = cache.get(key);
    if (item) cachedBytes -= item.value.bytes.length;
    cache.delete(key);
  }

  function cached(key) {
    const item = cache.get(key);
    if (!item) return null;
    if (item.until <= timestamp()) { remove(key); return null; }
    cache.delete(key);
    cache.set(key, item);
    return item.value;
  }

  function remember(key, value) {
    if (!ttl || value.bytes.length > capacity) return;
    const instant = timestamp();
    for (const [id, entry] of cache) if (entry.until <= instant) remove(id);
    remove(key);
    while (cachedBytes + value.bytes.length > capacity && cache.size) remove(cache.keys().next().value);
    cache.set(key, { value, until: instant + ttl });
    cachedBytes += value.bytes.length;
  }

  async function loadImage(id, variant) {
    await repository.seedCompletedUploads();
    const photo = await repository.get(id);
    if (!validPhoto(photo, id)) throw notFound();
    const metadata = await drive.getMetadata(photo.fileId);
    if (!metadata || metadata.trashed === true) throw notFound();
    if (metadata.id !== photo.fileId || String(metadata.size) !== String(photo.size)
        || metadata.mimeType !== photo.mimeType || metadata.appProperties?.uploadId !== photo.id) {
      throw unavailable({ diagnostics: { upstream: 'drive', operation: 'verify_file', reason: 'metadata_mismatch' } });
    }
    const result = await drive.thumbnail(metadata, { variant });
    if (!result || !Buffer.isBuffer(result.bytes) || !result.bytes.length
        || result.bytes.length > MAX_GALLERY_IMAGE_BYTES || !SERVED_IMAGE_TYPES.has(result.contentType)) {
      throw unavailable({ diagnostics: { upstream: 'drive', operation: 'get_thumbnail', reason: 'invalid_response' } });
    }
    // Keep only the image and its safe content type, never provider URLs or IDs.
    return { bytes: result.bytes, contentType: result.contentType };
  }

  return {
    async list(options = {}, code) {
      authenticate(code);
      if (!options || typeof options !== 'object' || Array.isArray(options)) throw new ApiError(400, 'The album page request is invalid.');
      try {
        await repository.seedCompletedUploads();
        const result = await repository.list({ cursor: options.cursor, limit: options.limit ?? 18 });
        return {
          ok: true,
          photos: result.photos.filter((photo) => validPhoto(photo) && photo.createdAt instanceof Date
            && Number.isFinite(photo.createdAt.getTime())).map((photo) => ({
            id: photo.id, createdAt: photo.createdAt.toISOString(), mimeType: photo.mimeType,
          })),
          nextCursor: result.nextCursor || null,
        };
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw unavailable(error);
      }
    },

    async image(id, options = {}, code) {
      // Authenticate before cache and in-flight lookup on every request.
      authenticate(code);
      if (typeof id !== 'string' || !UUID.test(id)) throw notFound();
      if (!options || typeof options !== 'object' || Array.isArray(options)) throw new ApiError(400, 'The photo preview request is invalid.');
      const variant = options.variant ?? 'thumbnail';
      if (!['thumbnail', 'preview'].includes(variant)) throw new ApiError(400, 'The photo preview variant is invalid.');
      const photoId = id.toLowerCase();
      const key = `${photoId}:${variant}`;
      const hit = cached(key);
      if (hit) return hit;
      if (inflight.has(key)) return inflight.get(key);
      const pending = loadImage(photoId, variant).then((value) => {
        remember(key, value);
        return value;
      }).catch((error) => {
        if (error instanceof ApiError) throw error;
        throw unavailable(error);
      }).finally(() => { inflight.delete(key); });
      inflight.set(key, pending);
      return pending;
    },
  };
}
