import assert from 'node:assert/strict';
import test from 'node:test';
import { createGalleryService } from '../src/gallery-service.mjs';
import { createUploadServer } from '../src/http-server.mjs';
import { fetchGalleryImage, getGallery, getGalleryPlayback } from '../../src/features/photos/galleryClient.mjs';

test('the website client lists a video, loads its poster and authorizes native byte-range playback through the real HTTP service', async (t) => {
  const id = '00000000-0000-4000-8000-000000000001';
  const uploadCode = 'private-test-guest-code';
  const fileId = 'private-drive-video-id';
  const original = Buffer.from('a wedding video fixture');
  const photo = { id, fileId, size: original.length, mimeType: 'video/mp4', createdAt: new Date(), guestName: 'A guest' };
  let present = true;
  let mediaReads = 0;
  const gallery = createGalleryService({
    folderId: 'private-test-folder', uploadCode, tokenSecret: 'private-test-secret-at-least-thirty-two-characters',
    repository: {
      async seedCompletedUploads() {},
      async list() { return { photos: [photo], nextCursor: null }; },
      async get(key) { return key === id ? photo : null; },
    },
    drive: {
      async getFolderFileIds() { return new Set(present ? [fileId] : []); },
      async getMetadata() { return { id: fileId, size: String(original.length), mimeType: photo.mimeType, appProperties: { uploadId: id }, trashed: false }; },
      async thumbnail() { return { bytes: Buffer.from([0xff, 0xd8, 0xff]), contentType: 'image/jpeg' }; },
      async media(_metadata, { range }) {
        mediaReads += 1;
        const start = range?.start ?? 0;
        const end = range?.end ?? original.length - 1;
        return {
          body: new ReadableStream({ start(controller) { controller.enqueue(original.subarray(start, end + 1)); controller.close(); } }),
          status: range ? 206 : 200, contentType: photo.mimeType, contentLength: end - start + 1,
          ...(range ? { contentRange: `bytes ${start}-${end}/${original.length}` } : {}),
        };
      },
    },
  });
  const server = createUploadServer({ service: {}, gallery, allowedOrigins: ['https://krishaandjoe.ph'], logger: { error() {} } });
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const endpoint = `http://127.0.0.1:${server.address().port}`;

  const page = await getGallery(endpoint, { uploadCode });
  assert.deepEqual(page.photos, [{ id, mimeType: photo.mimeType, createdAt: photo.createdAt.toISOString(), guestName: photo.guestName }]);
  assert.equal((await fetchGalleryImage(endpoint, id, { uploadCode })).type, 'image/jpeg');
  const playback = await getGalleryPlayback(endpoint, id, { uploadCode });
  assert.equal(playback.mimeType, 'video/mp4');
  assert.ok(!playback.url.includes(uploadCode) && !playback.url.includes(fileId));
  const range = await fetch(playback.url, { headers: { Range: 'bytes=2-5', Origin: 'https://krishaandjoe.ph' }, redirect: 'error' });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('Content-Type'), 'video/mp4');
  assert.equal(range.headers.get('Content-Range'), `bytes 2-5/${original.length}`);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), original.subarray(2, 6));

  present = false;
  const removed = await fetch(playback.url, { headers: { Range: 'bytes=0-1' } });
  assert.equal(removed.status, 404, 'Even an existing playback capability must respect removal from the wedding folder');
  await removed.body.cancel();
  assert.equal(mediaReads, 1);
});
