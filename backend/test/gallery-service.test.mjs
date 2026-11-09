import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ApiError } from '../src/errors.mjs';
import { createGalleryService, MAX_GALLERY_IMAGE_BYTES } from '../src/gallery-service.mjs';

const uploadCode = 'wedding-guests';
const tokenSecret = 'a-gallery-test-token-secret-at-least-32-characters';
const photo = (extra = {}) => ({ id: randomUUID(), fileId: `drive-${randomUUID()}`, mimeType: 'image/jpeg', size: 123, createdAt: new Date('2026-11-21T06:00:00Z'), ...extra });

function gallery(photos = [photo()], settings = {}) {
  const records = new Map(photos.map((item) => [item.id, item]));
  const calls = { seed: 0, list: [], get: [], metadata: [], image: [] };
  let instant = 0;
  const repository = {
    async seedCompletedUploads() { calls.seed += 1; },
    async list(options) { calls.list.push(options); return { photos: [...records.values()], nextCursor: 'next-page' }; },
    async get(id) { calls.get.push(id); return records.get(id) || null; },
  };
  const drive = {
    async getMetadata(fileId) {
      calls.metadata.push(fileId);
      const record = photos.find((item) => item.fileId === fileId);
      return record ? { id: fileId, mimeType: record.mimeType, size: String(record.size), appProperties: { uploadId: record.id }, thumbnailLink: 'private-provider-url' } : null;
    },
    async thumbnail(metadata, options) {
      calls.image.push({ id: metadata.id, ...options });
      return { bytes: Buffer.from('jpeg'), contentType: 'image/jpeg', url: 'a-private-link', token: 'not-for-the-client' };
    },
  };
  const service = createGalleryService({ repository, drive, uploadCode, tokenSecret, now: () => instant, ...settings });
  return { service, drive, repository, records, calls, photos, advance: (ms) => { instant += ms; } };
}

test('every album and image request authenticates before reads, cache access, or validation', async () => {
  const fixture = gallery();
  const id = fixture.photos[0].id;
  for (const code of [undefined, '', 'wrong']) {
    await assert.rejects(fixture.service.list({}, code), { status: 401 });
    await assert.rejects(fixture.service.image(id, {}, code), { status: 401 });
    await assert.rejects(fixture.service.image('arbitrary-drive-id', null, code), { status: 401 });
  }
  assert.equal(fixture.calls.seed, 0);
  await fixture.service.image(id, {}, uploadCode);
  await assert.rejects(fixture.service.image(id, {}, 'wrong'), { status: 401 });
  assert.equal(fixture.calls.image.length, 1);
  assert.equal(fixture.calls.metadata.length, 1);
});

test('public album metadata excludes Drive IDs, filenames, URLs, sizes, credentials and session fields', async () => {
  const shared = photo({ name: 'private-name.jpg', thumbnailLink: 'private-url', token: 'private-token', expiresAt: new Date() });
  const fixture = gallery([shared, photo({ mimeType: 'video/mp4' })]);
  const result = await fixture.service.list({ cursor: 'opaque-cursor' }, uploadCode);
  assert.deepEqual(result, {
    ok: true, photos: [{ id: shared.id, createdAt: shared.createdAt.toISOString(), mimeType: 'image/jpeg' }], nextCursor: 'next-page',
  });
  assert.deepEqual(fixture.calls.list, [{ cursor: 'opaque-cursor', limit: 18 }]);
  assert.doesNotMatch(JSON.stringify(result), /private|drive-|expiresAt|token|fileId/);
});

test('image lookup accepts upload UUIDs only and never exposes arbitrary Drive files', async () => {
  const fixture = gallery();
  for (const id of ['drive-file-id', 'https://drive.google.com/file/id', randomUUID()]) {
    await assert.rejects(fixture.service.image(id, {}, uploadCode), { status: 404 });
  }
  assert.equal(fixture.calls.metadata.length, 0);
  assert.equal(fixture.calls.image.length, 0);
  await assert.rejects(fixture.service.image(fixture.photos[0].id, { variant: 'original' }, uploadCode), { status: 400 });
});

test('the indexed ID, MIME, size and upload marker must match before serving; deleted photos return404', async () => {
  for (const change of [{ id: 'another-file' }, { size: '124' }, { mimeType: 'image/png' }, { appProperties: { uploadId: randomUUID() } }, { trashed: true }, null]) {
    const fixture = gallery();
    const base = await fixture.drive.getMetadata(fixture.photos[0].fileId);
    fixture.drive.getMetadata = async () => change === null ? null : { ...base, ...change };
    await assert.rejects(fixture.service.image(fixture.photos[0].id, {}, uploadCode), { status: change === null || change.trashed ? 404 : 503 });
    assert.equal(fixture.calls.image.length, 0);
  }
});

test('parent metadata is not consulted and returned provider URLs are discarded', async () => {
  const fixture = gallery();
  const original = fixture.drive.getMetadata;
  fixture.drive.getMetadata = async (id) => ({ ...await original(id), parents: ['another-folder'] });
  const result = await fixture.service.image(fixture.photos[0].id, {}, uploadCode);
  assert.deepEqual(Object.keys(result).sort(), ['bytes', 'contentType']);
  assert.equal(result.bytes.toString(), 'jpeg');
});

test('in-flight image requests deduplicate while unauthenticated requests cannot join', async () => {
  const fixture = gallery();
  let release;
  fixture.drive.thumbnail = () => new Promise((resolve) => { release = () => resolve({ bytes: Buffer.from('jpeg'), contentType: 'image/jpeg' }); });
  const first = fixture.service.image(fixture.photos[0].id, {}, uploadCode);
  const second = fixture.service.image(fixture.photos[0].id, {}, uploadCode);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(fixture.service.image(fixture.photos[0].id, {}, 'wrong'), { status: 401 });
  release();
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one.bytes, two.bytes);
  assert.equal(fixture.calls.metadata.length, 1);
});

test('thumbnail and preview caches are separate, bounded by LRU bytes, and expire', async () => {
  const fixture = gallery([photo(), photo(), photo()], { cacheBytes: 8, cacheTtlMs: 10 });
  const [a, b, c] = fixture.photos;
  await fixture.service.image(a.id, {}, uploadCode);
  await fixture.service.image(b.id, {}, uploadCode);
  await fixture.service.image(a.id, {}, uploadCode);
  await fixture.service.image(c.id, {}, uploadCode); // b is least recently used
  await fixture.service.image(b.id, {}, uploadCode);
  assert.equal(fixture.calls.image.length, 4);
  await fixture.service.image(b.id, { variant: 'preview' }, uploadCode);
  assert.equal(fixture.calls.image.at(-1).variant, 'preview');
  fixture.advance(11);
  await fixture.service.image(b.id, { variant: 'preview' }, uploadCode);
  assert.equal(fixture.calls.image.length, 6);
});

test('unready previews are retryable and failures are never cached', async () => {
  const fixture = gallery();
  const render = fixture.drive.thumbnail;
  fixture.drive.thumbnail = async () => { throw new ApiError(503, 'Preview is being prepared. Please try again in a moment.', { retryable: true }); };
  await assert.rejects(fixture.service.image(fixture.photos[0].id, {}, uploadCode), { status: 503, retryable: true });
  fixture.drive.thumbnail = render;
  assert.equal((await fixture.service.image(fixture.photos[0].id, {}, uploadCode)).contentType, 'image/jpeg');
  assert.equal(fixture.calls.metadata.length, 2);
});

test('invalid image types and excessive image bodies cannot enter the cache', async () => {
  for (const result of [
    { bytes: Buffer.from('svg'), contentType: 'image/svg+xml' },
    { bytes: Buffer.alloc(MAX_GALLERY_IMAGE_BYTES + 1), contentType: 'image/jpeg' },
    { bytes: Buffer.alloc(0), contentType: 'image/jpeg' },
  ]) {
    const fixture = gallery();
    fixture.drive.thumbnail = async () => result;
    await assert.rejects(fixture.service.image(fixture.photos[0].id, {}, uploadCode), { status: 503 });
  }
});

test('unexpected provider failures never expose their URL, credentials or raw message', async () => {
  const fixture = gallery();
  fixture.drive.thumbnail = async () => { throw new Error('Bearer SECRET https://private.example/ephemeral'); };
  await assert.rejects(fixture.service.image(fixture.photos[0].id, {}, uploadCode), (error) => {
    assert.equal(error.status, 503);
    assert.doesNotMatch(error.message, /SECRET|private\.example|Bearer/);
    return true;
  });
});
