import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createUploadService, UPLOAD_CHUNK_BYTES, MAX_UPLOAD_BYTES } from '../src/upload-service.mjs';
import { DriveError } from '../src/errors.mjs';

const folderId = 'wedding-folder';
const uploadCode = 'celebrate-with-us';
const tokenSecret = 'a-test-only-token-secret-at-least-32-characters';
const pause = () => new Promise((resolve) => setImmediate(resolve));
const metadata = (changes = {}) => ({
  uploadId: randomUUID(), name: 'celebration.jpg', mimeType: 'image/jpeg', size: 7, guestName: 'A guest', ...changes,
});

function memoryRepository() {
  const records = new Map();
  const queues = new Map();
  return {
    records,
    async transaction(id, mutate) {
      const before = queues.get(id) || Promise.resolve();
      const result = before.catch(() => {}).then(() => {
        const outcome = mutate(records.has(id) ? structuredClone(records.get(id)) : null);
        if (outcome.record !== undefined) records.set(id, structuredClone(outcome.record));
        return structuredClone(outcome.value);
      });
      queues.set(id, result.catch(() => {}));
      return result;
    },
  };
}

function fakeDrive() {
  const files = new Map();
  const sessions = new Map();
  const calls = { generated: 0, creates: [], chunks: 0, gets: 0, queries: 0, active: 0, maxActive: 0 };
  const drive = {
    files, sessions, calls,
    async generateFileId() {
      calls.active += 1;
      calls.maxActive = Math.max(calls.maxActive, calls.active);
      const id = `file-${++calls.generated}`;
      await pause();
      calls.active -= 1;
      return id;
    },
    async getFile(id) {
      calls.gets += 1;
      return structuredClone(files.get(id) || null);
    },
    async createSession(input) {
      if (drive.beforeCreate) await drive.beforeCreate(input);
      calls.creates.push(input);
      const url = `https://www.googleapis.com/upload/drive/v3/files?upload_id=${randomUUID()}`;
      sessions.set(url, { ...input, uploadedBytes: 0 });
      if (drive.dropInitiation) { drive.dropInitiation = false; throw new DriveError(503); }
      return url;
    },
    async querySession(url) {
      calls.queries += 1;
      const session = sessions.get(url);
      if (!session || session.expired) return { status: 'expired', uploadedBytes: 0 };
      return { status: session.uploadedBytes === session.size ? 'complete' : 'uploading', uploadedBytes: session.uploadedBytes };
    },
    async putChunk(url, range) {
      calls.chunks += 1;
      if (drive.beforeChunk) await drive.beforeChunk();
      const session = sessions.get(url);
      if (!session || session.expired) return { status: 'expired', uploadedBytes: 0 };
      if (session.uploadedBytes !== range.start) return { status: 'uploading', uploadedBytes: session.uploadedBytes };
      session.uploadedBytes = range.end + 1;
      if (session.uploadedBytes === session.size) {
        files.set(session.fileId, {
          id: session.fileId, size: String(session.size), mimeType: session.mimeType,
          parents: [session.folderId], appProperties: { uploadId: session.uploadId },
          ...drive.finalOverride,
        });
        if (drive.dropFinal) { drive.dropFinal = false; throw new DriveError(503); }
        return { status: 'complete', uploadedBytes: session.size };
      }
      if (drive.dropChunk) { drive.dropChunk = false; throw new DriveError(503); }
      return { status: 'uploading', uploadedBytes: session.uploadedBytes };
    },
  };
  return drive;
}

function setup() {
  const repository = memoryRepository();
  const drive = fakeDrive();
  let clock = new Date('2026-11-21T06:00:00Z');
  const options = { repository, drive, folderId, uploadCode, tokenSecret, now: () => clock };
  const service = createUploadService(options);
  return { repository, drive, service, options, advance: (ms) => { clock = new Date(clock.getTime() + ms); } };
}

async function complete(service, body, token) {
  let result;
  for (let start = 0; start < body.size; start += UPLOAD_CHUNK_BYTES) {
    const end = Math.min(body.size, start + UPLOAD_CHUNK_BYTES) - 1;
    result = await service.putChunk(body.uploadId, token, { start, end, total: body.size }, Buffer.alloc(end - start + 1));
  }
  return result;
}

test('persists pre-generated ID before create; confirms only the intended completed Drive file', async () => {
  const { service, drive, repository } = setup();
  const body = metadata();
  drive.beforeCreate = (input) => {
    assert.equal(repository.records.get(body.uploadId).fileId, input.fileId);
    assert.equal(input.uploadId, body.uploadId);
    assert.equal(input.folderId, folderId);
  };
  const init = await service.initialize(body, uploadCode);
  assert.equal(init.status, 'uploading');
  assert.equal(init.uploadedBytes, 0);
  assert.equal(init.chunkBytes, UPLOAD_CHUNK_BYTES);
  assert.equal(typeof init.token, 'string');
  assert.ok(repository.records.get(body.uploadId).expiresAt instanceof Date);
  const result = await complete(service, body, init.token);
  assert.equal(result.status, 'complete');
  assert.equal(result.uploadedBytes, body.size);
  assert.equal(drive.files.size, 1);
  assert.equal(repository.records.get(body.uploadId).lease, null);
  assert.equal(Object.hasOwn(result, 'token'), false);
});

test('identical initialization, final retry and new service instance never create duplicate files', async () => {
  const { service, drive, options } = setup();
  const body = metadata();
  const init = await service.initialize(body, uploadCode);
  const retry = await service.initialize(body, uploadCode);
  assert.equal(retry.token, init.token);
  assert.equal(drive.calls.generated, 1);
  assert.equal(drive.calls.creates.length, 1);
  await complete(service, body, init.token);
  const restarted = createUploadService(options);
  assert.equal((await complete(restarted, body, init.token)).status, 'complete');
  assert.equal((await restarted.initialize(body, uploadCode)).token, init.token);
  assert.equal(drive.calls.chunks, 1);
  assert.equal(drive.calls.creates.length, 1);
});

test('100 distinct uploads initialize and complete concurrently without a global lock (mocked providers)', async () => {
  const { service, drive, repository } = setup();
  const bodies = Array.from({ length: 100 }, () => metadata());
  const initialized = await Promise.all(bodies.map((body) => service.initialize(body, uploadCode)));
  const completed = await Promise.all(bodies.map((body, index) => complete(service, body, initialized[index].token)));
  assert.equal(completed.filter((result) => result.status === 'complete').length, 100);
  assert.equal(drive.files.size, 100);
  assert.equal(new Set(drive.calls.creates.map((entry) => entry.fileId)).size, 100);
  assert.ok(drive.calls.maxActive >= 50, `Expected overlapping independent work, observed ${drive.calls.maxActive}`);
  assert.equal(repository.records.size, 100);
});

test('one upload lease rejects simultaneous status/chunk operations and releases after completion', async () => {
  const { service, drive } = setup();
  const body = metadata();
  const { token } = await service.initialize(body, uploadCode);
  let release;
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  drive.beforeChunk = async () => { entered(); await blocked; };
  const first = complete(service, body, token);
  await ready;
  await assert.rejects(service.status(body.uploadId, token), { status: 429, retryable: true });
  await assert.rejects(complete(service, body, token), { status: 429, retryable: true });
  release();
  assert.equal((await first).status, 'complete');
  assert.equal((await service.status(body.uploadId, token)).status, 'complete');
});

test('expired resumable session resets to zero using the same persisted file ID', async () => {
  const { service, drive, repository } = setup();
  const body = metadata({ size: UPLOAD_CHUNK_BYTES + 1 });
  const { token } = await service.initialize(body, uploadCode);
  await service.putChunk(body.uploadId, token, { start: 0, end: UPLOAD_CHUNK_BYTES - 1, total: body.size }, Buffer.alloc(UPLOAD_CHUNK_BYTES));
  const first = repository.records.get(body.uploadId);
  drive.sessions.get(first.sessionUrl).expired = true;
  const status = await service.status(body.uploadId, token);
  const restarted = repository.records.get(body.uploadId);
  assert.equal(status.uploadedBytes, 0);
  assert.equal(restarted.fileId, first.fileId);
  assert.notEqual(restarted.sessionUrl, first.sessionUrl);
  assert.equal(drive.calls.generated, 1);
  assert.equal((await complete(service, body, token)).status, 'complete');
  assert.equal(drive.files.size, 1);
});

test('session expiry during a chunk returns retryable409; status reveals reset offset', async () => {
  const { service, drive, repository } = setup();
  const body = metadata();
  const { token } = await service.initialize(body, uploadCode);
  drive.sessions.get(repository.records.get(body.uploadId).sessionUrl).expired = true;
  await assert.rejects(complete(service, body, token), { status: 409, retryable: true });
  assert.equal((await service.status(body.uploadId, token)).uploadedBytes, 0);
  assert.equal((await complete(service, body, token)).status, 'complete');
});

test('ambiguous initiation keeps the generated file ID durable before a retry', async () => {
  const { service, drive, repository } = setup();
  const body = metadata();
  drive.dropInitiation = true;
  await assert.rejects(service.initialize(body, uploadCode), { status: 503, retryable: true });
  const fileId = repository.records.get(body.uploadId).fileId;
  const { token } = await service.initialize(body, uploadCode);
  assert.ok(drive.calls.creates.every((entry) => entry.fileId === fileId));
  assert.equal(drive.calls.generated, 1);
  await complete(service, body, token);
  assert.equal(drive.files.size, 1);
});

test('status confirms a dropped final response without resending or duplicating the file', async () => {
  const { service, drive } = setup();
  const body = metadata();
  const { token } = await service.initialize(body, uploadCode);
  drive.dropFinal = true;
  await assert.rejects(complete(service, body, token), { status: 503, retryable: true });
  assert.equal((await service.status(body.uploadId, token)).status, 'complete');
  assert.equal(drive.calls.chunks, 1);
  assert.equal(drive.files.size, 1);
});

test('an active session resumes despite incomplete file metadata until Drive confirms content completion', async () => {
  const { service, drive, repository } = setup();
  const body = metadata();
  const { token } = await service.initialize(body, uploadCode);
  const record = repository.records.get(body.uploadId);
  drive.files.set(record.fileId, {
    id: record.fileId, size: '0', mimeType: body.mimeType,
    parents: [folderId], appProperties: { uploadId: body.uploadId },
  });
  const getsBeforeStatus = drive.calls.gets;
  const status = await service.status(body.uploadId, token);
  assert.equal(status.status, 'uploading');
  assert.equal(status.uploadedBytes, 0);
  assert.equal(drive.calls.gets, getsBeforeStatus);
  assert.equal(drive.calls.queries, 1);
  assert.equal((await complete(service, body, token)).status, 'complete');
});

test('matching metadata alone cannot complete an active resumable session that still reports308', async () => {
  const { service, drive, repository } = setup();
  const body = metadata();
  const { token } = await service.initialize(body, uploadCode);
  const record = repository.records.get(body.uploadId);
  drive.files.set(record.fileId, {
    id: record.fileId, size: String(body.size), mimeType: body.mimeType,
    parents: [folderId], appProperties: { uploadId: body.uploadId },
  });
  assert.equal((await service.status(body.uploadId, token)).status, 'uploading');
  assert.equal(repository.records.get(body.uploadId).status, 'uploading');
  assert.equal(drive.calls.chunks, 0);
});

test('an expired session recovers a matching completed file after a dropped final response', async () => {
  const { service, drive, repository } = setup();
  const body = metadata();
  const { token } = await service.initialize(body, uploadCode);
  const sessionUrl = repository.records.get(body.uploadId).sessionUrl;
  drive.dropFinal = true;
  await assert.rejects(complete(service, body, token), { status: 503 });
  drive.sessions.get(sessionUrl).expired = true;
  assert.equal((await service.status(body.uploadId, token)).status, 'complete');
  assert.equal(drive.calls.creates.length, 1);
  assert.equal(drive.calls.generated, 1);
  assert.equal(drive.files.size, 1);
});

test('an expired session never restarts over an existing mismatched file', async () => {
  for (const method of ['status', 'chunk']) {
    const { service, drive, repository } = setup();
    const body = metadata();
    const { token } = await service.initialize(body, uploadCode);
    const record = repository.records.get(body.uploadId);
    drive.sessions.get(record.sessionUrl).expired = true;
    const existingFile = {
      id: record.fileId, size: '0', mimeType: body.mimeType,
      parents: [folderId], appProperties: { uploadId: body.uploadId },
    };
    drive.files.set(record.fileId, existingFile);
    await assert.rejects(method === 'status' ? service.status(body.uploadId, token) : complete(service, body, token), { status: 503 });
    assert.equal(drive.calls.creates.length, 1);
    assert.equal(drive.calls.generated, 1);
    assert.equal(repository.records.get(body.uploadId).status, 'uploading');
    assert.deepEqual(drive.files.get(record.fileId), existingFile);
  }
});

test('status discovers accepted bytes after a dropped nonfinal response and stale chunks conflict', async () => {
  const { service, drive } = setup();
  const body = metadata({ size: UPLOAD_CHUNK_BYTES + 1 });
  const { token } = await service.initialize(body, uploadCode);
  const first = { start: 0, end: UPLOAD_CHUNK_BYTES - 1, total: body.size };
  drive.dropChunk = true;
  await assert.rejects(service.putChunk(body.uploadId, token, first, Buffer.alloc(UPLOAD_CHUNK_BYTES)), { status: 503 });
  assert.equal((await service.status(body.uploadId, token)).uploadedBytes, UPLOAD_CHUNK_BYTES);
  await assert.rejects(service.putChunk(body.uploadId, token, first, Buffer.alloc(UPLOAD_CHUNK_BYTES)), { status: 409, retryable: true });
  assert.equal(drive.calls.chunks, 1);
  const result = await service.putChunk(body.uploadId, token, { start: UPLOAD_CHUNK_BYTES, end: UPLOAD_CHUNK_BYTES, total: body.size }, Buffer.alloc(1));
  assert.equal(result.status, 'complete');
});

test('authoritative unaligned offsets can resume with a final chunk', async () => {
  const { service, drive, repository } = setup();
  const body = metadata({ size: 1000 });
  const { token } = await service.initialize(body, uploadCode);
  drive.sessions.get(repository.records.get(body.uploadId).sessionUrl).uploadedBytes = 17;
  assert.equal((await service.status(body.uploadId, token)).uploadedBytes, 17);
  assert.equal((await service.putChunk(body.uploadId, token, { start: 17, end: 999, total: 1000 }, Buffer.alloc(983))).status, 'complete');
});

test('normal PUT avoids extra Drive metadata and status probes until final verification', async () => {
  const { service, drive } = setup();
  const body = metadata({ size: UPLOAD_CHUNK_BYTES * 2 + 1 });
  const { token } = await service.initialize(body, uploadCode);
  const reads = { gets: drive.calls.gets, queries: drive.calls.queries };
  await service.putChunk(body.uploadId, token, { start: 0, end: UPLOAD_CHUNK_BYTES - 1, total: body.size }, Buffer.alloc(UPLOAD_CHUNK_BYTES));
  assert.equal(drive.calls.gets, reads.gets);
  assert.equal(drive.calls.queries, reads.queries);
});

test('each final metadata field must verify before a completed receipt', async () => {
  for (const finalOverride of [
    { id: 'wrong-id' }, { size: '8' }, { mimeType: 'video/mp4' },
    { appProperties: { uploadId: randomUUID() } }, { trashed: true },
  ]) {
    const { service, drive, repository } = setup();
    const body = metadata();
    const { token } = await service.initialize(body, uploadCode);
    drive.finalOverride = finalOverride;
    await assert.rejects(complete(service, body, token), { status: 503, retryable: true });
    assert.equal(repository.records.get(body.uploadId).status, 'uploading');
    await assert.rejects(service.status(body.uploadId, token), { status: 503 });
  }
});

test('absent or different parent metadata does not block completion or resend a committed file', async () => {
  for (const parents of [undefined, [], ['another-folder']]) {
    const { service, drive, repository } = setup();
    const body = metadata();
    drive.finalOverride = { parents };
    const { token } = await service.initialize(body, uploadCode);
    drive.dropFinal = true;
    await assert.rejects(complete(service, body, token), { status: 503 });
    assert.equal((await service.status(body.uploadId, token)).status, 'complete');
    assert.equal((await complete(service, body, token)).status, 'complete');
    assert.equal(drive.calls.chunks, 1);
    assert.equal(drive.calls.creates.length, 1);
    assert.equal(drive.calls.creates[0].folderId, folderId);
    assert.equal(repository.records.get(body.uploadId).targetFolderId, undefined);
    assert.equal(drive.files.size, 1);
  }
});

test('missing, wrong and cross-upload credentials cannot initialize, inspect or upload', async () => {
  const { service, drive } = setup();
  const body = metadata();
  for (const code of [undefined, '', 'wrong-code']) await assert.rejects(service.initialize(body, code), { status: 401 });
  assert.equal(drive.calls.generated, 0);
  const { token } = await service.initialize(body, uploadCode);
  for (const value of [undefined, '', 'incorrect-token']) await assert.rejects(service.status(body.uploadId, value), { status: 401 });
  const other = metadata();
  await service.initialize(other, uploadCode);
  await assert.rejects(service.status(other.uploadId, token), { status: 401 });
  await assert.rejects(complete(service, body, 'incorrect-token'), { status: 401 });
});

test('invalid metadata, mismatched retries and malformed ranges are rejected before a Drive write', async () => {
  const { service, drive } = setup();
  for (const change of [
    { uploadId: 'invalid' }, { name: '' }, { name: 'x'.repeat(256) },
    { size: 0 }, { size: MAX_UPLOAD_BYTES + 1 }, { size: 1.5 },
    { mimeType: 'image/svg+xml' }, { guestName: {} }, { guestName: 'x'.repeat(121) },
  ]) await assert.rejects(service.initialize(metadata(change), uploadCode), { status: 400 });
  assert.equal(drive.calls.generated, 0);
  const body = metadata({ size: UPLOAD_CHUNK_BYTES + 1 });
  const { token } = await service.initialize(body, uploadCode);
  for (const changes of [{ name: 'other.jpg' }, { size: body.size + 1 }, { guestName: 'Other guest' }]) {
    await assert.rejects(service.initialize({ ...body, ...changes }, uploadCode), { status: 409 });
  }
  for (const [range, bytes] of [
    [{ start: 0, end: 0, total: body.size }, Buffer.alloc(1)], // nonfinal misalignment
    [{ start: 0, end: 1, total: 1 }, Buffer.alloc(2)],
    [{ start: -1, end: 0, total: body.size }, Buffer.alloc(2)],
    [{ start: 0, end: UPLOAD_CHUNK_BYTES - 1, total: body.size }, Buffer.alloc(1)],
  ]) await assert.rejects(service.putChunk(body.uploadId, token, range, bytes), { status: 400 });
  assert.equal(drive.calls.chunks, 0);
});

test('24-hour application expiry rejects valid tokens and initialization before eventual TTL cleanup', async () => {
  const { service, advance, repository } = setup();
  const body = metadata();
  const { token } = await service.initialize(body, uploadCode);
  advance(24 * 60 * 60 * 1000);
  await assert.rejects(service.status(body.uploadId, token), { status: 410, retryable: false });
  await assert.rejects(service.initialize(body, uploadCode), { status: 410 });
  assert.ok(repository.records.has(body.uploadId));
});

test('an expired crashed-instance lease can be recovered by a new instance', async () => {
  const { service, options, repository, advance } = setup();
  const body = metadata();
  const { token } = await service.initialize(body, uploadCode);
  const record = repository.records.get(body.uploadId);
  repository.records.set(body.uploadId, { ...record, lease: { owner: 'crashed-instance', until: new Date(record.createdAt.getTime() + 120000) } });
  await assert.rejects(service.status(body.uploadId, token), { status: 429 });
  advance(120001);
  const restarted = createUploadService(options);
  assert.equal((await restarted.status(body.uploadId, token)).status, 'uploading');
  assert.equal((await complete(restarted, body, token)).status, 'complete');
});
