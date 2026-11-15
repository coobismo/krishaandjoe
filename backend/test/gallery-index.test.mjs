import assert from 'node:assert/strict';
import test from 'node:test';
import { photoForCompletedUpload } from '../src/gallery-index.mjs';
import { createFirestoreRepository } from '../src/firestore-repository.mjs';

const id = 'af8d3c2a-7891-4b21-9c54-bd1e4eb6a7e0';
const uploaded = () => ({
  uploadId: id, fileId: 'a-drive-file', name: 'guest-photo.jpg', mimeType: 'image/jpeg', size: 1024,
  status: 'complete', createdAt: new Date('2026-11-21T07:00:00Z'), completedAt: new Date('2026-11-21T07:01:00Z'),
  expiresAt: new Date('2026-11-22T07:00:00Z'), sessionUrl: 'private-session', guestName: 'Private guest',
});

test('gallery entry keeps image metadata and optional guest credit without upload TTL or session secrets', () => {
  const source = uploaded();
  const photo = photoForCompletedUpload(source);
  assert.deepEqual(photo, { id, fileId: source.fileId, mimeType: source.mimeType, size: source.size, createdAt: source.completedAt, guestName: 'Private guest' });
  assert.equal('expiresAt' in photo, false);
  assert.equal('name' in photo, false);
  assert.equal('sessionUrl' in photo, false);
});

test('gallery indexing normalizes a guest credit and leaves unnamed or malformed credits optional', () => {
  assert.equal(photoForCompletedUpload({ ...uploaded(), guestName: '  Jo\n and\t Krisha\u0000  ' }).guestName, 'Jo and Krisha');
  for (const guestName of [undefined, null, {}, 42, ' ', '\u0000\u200b', '\ud800']) {
    assert.equal('guestName' in photoForCompletedUpload({ ...uploaded(), guestName }), false);
  }
  const shortened = photoForCompletedUpload({ ...uploaded(), guestName: 'J'.repeat(99) + '📷' }).guestName;
  assert.equal(shortened, 'J'.repeat(99));
});

test('unconfirmed, invalid, empty and non-photo uploads are excluded', () => {
  for (const change of [
    { status: 'uploading' }, { size: 0 }, { uploadId: 'not-a-uuid' }, { fileId: '../file' },
    { mimeType: 'video/mp4' }, { mimeType: 'image/svg+xml' }, { completedAt: new Date('invalid') },
  ]) assert.equal(photoForCompletedUpload({ ...uploaded(), ...change }), null);
});

test('legacy complete images accept Firestore timestamps and the original creation date', () => {
  const source = uploaded();
  delete source.completedAt;
  const createdAt = source.createdAt;
  source.createdAt = { toDate: () => createdAt };
  assert.equal(photoForCompletedUpload(source).createdAt, createdAt);
});

test('the connection-check image stays out of the guest album', () => {
  assert.equal(photoForCompletedUpload({ ...uploaded(), name: 'uploader-connection-check.png' }), null);
});

test('confirmed load-test photos appear with the same metadata and guest credit as ordinary photos', () => {
  for (const [name, mimeType] of [
    [`load-test-${id}.bmp`, 'image/bmp'], [`load-test-${id}.jpg`, 'image/jpeg'],
    [`load-test-${id}.jpeg`, 'image/jpeg'], [`LOAD-TEST-${id.toUpperCase()}.JPG`, 'image/jpeg'],
    ['wedding-memory.jpg', 'image/jpeg'],
  ]) {
    const source = { ...uploaded(), name, mimeType, guestName: 'Upload capacity test' };
    assert.deepEqual(photoForCompletedUpload(source), {
      id, fileId: source.fileId, mimeType, size: source.size,
      createdAt: source.completedAt, guestName: 'Upload capacity test',
    });
    assert.equal(photoForCompletedUpload({ ...source, status: 'uploading' }), null);
  }
});

test('upload completion and its durable gallery entry are written in the same Firestore transaction', async () => {
  const writes = [];
  const firestore = {
    collection(collection) { return { doc(document) { return { collection, document }; } }; },
    async runTransaction(callback) {
      return callback({
        async get() { return { exists: false }; },
        set(ref, data) { writes.push({ ref, data }); },
      });
    },
  };
  const upload = uploaded();
  await createFirestoreRepository(firestore).transaction(id, () => ({ record: upload, value: 'complete' }));
  assert.deepEqual(writes.map(({ ref }) => ref.collection), ['weddingPhotoUploads', 'weddingPhotoGallery']);
  assert.equal(writes[1].ref.document, id);
  assert.equal(writes[1].data.createdAt, upload.completedAt);
  assert.equal(writes[1].data.guestName, 'Private guest');
  assert.equal('expiresAt' in writes[1].data, false);
});
