import assert from 'node:assert/strict';
import test from 'node:test';
import { createUploadAuth } from '../src/auth.mjs';
import { loadConfig } from '../src/config.mjs';
import { createFirestoreRepository } from '../src/firestore-repository.mjs';

const environment = () => ({
  GOOGLE_CLOUD_PROJECT: 'wedding-project', DRIVE_FOLDER_ID: 'wedding-folder',
  GOOGLE_CLIENT_ID: 'client-id', GOOGLE_CLIENT_SECRET: 'client-secret', GOOGLE_REFRESH_TOKEN: 'refresh-token',
  UPLOAD_CODE: 'guest-code', UPLOAD_TOKEN_SECRET: 'a-test-only-secret-at-least-32-characters',
  ALLOWED_ORIGINS: 'https://wedding.example,http://localhost:5173',
});

test('configuration requires backend secrets and exact origins, with safe default ports/database', () => {
  const config = loadConfig(environment());
  assert.equal(config.port, 8080);
  assert.equal(config.databaseId, '(default)');
  assert.deepEqual(config.allowedOrigins, ['https://wedding.example', 'http://localhost:5173']);
  for (const changes of [
    { GOOGLE_REFRESH_TOKEN: '' }, { UPLOAD_TOKEN_SECRET: 'short' }, { DRIVE_FOLDER_ID: 'https://drive.google.com/folders/id' },
    { ALLOWED_ORIGINS: '*' }, { ALLOWED_ORIGINS: 'https://wedding.example/path' },
    { ALLOWED_ORIGINS: 'https://wedding.example/' }, { ALLOWED_ORIGINS: 'null' }, { PORT: '0' }, { PORT: 'NaN' },
  ]) assert.throws(() => loadConfig({ ...environment(), ...changes }));
});

test('guest-code checks and upload tokens are deterministic, metadata-bound, and secret-bound', () => {
  const options = { uploadCode: 'guest-code', tokenSecret: 'a-test-only-secret-at-least-32-characters' };
  const auth = createUploadAuth(options);
  assert.equal(auth.checkCode('guest-code'), true);
  for (const value of ['', undefined, 'wrong', 'x'.repeat(1025)]) assert.equal(auth.checkCode(value), false);
  const record = { uploadId: 'upload-id', metadataDigest: 'metadata-digest', expiresAt: new Date('2026-11-22T06:00:00Z') };
  const token = auth.token(record);
  assert.equal(token, createUploadAuth(options).token(record));
  assert.equal(auth.checkToken(record, token), true);
  for (const changed of [
    { ...record, uploadId: 'other' }, { ...record, metadataDigest: 'other' },
    { ...record, expiresAt: new Date(record.expiresAt.getTime() + 1) },
  ]) assert.equal(auth.checkToken(changed, token), false);
  assert.equal(createUploadAuth({ ...options, tokenSecret: 'a-different-secret-at-least-32-characters' }).checkToken(record, token), false);
  assert.equal(auth.checkToken(record, 'wrong'), false);
});

test('Firestore repository converts Timestamp reads and retains Date writes for TTL and lease expiry', async () => {
  const instant = new Date('2026-11-22T06:00:00Z');
  const timestamp = () => ({ toDate: () => new Date(instant) });
  let selectedCollection;
  let selectedId;
  let written;
  const ref = {};
  const firestore = {
    collection(name) { selectedCollection = name; return { doc(id) { selectedId = id; return ref; } }; },
    async runTransaction(callback) {
      return callback({
        async get(reference) {
          assert.equal(reference, ref);
          return { exists: true, data: () => ({ createdAt: timestamp(), updatedAt: timestamp(), expiresAt: timestamp(), lease: { owner: 'instance', until: timestamp() } }) };
        },
        set(reference, record) { assert.equal(reference, ref); written = record; },
      });
    },
  };
  const repository = createFirestoreRepository(firestore);
  const result = await repository.transaction('upload-id', (record) => {
    for (const key of ['createdAt', 'updatedAt', 'expiresAt']) assert.ok(record[key] instanceof Date);
    assert.ok(record.lease.until instanceof Date);
    return { record: { ...record, lease: null }, value: 'saved' };
  });
  assert.equal(result, 'saved');
  assert.equal(selectedCollection, 'weddingPhotoUploads');
  assert.equal(selectedId, 'upload-id');
  assert.ok(written.expiresAt instanceof Date);
  assert.equal(written.expiresAt.getTime(), instant.getTime());
  assert.equal(written.lease, null);
});

test('Firestore reads do not create or overwrite records when no record update is requested', async () => {
  let writes = 0;
  const repository = createFirestoreRepository({
    collection: () => ({ doc: () => ({}) }),
    runTransaction: (callback) => callback({
      get: async () => ({ exists: false }), set: () => { writes += 1; },
    }),
  });
  assert.equal(await repository.transaction('new-id', (record) => ({ value: record })), null);
  assert.equal(writes, 0);
});
