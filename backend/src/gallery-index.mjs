export const GALLERY_IMAGE_MIME_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif',
  'image/heic', 'image/heif', 'image/tiff', 'image/bmp',
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const dateValue = (value) => typeof value?.toDate === 'function' ? value.toDate() : value;

// A separate durable collection keeps album entries after resumable upload
// sessions expire. Copy only the fields needed to serve verified guest photos.
export function photoForCompletedUpload(upload) {
  if (!upload || upload.status !== 'complete' || typeof upload.uploadId !== 'string' || !UUID.test(upload.uploadId)
      || typeof upload.fileId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(upload.fileId)
      || !GALLERY_IMAGE_MIME_TYPES.has(upload.mimeType)
      || !Number.isSafeInteger(upload.size) || upload.size <= 0) return null;
  if (upload.name === 'uploader-connection-check.png' || /^load-test-[0-9a-f-]{36}\.bmp$/i.test(upload.name || '')) return null;
  const createdAt = dateValue(upload.completedAt ?? upload.createdAt);
  if (!(createdAt instanceof Date) || !Number.isFinite(createdAt.getTime())) return null;
  return {
    id: upload.uploadId.toLowerCase(),
    fileId: upload.fileId,
    mimeType: upload.mimeType,
    size: upload.size,
    createdAt,
  };
}
