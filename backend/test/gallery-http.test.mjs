import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createUploadServer } from '../src/http-server.mjs';
import { createGalleryService } from '../src/gallery-service.mjs';

const id = 'af8d3c2a-7891-4b21-9c54-bd1e4eb6a7e0';
const code = 'test-gallery-code';
const origin = 'https://wedding.example';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCk8AAAAASUVORK5CYII=', 'base64');

async function start(t) {
  const photo = { id, fileId: 'private-drive-file', mimeType: 'image/png', size: png.length, createdAt: new Date('2026-11-21T08:00:00Z') };
  let reads = 0;
  let deleted = false;
  const gallery = createGalleryService({
    uploadCode: code, tokenSecret: 'a-test-only-secret-with-at-least-32-characters',
    repository: {
      async seedCompletedUploads() {},
      async list() { reads += 1; return { photos: [photo], nextCursor: null }; },
      async get(key) { reads += 1; return key === id ? photo : null; },
    },
    drive: {
      async getMetadata() { return deleted ? null : { id: photo.fileId, mimeType: photo.mimeType, size: String(photo.size), appProperties: { uploadId: id } }; },
      async thumbnail() { return { bytes: png, contentType: 'image/png' }; },
    },
  });
  const server = createUploadServer({ service: {}, gallery, allowedOrigins: [origin] });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });
  return { base: `http://127.0.0.1:${server.address().port}`, reads: () => reads, setDeleted: (value) => { deleted = value; } };
}

test('gallery HTTP list requires the guest code and exposes only safe photo metadata', async (t) => {
  const { base, reads } = await start(t);
  const denied = await fetch(`${base}/v1/gallery`);
  assert.equal(denied.status, 401);
  assert.equal(reads(), 0);
  const response = await fetch(`${base}/v1/gallery`, { headers: { Origin: origin, 'X-Upload-Code': code } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  const result = await response.json();
  assert.deepEqual(result, { ok: true, photos: [{ id, createdAt: '2026-11-21T08:00:00.000Z', mimeType: 'image/png' }], nextCursor: null });
  assert.equal(JSON.stringify(result).includes('private-drive-file'), false);
});

test('gallery images use authenticated binary responses with private caching and safe content types', async (t) => {
  const { base } = await start(t);
  const path = `${base}/v1/gallery/${id}/image?variant=preview`;
  assert.equal((await fetch(path)).status, 401);
  const response = await fetch(path, { headers: { Origin: origin, 'X-Upload-Code': code } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('content-disposition'), 'inline');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.match(response.headers.get('vary'), /X-Upload-Code/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
});

test('Drive deletion removes a listed photo and blocks its cached image until restored', async (t) => {
  const { base, setDeleted } = await start(t);
  const headers = { Origin: origin, 'X-Upload-Code': code };
  const imageUrl = `${base}/v1/gallery/${id}/image`;
  assert.equal((await fetch(imageUrl, { headers })).status, 200);
  setDeleted(true);
  const list = await fetch(`${base}/v1/gallery`, { headers });
  assert.deepEqual(await list.json(), { ok: true, photos: [], nextCursor: null });
  const missing = await fetch(imageUrl, { headers });
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('cache-control'), 'private, no-store');
  setDeleted(false);
  const restored = await fetch(`${base}/v1/gallery`, { headers });
  assert.equal((await restored.json()).photos[0].id, id);
  assert.equal((await fetch(imageUrl, { headers })).status, 200);
});

test('gallery rejects malformed queries, unknown photo IDs, and unsupported methods', async (t) => {
  const { base } = await start(t);
  const headers = { 'X-Upload-Code': code };
  for (const path of ['/v1/gallery?folderId=private', '/v1/gallery?cursor=a&cursor=b', `/v1/gallery/${id}/image?variant=thumbnail&variant=preview`]) {
    assert.equal((await fetch(base + path, { headers })).status, 400);
  }
  assert.equal((await fetch(`${base}/v1/gallery/private-drive-file/image`, { headers })).status, 404);
  assert.equal((await fetch(`${base}/v1/gallery`, { method: 'POST', headers })).status, 405);
});

test('browser preflight permits the code header for gallery images without exposing image bytes', async (t) => {
  const { base, reads } = await start(t);
  const response = await fetch(`${base}/v1/gallery/${id}/image`, { method: 'OPTIONS', headers: {
    Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'x-upload-code',
  } });
  assert.equal(response.status, 204);
  assert.match(response.headers.get('access-control-allow-headers'), /X-Upload-Code/);
  assert.equal(reads(), 0);
});
