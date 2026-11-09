// Deploy as a separate Apps Script Web App: execute as Me, access Anyone.
// Set the UPLOAD_FOLDER_ID Script Property to the private destination folder ID.
// Wedding destination: 1x_-4yfn1Ar9q1xXvcf0rFoVpGKEzTi_k
// This project must not share a doPost function with the RSVP project.
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_UPLOAD_BASE64_LENGTH = Math.ceil(MAX_UPLOAD_BYTES / 3) * 4;
const UPLOAD_MIME_TYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif',
  'image/heic', 'image/heif', 'image/tiff', 'image/bmp',
  'video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v',
  'video/3gpp', 'video/3gpp2',
];

class UploadError extends Error {}

function doPost(event) {
  let lock;
  let locked = false;

  try {
    const upload = readUpload(event);
    const folderId = PropertiesService.getScriptProperties().getProperty('UPLOAD_FOLDER_ID');
    if (!folderId || !/^[a-zA-Z0-9_-]+$/.test(folderId)) {
      throw new UploadError('Uploads are not configured yet. Please try again later.');
    }

    const bytes = Utilities.base64Decode(upload.data);
    if (!bytes.length || bytes.length > MAX_UPLOAD_BYTES) {
      throw new UploadError('Please choose a non-empty file no larger than 20 MB.');
    }

    const folder = DriveApp.getFolderById(folderId);
    const storedName = upload.uploadId + '_' + safeUploadName(upload.name);
    const blob = Utilities.newBlob(bytes, upload.mimeType, storedName);

    // Keep duplicate detection and the write together. A retry after a dropped
    // response uses the same uploadId and returns the existing file's result.
    lock = LockService.getScriptLock();
    locked = lock.tryLock(10000);
    if (!locked) {
      throw new UploadError('The album is busy. Please try this file again in a moment.');
    }

    const matches = folder.getFilesByName(storedName);
    let file;
    if (matches.hasNext()) {
      file = matches.next();
    } else {
      file = folder.createFile(blob);
      if (upload.guestName) file.setDescription('Shared by ' + upload.guestName);
    }

    if (!file || file.isTrashed() || file.getSize() !== bytes.length || file.getMimeType() !== upload.mimeType) {
      throw new UploadError('We could not confirm this upload. Please try this file again.');
    }

    // Do not expose file URLs, IDs, or a listing of other guests' uploads.
    return uploadJson({ ok: true, uploadId: upload.uploadId });
  } catch (error) {
    return uploadJson({
      ok: false,
      error: error instanceof UploadError
        ? error.message
        : 'We could not confirm this upload. Please try this file again.',
    });
  } finally {
    if (locked) lock.releaseLock();
  }
}

function readUpload(event) {
  const contents = event && event.postData && event.postData.contents;
  if (typeof contents !== 'string' || contents.length > MAX_UPLOAD_BASE64_LENGTH + 4096) {
    throw new UploadError('Please choose a file no larger than 20 MB.');
  }

  let upload;
  try {
    upload = JSON.parse(contents);
  } catch (error) {
    throw new UploadError('This upload request is invalid. Please select your file again.');
  }

  if (!upload || typeof upload !== 'object' || Array.isArray(upload)
      || typeof upload.uploadId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(upload.uploadId)
      || typeof upload.name !== 'string' || !upload.name.trim() || upload.name.length > 255
      || typeof upload.mimeType !== 'string' || UPLOAD_MIME_TYPES.indexOf(upload.mimeType) === -1
      || (upload.guestName !== undefined && (typeof upload.guestName !== 'string' || upload.guestName.length > 120))) {
    throw new UploadError('Please choose a supported photo or video and try again.');
  }

  if (typeof upload.data !== 'string' || !upload.data.length
      || upload.data.length > MAX_UPLOAD_BASE64_LENGTH
      || upload.data.length % 4 !== 0
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(upload.data)) {
    throw new UploadError('The file data is invalid or too large. Please select your file again.');
  }

  const padding = upload.data.endsWith('==') ? 2 : upload.data.endsWith('=') ? 1 : 0;
  if (upload.data.length / 4 * 3 - padding > MAX_UPLOAD_BYTES) {
    throw new UploadError('Please choose a file no larger than 20 MB.');
  }

  return {
    uploadId: upload.uploadId.toLowerCase(),
    name: upload.name,
    mimeType: upload.mimeType,
    data: upload.data,
    guestName: (upload.guestName || '').replace(/[\u0000-\u001f\u007f]/g, '').trim(),
  };
}

function safeUploadName(name) {
  return name.split(/[\\/]/).pop()
    .replace(/[<>:"\\|?*\u0000-\u001f\u007f]/g, '_')
    .replace(/^\.+/, '')
    .trim().slice(0, 160) || 'memory';
}

function uploadJson(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
