import { GALLERY_IMAGE_MIME_TYPES } from '../src/gallery-index.mjs';
import { safeDiagnostic } from '../src/diagnostics.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FILE_ID = /^[A-Za-z0-9_-]{1,256}$/;
const MAX_ROWS = 18;

export class GalleryDiagnosticFailure extends Error {}

export function driveFileIdFromInput(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new GalleryDiagnosticFailure('Provide a Drive file ID or an HTTPS Google Drive file link.');
  if (/^[A-Za-z0-9_-]{10,256}$/.test(value)) return value;
  let url;
  try { url = new URL(value); } catch { /* Report only the fixed guidance below. */ }
  if (url && url.origin === 'https://drive.google.com' && !url.username && !url.password && !url.hash) {
    const pathId = /^\/file\/d\/([A-Za-z0-9_-]{10,256})(?:\/(?:view|preview|edit))?\/?$/.exec(url.pathname)?.[1];
    const queryId = url.pathname === '/open' && url.searchParams.getAll('id').length === 1 ? url.searchParams.get('id') : null;
    const id = pathId || queryId;
    if (id && /^[A-Za-z0-9_-]{10,256}$/.test(id)) return id;
  }
  throw new GalleryDiagnosticFailure('Provide a Drive file ID or an HTTPS Google Drive file link.');
}

function serviceOrigin(value) {
  let url;
  try { url = new URL(value); } catch { /* Never include the supplied URL in an error. */ }
  if (!url || url.protocol !== 'https:' || !url.hostname.endsWith('.run.app')
      || url.username || url.password || url.port || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new GalleryDiagnosticFailure('The deployed service has no supported HTTPS Cloud Run URL.');
  }
  return url.origin;
}

async function requestJson(fetchImpl, url, options, timeoutMs) {
  let status = null;
  try {
    const response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
    status = response.status;
    const length = response.headers.get('content-length');
    if (length && Number(length) > 65536) {
      await response.body?.cancel().catch(() => {});
      return { status, body: null };
    }
    const reader = response.body?.getReader();
    if (!reader) return { status, body: null };
    const pieces = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 65536) { await reader.cancel().catch(() => {}); return { status, body: null }; }
      pieces.push(Buffer.from(value));
    }
    return { status, body: JSON.parse(Buffer.concat(pieces).toString('utf8')) };
  } catch { return { status, body: null }; }
}

function indexRecord(document, prefix) {
  const id = typeof document?.name === 'string' && document.name.startsWith(prefix) ? document.name.slice(prefix.length) : '';
  const fields = document?.fields || {};
  const record = {
    id, storedId: fields.id?.stringValue, fileId: fields.fileId?.stringValue,
    mimeType: fields.mimeType?.stringValue, size: Number(fields.size?.integerValue),
    createdAt: new Date(fields.createdAt?.timestampValue || ''),
  };
  record.valid = UUID.test(id) && id === id.toLowerCase() && record.storedId === id
    && typeof record.fileId === 'string' && FILE_ID.test(record.fileId)
    && GALLERY_IMAGE_MIME_TYPES.has(record.mimeType)
    && Number.isSafeInteger(record.size) && record.size > 0 && record.size <= 500 * 1024 * 1024
    && Number.isFinite(record.createdAt.getTime());
  return record;
}

function comparison(metadata, expected) {
  return {
    driveFound: Boolean(metadata),
    trashed: metadata ? metadata.trashed === true : null,
    idMatches: metadata && expected ? metadata.id === expected.fileId : null,
    sizeMatches: metadata && expected ? String(metadata.size) === String(expected.size) : null,
    mimeMatches: metadata && expected ? metadata.mimeType === expected.mimeType : null,
    uploadIdMatches: metadata && expected ? metadata.appProperties?.uploadId === expected.id : null,
  };
}

// Every returned field is projected explicitly. IDs, URLs, provider bodies and
// secrets are retained only in local variables and never enter the report.
export async function diagnoseGallery({
  serviceUrl, uploadCode, cloudToken, firestoreProject, databaseId = '(default)',
  drive, folderId, photoId, requestedFileId, fetchImpl = globalThis.fetch, timeoutMs = 25000,
}) {
  if (photoId !== undefined && (typeof photoId !== 'string' || !UUID.test(photoId))) {
    throw new GalleryDiagnosticFailure('The photo ID must be the upload UUID from the gallery.');
  }
  if (requestedFileId !== undefined && (typeof requestedFileId !== 'string' || !FILE_ID.test(requestedFileId))) {
    throw new GalleryDiagnosticFailure('The requested Drive file ID is invalid.');
  }
  if (folderId !== undefined && (typeof folderId !== 'string' || !FILE_ID.test(folderId))) {
    throw new GalleryDiagnosticFailure('The deployed gallery folder is not configured correctly.');
  }
  const origin = serviceOrigin(serviceUrl);
  const api = await requestJson(fetchImpl, `${origin}/v1/gallery`, { headers: { 'X-Upload-Code': uploadCode } }, timeoutMs);
  const apiPhotos = api.body?.photos;
  const apiValid = api.status === 200 && api.body?.ok === true && Array.isArray(apiPhotos) && apiPhotos.length <= 100
    && apiPhotos.every((photo) => typeof photo?.id === 'string' && UUID.test(photo.id))
    && new Set(apiPhotos.map((photo) => photo.id.toLowerCase())).size === apiPhotos.length;
  const listed = apiValid ? new Set(apiPhotos.map((photo) => photo.id.toLowerCase())) : null;
  const prefix = `projects/${firestoreProject}/databases/${databaseId}/documents/weddingPhotoGallery/`;
  const databaseUrl = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(firestoreProject)}/databases/${encodeURIComponent(databaseId)}/documents`;
  const index = photoId
    ? await requestJson(fetchImpl, `${databaseUrl}/weddingPhotoGallery/${photoId.toLowerCase()}`, { headers: { Authorization: `Bearer ${cloudToken}` } }, timeoutMs)
    : await requestJson(fetchImpl, `${databaseUrl}:runQuery`, {
      method: 'POST', headers: { Authorization: `Bearer ${cloudToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ structuredQuery: {
        select: { fields: ['id', 'fileId', 'mimeType', 'size', 'createdAt'].map((fieldPath) => ({ fieldPath })) },
        from: [{ collectionId: 'weddingPhotoGallery' }],
        orderBy: [
          { field: { fieldPath: 'createdAt' }, direction: 'DESCENDING' },
          { field: { fieldPath: '__name__' }, direction: 'DESCENDING' },
        ], limit: MAX_ROWS,
      } }),
    }, timeoutMs);
  const documents = photoId
    ? index.status === 200 && index.body?.name ? [index.body] : []
    : Array.isArray(index.body) ? index.body.map((row) => row?.document).filter(Boolean) : [];
  const indexValid = index.status === 200 && (photoId ? Boolean(index.body?.name) : Array.isArray(index.body)) && documents.length <= MAX_ROWS;
  const records = indexValid ? documents.map((document) => indexRecord(document, prefix)) : [];
  const galleryFolder = { configured: folderId !== undefined, checked: false };
  let folderFileIds = null;
  const validRecords = records.filter((record) => record.valid);
  if (folderId !== undefined && validRecords.length) {
    try {
      const ids = await drive.getFolderFileIds(folderId, validRecords.map((record) => record.id));
      if (!(ids instanceof Set)) throw new Error('Invalid folder membership response.');
      folderFileIds = ids;
      galleryFolder.checked = true;
    } catch (error) { galleryFolder.diagnostics = safeDiagnostic(error); }
  }
  const rows = [];
  for (const [offset, record] of records.entries()) {
    const row = {
      position: offset + 1, indexValid: record.valid, ...comparison(null),
      listedByApi: listed && UUID.test(record.id) ? listed.has(record.id) : null,
      presentInGalleryFolder: folderFileIds && record.valid ? folderFileIds.has(record.fileId) : null,
    };
    if (record.valid) {
      try { Object.assign(row, comparison(await drive.getMetadata(record.fileId), record)); }
      catch (error) { row.driveFound = null; row.diagnostics = safeDiagnostic(error); }
    } else row.driveFound = null;
    rows.push(row);
  }
  const report = {
    galleryApi: {
      httpStatus: api.status, responseValid: apiValid,
      photoCount: Array.isArray(apiPhotos) ? apiPhotos.length : null,
      hasNextPage: apiValid ? Boolean(api.body.nextCursor) : null,
    },
    galleryIndex: { httpStatus: index.status, responseValid: indexValid, recordCount: records.length },
    galleryFolder,
    photos: rows,
  };
  if (requestedFileId) {
    const matching = records.find((record) => record.valid && record.fileId === requestedFileId);
    const allListedIndexed = listed && [...listed].every((id) => records.some((record) => record.valid && record.id === id));
    const requested = {
      indexedInSample: Boolean(matching),
      listedByApi: listed && matching ? listed.has(matching.id) : allListedIndexed ? false : null,
      presentInGalleryFolder: folderFileIds && matching ? folderFileIds.has(requestedFileId) : null,
      ...comparison(null),
    };
    try {
      const metadata = await drive.getMetadata(requestedFileId);
      Object.assign(requested, comparison(metadata, matching));
      if (metadata) requested.idMatches = metadata.id === requestedFileId;
    } catch (error) { requested.driveFound = null; requested.diagnostics = safeDiagnostic(error); }
    report.requestedFile = requested;
  }
  return report;
}
