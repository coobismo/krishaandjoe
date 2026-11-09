import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { uploadPhoto } from '../../src/features/photos/uploadPhoto.mjs';
import { createUploadServer } from '../src/http-server.mjs';
import { createUploadService, UPLOAD_CHUNK_BYTES } from '../src/upload-service.mjs';

const folderId = 'integration-test-private-album';
const uploadCode = 'integration-test-guests';
const clientOptions = { provider: 'cloud-run', uploadCode, retryBaseMs: 0 };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// This substitutes storage boundaries only. The client transport, HTTP parser,
// authentication, resumable state machine, and final verification are real.
function repositoryInMemory() {
  const records = new Map();
  const queues = new Map();
  return {
    records,
    transaction(id, mutate) {
      const operation = (queues.get(id) || Promise.resolve()).catch(() => {}).then(() => {
        const result = mutate(structuredClone(records.get(id) || null));
        if (result.record !== undefined) records.set(id, structuredClone(result.record));
        return structuredClone(result.value);
      });
      queues.set(id, operation.catch(() => {}));
      return operation;
    },
  };
}

function driveSink({ truncateFinal = false, concurrentFiles = 0 } = {}) {
  const sessions = new Map();
  const files = new Map();
  const chunks = [];
  const verifiedReads = [];
  let enteredChunks = 0;
  let releaseConcurrent;
  const concurrentReady = new Promise((resolve) => { releaseConcurrent = resolve; });
  return {
    sessions, files, chunks, verifiedReads,
    async generateFileId() { return randomUUID(); },
    async createSession(metadata) {
      const url = `https://drive.invalid/resumable/${randomUUID()}`;
      sessions.set(url, { ...metadata, uploadedBytes: 0, hash: createHash('sha256') });
      return url;
    },
    async getFile(fileId) {
      const stored = files.get(fileId);
      if (stored) verifiedReads.push(fileId);
      return stored ? structuredClone(stored.metadata) : null;
    },
    async querySession(url) {
      const session = sessions.get(url);
      return {
        status: session.uploadedBytes === session.size ? 'complete' : 'uploading',
        uploadedBytes: session.uploadedBytes,
      };
    },
    async putChunk(url, range, bytes) {
      const session = sessions.get(url);
      assert.equal(range.start, session.uploadedBytes, 'Drive must receive each range once at its authoritative offset');
      assert.equal(bytes.length, range.end - range.start + 1);
      enteredChunks += 1;
      if (concurrentFiles && enteredChunks <= concurrentFiles) {
        if (enteredChunks === concurrentFiles) releaseConcurrent();
        await concurrentReady;
      }
      chunks.push({ uploadId: session.uploadId, ...range, bytes: bytes.length });
      session.hash.update(bytes);
      session.uploadedBytes = range.end + 1;
      if (session.uploadedBytes !== session.size) return { status: 'uploading', uploadedBytes: session.uploadedBytes };
      files.set(session.fileId, {
        hash: session.hash.digest('hex'),
        metadata: {
          id: session.fileId, size: String(session.size - (truncateFinal ? 1 : 0)),
          mimeType: session.mimeType, parents: [session.folderId],
          appProperties: { uploadId: session.uploadId }, trashed: false,
        },
      });
      return { status: 'complete', uploadedBytes: session.uploadedBytes };
    },
  };
}

async function start(t, { dropFinalFor, ...driveOptions } = {}) {
  const repository = repositoryInMemory();
  const drive = driveSink(driveOptions);
  const service = createUploadService({
    repository, drive, folderId, uploadCode,
    tokenSecret: 'integration-test-session-secret-at-least-32-characters',
  });
  const server = createUploadServer({
    service, allowedOrigins: ['https://krisha-and-joe.example'], logger: { error() {} },
  });
  const requests = [];
  let dropped = false;
  server.prependListener('request', (request, response) => {
    requests.push({
      method: request.method, path: request.url,
      contentType: request.headers['content-type'], range: request.headers['content-range'],
      hasCode: request.headers['x-upload-code'] === uploadCode,
      hasToken: typeof request.headers['x-upload-token'] === 'string',
    });
    if (!dropFinalFor || request.method !== 'PUT' || request.url !== `/v1/uploads/${dropFinalFor}`) return;
    const originalEnd = response.end;
    response.end = function end(body, ...args) {
      const receipt = JSON.parse(String(body));
      if (!dropped && receipt.status === 'complete') {
        dropped = true;
        // The real service has persisted completion, but no receipt reaches
        // the client. This models a connection loss after a final Drive write.
        response.destroy();
        return response;
      }
      return originalEnd.call(this, body, ...args);
    };
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closing = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closing;
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    drive, repository, requests, wasDropped: () => dropped,
  };
}

test('real client and HTTP service preserve a multi-chunk video and verify its Drive destination', { timeout: 10_000 }, async (t) => {
  const { url, drive, repository, requests } = await start(t);
  const bytes = Buffer.alloc(UPLOAD_CHUNK_BYTES + 97, 0x6d);
  bytes.fill(0xa3, UPLOAD_CHUNK_BYTES);
  const file = new File([bytes], 'first-dance.mov', { type: 'video/quicktime' });
  const uploadId = randomUUID();
  const progress = [];

  const result = await uploadPhoto(url, { file, uploadId, guestName: 'A wedding guest' }, {
    ...clientOptions, onProgress: (value) => progress.push(value.uploadedBytes),
  });

  assert.deepEqual(result, { ok: true, uploadId });
  assert.deepEqual(requests.map((request) => request.method), ['POST', 'PUT', 'PUT']);
  assert.equal(requests[0].hasCode, true);
  assert.equal(requests[0].hasToken, false);
  assert.ok(requests.slice(1).every((request) => request.hasToken && !request.hasCode));
  assert.deepEqual(requests.slice(1).map((request) => request.range), [
    `bytes 0-${UPLOAD_CHUNK_BYTES - 1}/${file.size}`,
    `bytes ${UPLOAD_CHUNK_BYTES}-${file.size - 1}/${file.size}`,
  ]);
  assert.ok(requests.slice(1).every((request) => request.contentType === 'application/octet-stream'));
  assert.deepEqual(progress, [0, UPLOAD_CHUNK_BYTES, file.size]);
  assert.deepEqual(drive.chunks.map((chunk) => chunk.bytes), [UPLOAD_CHUNK_BYTES, 97]);
  assert.equal(drive.files.size, 1);
  const completed = [...drive.files.values()][0];
  assert.equal(completed.hash, sha256(bytes));
  assert.deepEqual(completed.metadata.parents, [folderId]);
  assert.equal(completed.metadata.appProperties.uploadId, uploadId);
  assert.equal(drive.verifiedReads.length, 1);
  assert.equal(repository.records.get(uploadId).status, 'complete');
});

test('distinct real HTTP uploads can reach Drive concurrently without mixing their bytes', { timeout: 10_000 }, async (t) => {
  const { url, drive, repository } = await start(t, { concurrentFiles: 2 });
  const inputs = [Buffer.from('ceremony memories'), Buffer.from('reception moments')];
  const uploads = inputs.map((bytes, index) => ({
    file: new File([bytes], `memory-${index}.jpg`, { type: 'image/jpeg' }),
    uploadId: randomUUID(), guestName: `Guest ${index}`,
  }));

  const results = await Promise.all(uploads.map((entry) => uploadPhoto(url, entry, clientOptions)));

  assert.deepEqual(results, uploads.map(({ uploadId }) => ({ ok: true, uploadId })));
  assert.equal(drive.sessions.size, 2);
  assert.equal(drive.files.size, 2);
  assert.equal(repository.records.size, 2);
  assert.deepEqual([...drive.files.values()].map((entry) => entry.hash).sort(), inputs.map(sha256).sort());
  assert.ok(uploads.every((entry) => repository.records.get(entry.uploadId).status === 'complete'));
});

test('a genuinely lost final HTTP receipt recovers through status without retransmitting or duplicating', { timeout: 10_000 }, async (t) => {
  const uploadId = randomUUID();
  const { url, drive, requests, wasDropped } = await start(t, { dropFinalFor: uploadId });
  const bytes = Buffer.alloc(UPLOAD_CHUNK_BYTES + 13, 0x4f);
  const file = new File([bytes], 'celebration.mp4', { type: 'video/mp4' });

  const result = await uploadPhoto(url, { file, uploadId }, clientOptions);

  assert.deepEqual(result, { ok: true, uploadId });
  assert.equal(wasDropped(), true);
  assert.deepEqual(requests.map((request) => request.method), ['POST', 'PUT', 'PUT', 'GET']);
  assert.equal(drive.chunks.length, 2);
  assert.equal(drive.sessions.size, 1);
  assert.equal(drive.files.size, 1);
  assert.equal([...drive.files.values()][0].hash, sha256(bytes));
});

test('the real client never reports success when Drive cannot verify the entire file', { timeout: 10_000 }, async (t) => {
  const { url, drive, repository, requests } = await start(t, { truncateFinal: true });
  const file = new File(['a photo with an unverified final byte'], 'guests.jpg', { type: 'image/jpeg' });
  const uploadId = randomUUID();
  const progress = [];

  await assert.rejects(uploadPhoto(url, { file, uploadId }, {
    ...clientOptions, maxRetries: 0, onProgress: (value) => progress.push(value.uploadedBytes),
  }), /could not confirm/);

  assert.deepEqual(requests.map((request) => request.method), ['POST', 'PUT', 'GET']);
  assert.equal(repository.records.get(uploadId).status, 'uploading');
  assert.equal(drive.chunks.length, 1);
  assert.ok(progress.every((uploadedBytes) => uploadedBytes < file.size));
});
