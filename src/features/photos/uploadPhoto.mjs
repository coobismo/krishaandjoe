import { uploadResumablePhoto } from './resumableUpload.mjs';

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const RESUMABLE_MAX_FILE_BYTES = 500 * 1024 * 1024;
export const MAX_FILES = 20;

export function getUploadLimits(provider = 'apps-script') {
  return {
    maxFileBytes: provider === 'cloud-run' ? RESUMABLE_MAX_FILE_BYTES : MAX_FILE_BYTES,
    maxFiles: MAX_FILES,
  };
}

const MIME_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif',
  'image/heic', 'image/heif', 'image/tiff', 'image/bmp',
  'video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v',
  'video/3gpp', 'video/3gpp2',
]);

const EXTENSIONS = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif',
  tif: 'image/tiff', tiff: 'image/tiff', bmp: 'image/bmp', mp4: 'video/mp4',
  mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/x-m4v',
  '3gp': 'video/3gpp', '3g2': 'video/3gpp2',
};

export const ACCEPTED_FILES = [
  ...MIME_TYPES,
  ...Object.keys(EXTENSIONS).map((extension) => `.${extension}`),
].join(',');

export function getPhotoMimeType(file) {
  const mimeType = typeof file?.type === 'string' ? file.type.trim().toLowerCase() : '';
  if (MIME_TYPES.has(mimeType)) return mimeType;
  if (mimeType && mimeType !== 'application/octet-stream') return '';
  const extension = typeof file?.name === 'string' ? file.name.match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase() : '';
  return Object.hasOwn(EXTENSIONS, extension) ? EXTENSIONS[extension] : '';
}

export function validatePhoto(file, maxBytes = MAX_FILE_BYTES) {
  if (!file || !Number.isSafeInteger(file.size) || file.size <= 0) {
    return 'This file is empty or could not be read. Please choose another file.';
  }
  if (file.size > maxBytes) return `Please choose a photo or video no larger than ${Math.round(maxBytes / (1024 * 1024))} MB.`;
  if (!getPhotoMimeType(file)) return 'Please choose a supported photo or video file.';
  return '';
}

export function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function isUploadEndpoint(endpoint, provider = 'apps-script') {
  if (typeof endpoint !== 'string' || !endpoint.trim()) return false;
  try {
    const url = new URL(endpoint.trim());
    if (url.username || url.password || url.search || url.hash) return false;
    if (provider === 'cloud-run') {
      const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      return url.protocol === 'https:' || (isLocal && url.protocol === 'http:');
    }
    if (provider !== 'apps-script') return false;
    return url.protocol === 'https:' && url.hostname === 'script.google.com'
      && !url.port && !url.username && !url.password && !url.search && !url.hash
      && /^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url.pathname);
  } catch {
    return false;
  }
}

class UploadError extends Error {}

const UNCONFIRMED_MESSAGE = 'We could not confirm this upload. Please try again; retrying the same file here will not create a duplicate.';

function readPhoto(file, signal) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    function cleanup() {
      signal.removeEventListener('abort', abort);
      reader.onload = null;
      reader.onerror = null;
      reader.onabort = null;
    }
    function abort() {
      cleanup();
      reader.abort();
      reject(new UploadError(UNCONFIRMED_MESSAGE));
    }
    reader.onload = () => {
      const result = reader.result;
      cleanup();
      if (typeof result !== 'string' || !/^data:.*;base64,.+/.test(result)) {
        reject(new UploadError('We could not read this file. Please select it again.'));
        return;
      }
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => {
      cleanup();
      reject(new UploadError('We could not read this file. Please select it again.'));
    };
    reader.onabort = () => {
      cleanup();
      reject(new UploadError(UNCONFIRMED_MESSAGE));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    else {
      try {
        reader.readAsDataURL(file);
      } catch {
        cleanup();
        reject(new UploadError('We could not read this file. Please select it again.'));
      }
    }
  });
}

// Send a simple CORS request so Apps Script can redirect to its JSON receipt.
// An opaque no-cors response cannot prove that the file reached Drive.
export async function uploadPhoto(endpoint, { file, uploadId, guestName = '' }, options = {}) {
  const { timeoutMs = 120_000, provider = 'apps-script' } = options;
  if (!isUploadEndpoint(endpoint, provider)) {
    throw new UploadError('Photo uploads are not connected yet. Please try again later.');
  }
  const validationError = validatePhoto(file, getUploadLimits(provider).maxFileBytes);
  if (validationError) throw new UploadError(validationError);
  if (typeof uploadId !== 'string' || !uploadId) {
    throw new UploadError('We could not prepare this upload. Please select the file again.');
  }
  if (provider === 'cloud-run') {
    return uploadResumablePhoto(endpoint.trim().replace(/\/+$/, ''), {
      file, uploadId, guestName, mimeType: getPhotoMimeType(file),
    }, options);
  }

  const controller = new AbortController();
  let timer;
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new UploadError(UNCONFIRMED_MESSAGE));
    }, timeoutMs);
  });
  const send = async () => {
    const data = await readPhoto(file, controller.signal);
    const response = await fetch(endpoint.trim(), {
      method: 'POST',
      mode: 'cors',
      redirect: 'follow',
      credentials: 'omit',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      signal: controller.signal,
      body: JSON.stringify({ uploadId, name: file.name, mimeType: getPhotoMimeType(file), data, guestName }),
    });
    if (!response.ok || response.type === 'opaque') throw new UploadError(UNCONFIRMED_MESSAGE);
    const receipt = await response.json();
    if (receipt?.ok === false && typeof receipt.error === 'string' && receipt.error.trim()) {
      throw new UploadError(receipt.error.slice(0, 240));
    }
    if (receipt?.ok !== true || receipt.uploadId !== uploadId) throw new UploadError(UNCONFIRMED_MESSAGE);
    return receipt;
  };

  try {
    return await Promise.race([send(), timedOut]);
  } catch (error) {
    if (error instanceof UploadError) throw error;
    throw new UploadError(UNCONFIRMED_MESSAGE);
  } finally {
    clearTimeout(timer);
  }
}
