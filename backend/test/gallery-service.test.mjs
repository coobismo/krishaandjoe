import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ApiError, DriveError } from '../src/errors.mjs';
import { createGalleryService, MAX_GALLERY_IMAGE_BYTES } from '../src/gallery-service.mjs';

const uploadCode = 'wedding-guests';
const tokenSecret = 'a-gallery-test-token-secret-at-least-32-characters';
const folderId = 'wedding-test-folder';
const photo = (extra = {}) => ({ id: randomUUID(), fileId: `drive-${randomUUID()}`, mimeType: 'image/jpeg', size: 123, createdAt: new Date('2026-11-21T06:00:00Z'), ...extra });

function gallery(photos = [photo()], settings = {}) {
  const records = new Map(photos.map((item) => [item.id, item]));
  const calls = { seed: 0, list: [], get: [], folder: [], metadata: [], image: [] };
  let instant = 0;
  const repository = {
    async seedCompletedUploads() { calls.seed += 1; },
    async list(options) { calls.list.push(options); return { photos: [...records.values()], nextCursor: 'next-page' }; },
    async get(id) { calls.get.push(id); return records.get(id) || null; },
  };
  const drive = {
    async getFolderFileIds(folder, uploadIds) {
      calls.folder.push({ folder, uploadIds });
      return new Set(photos.filter((item) => uploadIds.includes(item.id)).map((item) => item.fileId));
    },
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
  const service = createGalleryService({ repository, drive, folderId, uploadCode, tokenSecret, now: () => instant, ...settings });
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
  assert.equal(fixture.calls.folder.length, 0);
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

test('public album credits use normalized optional names without exposing other upload fields', async () => {
  const shared = photo({ guestName: '  José\n Cruz\u0000  ', name: 'private-name.jpg', email: 'owner@example.test', sessionUrl: 'private-session' });
  const anonymous = photo({ guestName: { bad: 'invalid' } });
  const blank = photo({ guestName: '\t ' });
  const fixture = gallery([shared, anonymous, blank]);
  const { photos } = await fixture.service.list({}, uploadCode);
  assert.deepEqual(photos[0], { id: shared.id, createdAt: shared.createdAt.toISOString(), mimeType: shared.mimeType, guestName: 'José Cruz' });
  for (const result of photos.slice(1)) assert.equal('guestName' in result, false);
  assert.doesNotMatch(JSON.stringify(photos), /private|owner@example|fileId|sessionUrl|email/);
});

test('verified legacy photos recover uploader credits from only the exact description format', async () => {
  const credits = [
    { indexed: undefined, description: 'Shared by  Jo  Cruz ', expected: 'Jo Cruz' },
    { indexed: ' ', description: 'Shared by ' + 'J'.repeat(120), expected: 'J'.repeat(100) },
    { indexed: 'Original credit', description: 'Shared by Another name', expected: 'Original credit' },
    { indexed: undefined, description: 'Private notes about guests' },
    { indexed: undefined, description: 'Shared by Jo\nPrivate note' },
    { indexed: undefined, description: 'Shared by Jo\n' },
    { indexed: undefined, description: 'Shared by ' + 'J'.repeat(121) },
  ];
  const fixture = gallery(credits.map(({ indexed }) => photo({ guestName: indexed })));
  const original = fixture.drive.getMetadata;
  fixture.drive.getMetadata = async (id) => ({
    ...await original(id), description: credits[fixture.photos.findIndex((record) => record.fileId === id)].description,
  });
  const { photos } = await fixture.service.list({}, uploadCode);
  assert.deepEqual(photos.map((result) => result.guestName), credits.map(({ expected }) => expected));
  assert.equal(fixture.calls.metadata.length, credits.length, 'legacy fallback reuses the existing verification request');
  assert.doesNotMatch(JSON.stringify(photos), /Shared by|description|Private notes|Private note|fileId|thumbnailLink/);
  for (const result of photos.slice(3)) assert.equal('guestName' in result, false);
});

test('legacy descriptions are never read before upload metadata and current folder visibility are verified', async () => {
  for (const change of [{ id: 'other-file' }, { size: 124 }, { mimeType: 'image/png' }, { appProperties: {} }, { trashed: true }]) {
    const fixture = gallery();
    const base = await fixture.drive.getMetadata(fixture.photos[0].fileId);
    let descriptionsRead = 0;
    fixture.drive.getMetadata = async () => ({ ...base, ...change, get description() { descriptionsRead += 1; return 'Shared by Private'; } });
    if (change.trashed) assert.deepEqual((await fixture.service.list({}, uploadCode)).photos, []);
    else await assert.rejects(fixture.service.list({}, uploadCode), { status: 503 });
    assert.equal(descriptionsRead, 0);
  }
  const fixture = gallery();
  fixture.drive.getFolderFileIds = async () => new Set();
  assert.deepEqual((await fixture.service.list({}, uploadCode)).photos, []);
  assert.equal(fixture.calls.metadata.length, 0);
});

test('refresh excludes missing and trashed Drive photos, preserves pagination, and notices restores', async () => {
  const fixture = gallery([photo(), photo(), photo()]);
  const [visible, deleted, trashed] = fixture.photos;
  const original = fixture.drive.getMetadata;
  let restored = false;
  fixture.drive.getMetadata = async (id) => {
    const metadata = await original(id);
    if (restored || id === visible.fileId) return metadata;
    return id === deleted.fileId ? null : { ...metadata, trashed: true };
  };
  const result = await fixture.service.list({}, uploadCode);
  assert.deepEqual(result.photos.map((item) => item.id), [visible.id]);
  assert.equal(result.nextCursor, 'next-page');
  assert.equal(fixture.records.size, 3);
  assert.equal(fixture.calls.image.length, 0);
  restored = true;
  assert.deepEqual((await fixture.service.list({}, uploadCode)).photos.map((item) => item.id), fixture.photos.map((item) => item.id));
});

test('a page of deleted photos retains its continuation cursor for older memories', async () => {
  const fixture = gallery([photo(), photo()]);
  const [deleted, older] = fixture.photos;
  const original = fixture.drive.getMetadata;
  fixture.drive.getMetadata = async (id) => id === deleted.fileId ? null : original(id);
  fixture.repository.list = async ({ cursor }) => cursor === 'older-page'
    ? { photos: [older], nextCursor: null }
    : { photos: [deleted], nextCursor: 'older-page' };
  const first = await fixture.service.list({}, uploadCode);
  assert.deepEqual(first, { ok: true, photos: [], nextCursor: 'older-page' });
  const next = await fixture.service.list({ cursor: first.nextCursor }, uploadCode);
  assert.deepEqual(next.photos.map((item) => item.id), [older.id]);
  assert.equal(next.nextCursor, null);
});

test('removing an untrashed owner file from the album folder hides it and moving it back restores it', async () => {
  const fixture = gallery([photo(), photo()]);
  const [removed, remaining] = fixture.photos;
  let movedBack = false;
  fixture.drive.getFolderFileIds = async () => new Set(movedBack
    ? [removed.fileId, remaining.fileId] : [remaining.fileId]);
  const ownerFile = await fixture.drive.getMetadata(removed.fileId);
  assert.equal(ownerFile.id, removed.fileId);
  assert.notEqual(ownerFile.trashed, true);
  const result = await fixture.service.list({}, uploadCode);
  assert.deepEqual(result.photos.map((item) => item.id), [remaining.id]);
  assert.equal(result.nextCursor, 'next-page');
  assert.equal(fixture.records.size, 2);
  movedBack = true;
  assert.deepEqual((await fixture.service.list({}, uploadCode)).photos.map((item) => item.id), [removed.id, remaining.id]);
});

test('folder removal blocks both cached variants even while the owner can still read the original', async () => {
  const fixture = gallery();
  const id = fixture.photos[0].id;
  await fixture.service.image(id, {}, uploadCode);
  await fixture.service.image(id, { variant: 'preview' }, uploadCode);
  const original = fixture.drive.getFolderFileIds;
  fixture.drive.getFolderFileIds = async () => new Set();
  for (const variant of ['thumbnail', 'preview']) {
    await assert.rejects(fixture.service.image(id, { variant }, uploadCode), { status: 404 });
  }
  assert.equal(fixture.calls.image.length, 2);
  assert.equal((await fixture.service.list({}, uploadCode)).photos.length, 0);
  fixture.drive.getFolderFileIds = original;
  await fixture.service.image(id, {}, uploadCode);
  await fixture.service.image(id, { variant: 'preview' }, uploadCode);
  assert.equal(fixture.calls.image.length, 4);
});

test('failed or malformed folder queries are retryable errors instead of an empty album or missing image', async () => {
  for (const failure of ['error', 'invalid-response']) {
    const fixture = gallery();
    const id = fixture.photos[0].id;
    await fixture.service.image(id, {}, uploadCode);
    const original = fixture.drive.getFolderFileIds;
    fixture.drive.getFolderFileIds = async () => {
      if (failure === 'error') throw new DriveError(403, { operation: 'list_files', reason: 'insufficientPermissions' });
      return null;
    };
    await assert.rejects(fixture.service.list({}, uploadCode), { status: 503, retryable: true });
    await assert.rejects(fixture.service.image(id, {}, uploadCode), { status: 503, retryable: true });
    assert.equal(fixture.records.size, 1);
    fixture.drive.getFolderFileIds = original;
    assert.equal((await fixture.service.list({}, uploadCode)).photos.length, 1);
  }
});

test('Drive permission, rate-limit and transient failures are retryable, never treated as deletions', async () => {
  for (const status of [403, 429, 503]) {
    const fixture = gallery();
    const original = fixture.drive.getMetadata;
    fixture.drive.getMetadata = async () => { throw new DriveError(status, { operation: 'get_file', upstreamStatus: status }); };
    await assert.rejects(fixture.service.list({}, uploadCode), { status: 503, retryable: true });
    assert.equal(fixture.records.size, 1);
    fixture.drive.getMetadata = original;
    assert.equal((await fixture.service.list({}, uploadCode)).photos.length, 1);
  }
});

test('concurrent album refreshes share metadata checks and bound Drive request concurrency', { timeout: 2000 }, async () => {
  const fixture = gallery(Array.from({ length: 20 }, () => photo()));
  const original = fixture.drive.getMetadata;
  const releases = [];
  let active = 0;
  let peak = 0;
  fixture.drive.getMetadata = async (id) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => releases.push(resolve));
    active -= 1;
    return original(id);
  };
  const first = fixture.service.list({}, uploadCode);
  const second = fixture.service.list({}, uploadCode);
  for (let wave = 0; wave < 4; wave += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    for (const release of releases.splice(0)) release();
  }
  const pages = await Promise.all([first, second]);
  assert.equal(peak, 6);
  assert.equal(fixture.calls.folder.length, 1);
  assert.equal(fixture.calls.metadata.length, 20);
  for (const page of pages) assert.deepEqual(page.photos.map((item) => item.id), fixture.photos.map((item) => item.id));
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

test('file parent metadata is not consulted and returned provider URLs are discarded', async () => {
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

test('deleted or trashed files cannot be served from either image cache and restores fetch fresh bytes', async () => {
  for (const missing of [null, { trashed: true }]) {
    const fixture = gallery();
    const id = fixture.photos[0].id;
    await fixture.service.image(id, {}, uploadCode);
    await fixture.service.image(id, { variant: 'preview' }, uploadCode);
    const original = fixture.drive.getMetadata;
    fixture.drive.getMetadata = async (fileId) => missing === null ? null : { ...await original(fileId), ...missing };
    for (const variant of ['thumbnail', 'preview']) {
      await assert.rejects(fixture.service.image(id, { variant }, uploadCode), { status: 404 });
    }
    assert.equal(fixture.calls.image.length, 2);
    fixture.drive.getMetadata = original;
    await fixture.service.image(id, {}, uploadCode);
    await fixture.service.image(id, { variant: 'preview' }, uploadCode);
    assert.equal(fixture.calls.image.length, 4);
  }
});

test('an album refresh evicts both cached image variants for deleted photos', async () => {
  const fixture = gallery();
  const id = fixture.photos[0].id;
  await fixture.service.image(id, {}, uploadCode);
  await fixture.service.image(id, { variant: 'preview' }, uploadCode);
  const original = fixture.drive.getMetadata;
  fixture.drive.getMetadata = async () => null;
  assert.equal((await fixture.service.list({}, uploadCode)).photos.length, 0);
  fixture.drive.getMetadata = original;
  await fixture.service.image(id, {}, uploadCode);
  await fixture.service.image(id, { variant: 'preview' }, uploadCode);
  assert.equal(fixture.calls.image.length, 4);
});

test('cached images still require current metadata and transient failures never return a stale image', async () => {
  const fixture = gallery();
  const id = fixture.photos[0].id;
  await fixture.service.image(id, {}, uploadCode);
  const original = fixture.drive.getMetadata;
  fixture.drive.getMetadata = async () => { throw new DriveError(503, { operation: 'get_file' }); };
  await assert.rejects(fixture.service.image(id, {}, uploadCode), { status: 503, retryable: true });
  fixture.drive.getMetadata = async (fileId) => ({ ...await original(fileId), size: '124' });
  await assert.rejects(fixture.service.image(id, {}, uploadCode), { status: 503 });
  assert.equal(fixture.calls.image.length, 1);
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
