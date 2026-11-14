import { isUploadEndpoint } from './uploadPhoto.mjs';

export const MAX_GALLERY_IMAGE_BYTES = 8 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PHOTO_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif',
  'image/heic', 'image/heif', 'image/tiff', 'image/bmp',
]);
const DISPLAY_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);

export class GalleryError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'GalleryError';
    this.code = code;
    if (Number.isInteger(status)) this.status = status;
  }
}

const aborted = () => new DOMException('The request was cancelled.', 'AbortError');
const loadError = (isImage, code = 'network') => new GalleryError(
  isImage ? 'We could not load this photo. Please try again.' : 'We could not load the gallery. Please try again.', code,
);

function endpointBase(endpoint) {
  if (!isUploadEndpoint(endpoint, 'cloud-run')) {
    throw new GalleryError('The gallery is not connected yet. Please try again later.', 'not-configured');
  }
  return endpoint.trim().replace(/\/+$/, '');
}

function validCursor(cursor) {
  return typeof cursor === 'string' && cursor.length > 0 && cursor.length <= 2048 && !/[\u0000-\u001f\u007f]/.test(cursor);
}

function rejectStatus(response, isImage) {
  const status = response.status;
  if ([401, 403].includes(status)) {
    return new GalleryError('Please refresh the site and enter the guest password again.', 'unauthorized', status);
  }
  if (isImage && status === 404) {
    return new GalleryError('This photo is no longer available.', 'not-found', status);
  }
  if (isImage && status === 503) {
    return new GalleryError('This photo’s preview is still being prepared. Please try again.', 'not-ready', status);
  }
  const error = loadError(isImage, status === 429 ? 'busy' : 'unavailable');
  error.status = status;
  return error;
}

async function request(url, { uploadCode, signal, timeoutMs = 30_000 }, read, isImage = false) {
  if (signal?.aborted) throw aborted();
  if (typeof uploadCode !== 'string' || !uploadCode.trim() || /[\r\n]/.test(uploadCode)) {
    throw new GalleryError('Please refresh the site and enter the guest password again.', 'unauthorized');
  }
  const controller = new AbortController();
  let timer;
  let cancelRequest;
  const interrupted = new Promise((_, reject) => { cancelRequest = reject; });
  const cancel = () => {
    controller.abort();
    // A caller-supplied abort reason may contain private application state.
    cancelRequest(aborted());
  };
  signal?.addEventListener('abort', cancel, { once: true });
  timer = setTimeout(() => {
    controller.abort();
    cancelRequest(loadError(isImage, 'timeout'));
  }, timeoutMs);
  const send = async () => {
    const response = await fetch(url, {
      method: 'GET', mode: 'cors', credentials: 'omit', redirect: 'error', cache: 'no-store',
      headers: { 'X-Upload-Code': uploadCode }, signal: controller.signal,
    });
    if (!response.ok || response.type === 'opaque') {
      response.body?.cancel?.().catch(() => {});
      throw rejectStatus(response, isImage);
    }
    return read(response, controller.signal);
  };
  try {
    return await Promise.race([send(), interrupted]);
  } catch (error) {
    if (signal?.aborted) throw aborted();
    if (error instanceof GalleryError) throw error;
    throw loadError(isImage);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

function publicGuestName(value) {
  if (typeof value !== 'string' || value.length > 4096) return '';
  for (const character of value) {
    const unit = character.charCodeAt(0);
    if (character.length === 1 && unit >= 0xd800 && unit <= 0xdfff) return '';
  }
  const name = value.normalize('NFC').replace(/\s+/gu, ' ')
    .replace(/[\p{Cc}\p{Cf}]/gu, (character) => /[\u200c\u200d]/u.test(character) ? character : '').trim();
  return name.length <= 100 && /[\p{L}\p{N}\p{P}\p{S}]/u.test(name) ? name : '';
}

function galleryPage(body) {
  if (body?.ok !== true || !Array.isArray(body.photos) || body.photos.length > 100
    || (body.nextCursor !== null && !validCursor(body.nextCursor))) throw loadError(false, 'invalid-response');
  const seen = new Set();
  const photos = body.photos.map((photo) => {
    const timestamp = typeof photo?.createdAt === 'string' ? new Date(photo.createdAt) : null;
    if (typeof photo?.id !== 'string' || !UUID.test(photo.id) || seen.has(photo.id)
      || !PHOTO_TYPES.has(photo.mimeType) || !timestamp || !Number.isFinite(timestamp.getTime())
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(photo.createdAt)
      || timestamp.toISOString().slice(0, 19) !== photo.createdAt.slice(0, 19)) throw loadError(false, 'invalid-response');
    seen.add(photo.id);
    const guestName = publicGuestName(photo.guestName);
    // Project explicitly: Drive file IDs, URLs and other server fields never
    // leave this module as gallery metadata.
    return {
      id: photo.id, createdAt: timestamp.toISOString(), mimeType: photo.mimeType,
      ...(guestName ? { guestName } : {}),
    };
  });
  return { photos, nextCursor: body.nextCursor };
}

export async function getGallery(endpoint, { uploadCode, cursor, signal, timeoutMs } = {}) {
  const base = endpointBase(endpoint);
  if (cursor !== undefined && cursor !== null && !validCursor(cursor)) throw loadError(false, 'invalid-cursor');
  const query = cursor ? `?${new URLSearchParams({ cursor })}` : '';
  return request(`${base}/v1/gallery${query}`, { uploadCode, signal, timeoutMs }, async (response) => (
    galleryPage(await response.json())
  ));
}

async function imageBlob(response, signal) {
  const mimeType = (response.headers.get('Content-Type') || '').split(';', 1)[0].trim().toLowerCase();
  if (!DISPLAY_TYPES.has(mimeType)) {
    response.body?.cancel?.().catch(() => {});
    throw new GalleryError('This photo could not be displayed. Please try another photo.', 'unsupported-image');
  }
  const tooLarge = () => new GalleryError('This photo’s preview is too large to display. Please try another photo.', 'image-too-large');
  const declaredLength = response.headers.get('Content-Length');
  if (declaredLength && Number(declaredLength) > MAX_GALLERY_IMAGE_BYTES) {
    response.body?.cancel?.().catch(() => {});
    throw tooLarge();
  }
  const reader = response.body?.getReader?.();
  let blob;
  if (reader) {
    const parts = [];
    let bytes = 0;
    const cancel = () => { reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      if (signal.aborted) throw aborted();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_GALLERY_IMAGE_BYTES) {
          await reader.cancel();
          throw tooLarge();
        }
        parts.push(value);
      }
      blob = new Blob(parts, { type: mimeType });
    } finally {
      signal.removeEventListener('abort', cancel);
      reader.releaseLock();
    }
  } else {
    blob = await response.blob();
    if (blob.size > MAX_GALLERY_IMAGE_BYTES) throw tooLarge();
    // Trust only the validated response header for the object URL's type.
    blob = new Blob([blob], { type: mimeType });
  }
  if (!blob.size) throw loadError(true, 'invalid-image');
  return blob;
}

export async function fetchGalleryImage(endpoint, photoId, { uploadCode, variant = 'thumbnail', signal, timeoutMs } = {}) {
  const base = endpointBase(endpoint);
  if (typeof photoId !== 'string' || !UUID.test(photoId) || !['thumbnail', 'preview'].includes(variant)) {
    throw new GalleryError('This photo is no longer available.', 'not-found');
  }
  return request(`${base}/v1/gallery/${encodeURIComponent(photoId)}/image?${new URLSearchParams({ variant })}`, {
    uploadCode, signal, timeoutMs,
  }, imageBlob, true);
}
