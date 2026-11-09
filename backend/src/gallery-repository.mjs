import { FieldPath } from '@google-cloud/firestore';
import { ApiError } from './errors.mjs';
import { GALLERY_IMAGE_MIME_TYPES, photoForCompletedUpload } from './gallery-index.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FILE_ID = /^[A-Za-z0-9_-]{1,256}$/;
const MAX_FILE_BYTES = 500 * 1024 * 1024;
const SEED_PAGE_SIZE = 200;
const SEED_MAX_UPLOADS = 5000;
const SEED_CONCURRENCY = 10;

function asDate(value) {
  try {
    const date = value instanceof Date ? value : value?.toDate?.();
    return date instanceof Date && Number.isFinite(date.getTime()) ? new Date(date) : null;
  } catch {
    return null;
  }
}

function validMetadata(data) {
  return data && typeof data.fileId === 'string' && FILE_ID.test(data.fileId)
    && GALLERY_IMAGE_MIME_TYPES.has(data.mimeType)
    && Number.isSafeInteger(data.size) && data.size > 0 && data.size <= MAX_FILE_BYTES;
}

function fromSnapshot(snapshot) {
  if (!snapshot?.exists) return null;
  const data = snapshot.data();
  const createdAt = asDate(data?.createdAt);
  if (!UUID.test(snapshot.id) || snapshot.id !== snapshot.id.toLowerCase()
      || data?.id !== snapshot.id || !createdAt || !validMetadata(data)) return null;
  return { id: snapshot.id, fileId: data.fileId, mimeType: data.mimeType, size: data.size, createdAt };
}

function cursorFor(id, createdAt) {
  return Buffer.from(JSON.stringify({ at: createdAt.toISOString(), id }), 'utf8').toString('base64url');
}

function readCursor(cursor) {
  if (cursor === undefined || cursor === null) return null;
  try {
    if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 512
        || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const bytes = Buffer.from(cursor, 'base64url');
    if (bytes.toString('base64url') !== cursor) throw new Error();
    const data = JSON.parse(bytes.toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)
        || Object.keys(data).length !== 2 || typeof data.at !== 'string'
        || typeof data.id !== 'string' || !UUID.test(data.id) || data.id !== data.id.toLowerCase()) throw new Error();
    const createdAt = new Date(data.at);
    if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== data.at
        || cursorFor(data.id, createdAt) !== cursor) throw new Error();
    return { id: data.id, createdAt };
  } catch {
    throw new ApiError(400, 'The gallery page cursor is invalid.');
  }
}

function seedRecord(snapshot) {
  const data = snapshot.data();
  if (!data || typeof data.uploadId !== 'string' || !UUID.test(snapshot.id)
      || data.uploadId.toLowerCase() !== snapshot.id.toLowerCase()
      || !validMetadata(data)) return null;
  try { return photoForCompletedUpload(data); }
  catch { return null; }
}

export function createGalleryRepository(firestore) {
  const gallery = firestore.collection('weddingPhotoGallery');
  const uploads = firestore.collection('weddingPhotoUploads');
  let seedPromise;

  async function createIfMissing(record) {
    const ref = gallery.doc(record.id);
    return firestore.runTransaction(async (transaction) => {
      const existing = await transaction.get(ref);
      if (!existing.exists) transaction.create(ref, record);
    });
  }

  async function seed() {
    let scanned = 0;
    let after;
    while (scanned < SEED_MAX_UPLOADS) {
      const pageSize = Math.min(SEED_PAGE_SIZE, SEED_MAX_UPLOADS - scanned);
      let query = uploads.where('status', '==', 'complete')
        .orderBy(FieldPath.documentId(), 'asc')
        .select('uploadId', 'fileId', 'mimeType', 'size', 'createdAt', 'completedAt', 'status', 'name')
        .limit(pageSize);
      if (after) query = query.startAfter(after);
      const page = await query.get();
      if (!page.docs.length) break;
      scanned += page.docs.length;
      const records = page.docs.map(seedRecord).filter(Boolean);
      // Bound both query pages and write concurrency during legacy backfill.
      for (let offset = 0; offset < records.length; offset += SEED_CONCURRENCY) {
        await Promise.all(records.slice(offset, offset + SEED_CONCURRENCY).map(createIfMissing));
      }
      after = page.docs.at(-1).id;
      if (page.docs.length < pageSize) break;
    }
  }

  function ensureSeed() {
    if (!seedPromise) {
      seedPromise = seed().catch((error) => {
        seedPromise = undefined;
        throw error;
      });
    }
    return seedPromise;
  }

  return {
    async list({ cursor, limit = 18 } = {}) {
      const after = readCursor(cursor);
      if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new ApiError(400, 'The gallery page size is invalid.');
      }
      const pageSize = Math.min(limit, 36);
      await ensureSeed();
      let query = gallery.orderBy('createdAt', 'desc').orderBy(FieldPath.documentId(), 'desc').limit(pageSize + 1);
      if (after) query = query.startAfter(after.createdAt, after.id);
      const page = await query.get();
      const rows = page.docs.slice(0, pageSize);
      const photos = rows.map(fromSnapshot).filter(Boolean);
      let nextCursor = null;
      if (page.docs.length > pageSize) {
        const last = rows.at(-1);
        const createdAt = asDate(last.data()?.createdAt);
        if (!createdAt || !UUID.test(last.id) || last.id !== last.id.toLowerCase()) {
          throw new ApiError(503, 'The gallery is temporarily unavailable. Please try again.', { retryable: true, retryAfter: 2 });
        }
        nextCursor = cursorFor(last.id, createdAt);
      }
      return { photos, nextCursor };
    },

    async get(id) {
      if (typeof id !== 'string' || !UUID.test(id)) throw new ApiError(404, 'Photo not found.');
      return fromSnapshot(await gallery.doc(id.toLowerCase()).get());
    },

    seedCompletedUploads() {
      return ensureSeed();
    },
  };
}
