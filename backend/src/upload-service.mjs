import { createHash, randomUUID } from 'node:crypto';
import { ApiError, DriveError } from './errors.mjs';
import { createUploadAuth } from './auth.mjs';
import { safeDiagnostic } from './diagnostics.mjs';

export const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
const DRIVE_CHUNK_UNIT = 256 * 1024;
const SESSION_MS = 24 * 60 * 60 * 1000;
const LEASE_MS = 120 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif',
  'image/heic', 'image/heif', 'image/tiff', 'image/bmp',
  'video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v',
  'video/3gpp', 'video/3gpp2',
]);

function metadataFrom(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || typeof body.uploadId !== 'string' || !UUID.test(body.uploadId)
      || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 255
      || !ALLOWED_MIME_TYPES.has(body.mimeType)
      || !Number.isSafeInteger(body.size) || body.size <= 0 || body.size > MAX_UPLOAD_BYTES
      || (body.guestName !== undefined && (typeof body.guestName !== 'string' || body.guestName.length > 120))) {
    throw new ApiError(400, 'Choose a supported photo or video no larger than 500 MB.');
  }
  const metadata = {
    uploadId: body.uploadId.toLowerCase(),
    name: body.name,
    mimeType: body.mimeType,
    size: body.size,
    guestName: body.guestName || '',
  };
  return { ...metadata, metadataDigest: createHash('sha256').update(JSON.stringify(metadata)).digest('hex') };
}

function safeFileName(name) {
  return name.split(/[\\/]/).pop().replace(/[<>:"\\|?*\u0000-\u001f\u007f]/g, '_')
    .replace(/^\.+/, '').trim().slice(0, 200) || 'memory';
}

function unavailable(cause) {
  return new ApiError(503, 'We could not confirm this upload. Please try again.', {
    retryable: true, retryAfter: 2, diagnostics: safeDiagnostic(cause),
  });
}

export function createUploadService({ repository, drive, folderId, uploadCode, tokenSecret, now = () => new Date() }) {
  const auth = createUploadAuth({ uploadCode, tokenSecret });

  function checkExpiry(record) {
    if (record.expiresAt.getTime() <= now().getTime()) {
      throw new ApiError(410, 'This upload has expired. Please choose the file again.');
    }
  }

  function receipt(record, includeToken = false) {
    const result = {
      ok: true,
      uploadId: record.uploadId,
      status: record.status,
      uploadedBytes: record.uploadedBytes,
      chunkBytes: UPLOAD_CHUNK_BYTES,
    };
    if (includeToken) {
      result.token = auth.token(record);
      result.expiresAt = record.expiresAt.toISOString();
    }
    return result;
  }

  async function readAuthorized(uploadId, token) {
    if (typeof token !== 'string' || !token) throw new ApiError(401, 'An upload token is required.');
    if (typeof uploadId !== 'string' || !UUID.test(uploadId)) throw new ApiError(404, 'Upload not found.');
    const record = await repository.transaction(uploadId.toLowerCase(), (current) => ({ value: current }));
    if (!record) throw new ApiError(404, 'Upload not found.');
    if (!auth.checkToken(record, token)) throw new ApiError(401, 'The upload token is invalid.');
    checkExpiry(record);
    return record;
  }

  async function withLease(uploadId, work) {
    const owner = randomUUID();
    let record = await repository.transaction(uploadId, (current) => {
      if (!current) throw new ApiError(404, 'Upload not found.');
      checkExpiry(current);
      const timestamp = now();
      if (current.lease && current.lease.until.getTime() > timestamp.getTime()) {
        throw new ApiError(429, 'This file is already being processed. Please try again in a moment.', { retryable: true, retryAfter: 2 });
      }
      const updated = { ...current, updatedAt: timestamp, lease: { owner, until: new Date(timestamp.getTime() + LEASE_MS) } };
      return { record: updated, value: updated };
    });

    const lease = {
      get record() { return record; },
      async save(changes = {}) {
        record = await repository.transaction(uploadId, (current) => {
          if (!current || current.lease?.owner !== owner) {
            throw new ApiError(409, 'The upload state changed. Please check its status and try again.', { retryable: true });
          }
          checkExpiry(current);
          const timestamp = now();
          const updated = { ...current, ...changes, updatedAt: timestamp, lease: { owner, until: new Date(timestamp.getTime() + LEASE_MS) } };
          return { record: updated, value: updated };
        });
        return record;
      },
      async call(operation) {
        // Google auth + each HTTP operation are bounded to50 seconds total.
        // Fresh leases need no extra write for the normal one-chunk request.
        if (record.lease.until.getTime() - now().getTime() < 60000) await this.save();
        return operation();
      },
    };

    try {
      return await work(lease);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof DriveError && error.status === 429) {
        throw new ApiError(429, 'The album is busy. Please try again in a moment.', { retryable: true, retryAfter: 2 });
      }
      throw unavailable(error);
    } finally {
      // Release only our own lease; a crashed request is recovered by expiry.
      await repository.transaction(uploadId, (current) => {
        if (current?.lease?.owner !== owner) return { value: undefined };
        return { record: { ...current, lease: null, updatedAt: now() }, value: undefined };
      }).catch(() => {});
    }
  }

  function matchesFile(file, record) {
    return file && file.id === record.fileId && String(file.size) === String(record.size)
      && file.mimeType === record.mimeType
      && file.appProperties?.uploadId === record.uploadId && file.trashed !== true;
  }

  function metadataMismatch() {
    return unavailable({ diagnostics: { upstream: 'drive', operation: 'verify_file', reason: 'metadata_mismatch' } });
  }

  async function finish(lease, file) {
    if (!matchesFile(file, lease.record)) throw metadataMismatch();
    await lease.save({ status: 'complete', uploadedBytes: lease.record.size, sessionUrl: null });
    return lease.record;
  }

  async function fetchFile(lease) {
    return lease.call(() => drive.getFile(lease.record.fileId));
  }

  async function confirmComplete(lease) {
    const file = await fetchFile(lease);
    return finish(lease, file);
  }

  async function startSession(lease) {
    const record = lease.record;
    try {
      const sessionUrl = await lease.call(() => drive.createSession({
        fileId: record.fileId,
        uploadId: record.uploadId,
        name: safeFileName(record.name),
        mimeType: record.mimeType,
        size: record.size,
        folderId,
        guestName: record.guestName.replace(/[\u0000-\u001f\u007f]/g, '').trim(),
      }));
      await lease.save({ sessionUrl, uploadedBytes: 0 });
      return lease.record;
    } catch (error) {
      // A completed create can return a conflict after a lost response. The
      // pre-generated file ID always identifies the one intended destination.
      if (error instanceof DriveError && error.status === 409) return confirmComplete(lease);
      throw error;
    }
  }

  async function recoverExpiredSession(lease) {
    // An expired session can belong to a file whose final response was lost.
    // Verify that file before considering a new create with the same ID. A
    // file with mismatched content or identity must never be replaced or
    // treated as complete.
    const file = await fetchFile(lease);
    if (file) return finish(lease, file);
    await lease.save({ sessionUrl: null, uploadedBytes: 0 });
    return startSession(lease);
  }

  async function synchronize(lease) {
    if (lease.record.status === 'complete') return lease.record;
    if (!lease.record.fileId) {
      const fileId = await lease.call(() => drive.generateFileId());
      // Persist this ID before any create; even an abandoned Google session
      // can only ever create this same file after a retry or instance restart.
      await lease.save({ fileId });
    }
    if (!lease.record.sessionUrl) {
      const file = await fetchFile(lease);
      if (file) return finish(lease, file);
      return startSession(lease);
    }
    // For an active transfer the resumable session is authoritative. Metadata
    // may be incomplete before content is committed; only check final metadata
    // after the session reports completion or after it has expired.
    const progress = await lease.call(() => drive.querySession(lease.record.sessionUrl, lease.record.size));
    if (progress.status === 'complete') return confirmComplete(lease);
    if (progress.status === 'expired') return recoverExpiredSession(lease);
    if (progress.status !== 'uploading' || !Number.isSafeInteger(progress.uploadedBytes) || progress.uploadedBytes < 0
        || progress.uploadedBytes >= lease.record.size) throw unavailable();
    await lease.save({ uploadedBytes: progress.uploadedBytes });
    return lease.record;
  }

  return {
    async initialize(body, code) {
      if (!auth.checkCode(code)) throw new ApiError(401, 'The upload code is incorrect. Please reopen the wedding website.');
      const metadata = metadataFrom(body);
      const record = await repository.transaction(metadata.uploadId, (current) => {
        if (current) {
          checkExpiry(current);
          if (current.metadataDigest !== metadata.metadataDigest) {
            throw new ApiError(409, 'This upload ID belongs to a different file. Please select the file again.');
          }
          return { value: current };
        }
        const timestamp = now();
        const created = {
          ...metadata,
          createdAt: timestamp,
          updatedAt: timestamp,
          expiresAt: new Date(timestamp.getTime() + SESSION_MS),
          status: 'uploading', uploadedBytes: 0, fileId: null, sessionUrl: null, lease: null,
        };
        return { record: created, value: created };
      });
      if (record.status === 'complete') return receipt(record, true);
      return withLease(record.uploadId, async (lease) => receipt(await synchronize(lease), true));
    },

    async status(uploadId, token) {
      const record = await readAuthorized(uploadId, token);
      if (record.status === 'complete') return receipt(record);
      return withLease(record.uploadId, async (lease) => receipt(await synchronize(lease)));
    },

    async putChunk(uploadId, token, range, bytes) {
      const record = await readAuthorized(uploadId, token);
      if (!range || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
          || !Number.isSafeInteger(range.total) || range.total !== record.size
          || range.start < 0 || range.end < range.start || range.end >= record.size
          || !Buffer.isBuffer(bytes) || bytes.length !== range.end - range.start + 1
          || bytes.length > UPLOAD_CHUNK_BYTES || bytes.length === 0
          || (range.end + 1 !== record.size && bytes.length % DRIVE_CHUNK_UNIT !== 0)) {
        throw new ApiError(400, 'The upload chunk or its byte range is invalid.');
      }
      if (record.status === 'complete') return receipt(record);
      return withLease(record.uploadId, async (lease) => {
        // The stored offset is an acknowledged checkpoint. Status and retry
        // initialization probe Drive; the normal path sends each chunk once,
        // without additional metadata/status requests per chunk.
        if (!lease.record.sessionUrl || !lease.record.fileId) await synchronize(lease);
        if (lease.record.status === 'complete') return receipt(lease.record);
        if (range.start !== lease.record.uploadedBytes) {
          throw new ApiError(409, 'The file offset changed. Check the upload status before retrying.', { retryable: true });
        }
        const progress = await lease.call(() => drive.putChunk(lease.record.sessionUrl, range, bytes));
        if (progress.status === 'expired') {
          await recoverExpiredSession(lease);
          if (lease.record.status === 'complete') return receipt(lease.record);
          throw new ApiError(409, 'The Drive session restarted. Check the upload status before retrying.', { retryable: true });
        }
        if (progress.status === 'complete') return receipt(await confirmComplete(lease));
        if (!Number.isSafeInteger(progress.uploadedBytes) || progress.uploadedBytes < 0
            || progress.uploadedBytes >= lease.record.size) throw unavailable();
        await lease.save({ uploadedBytes: progress.uploadedBytes });
        return receipt(lease.record);
      });
    },
  };
}
