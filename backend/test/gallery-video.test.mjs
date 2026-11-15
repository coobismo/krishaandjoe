import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlaybackAuth, MAX_GALLERY_VIDEO_BYTES, parseVideoRange, PLAYBACK_TOKEN_TTL_MS } from '../src/gallery-video.mjs';
import { createGalleryService } from '../src/gallery-service.mjs';

const videoId = 'af8d3c2a-7891-4b21-9c54-bd1e4eb6a7e0';
const photoId = 'aa8d3c2a-7891-4b21-9c54-bd1e4eb6a7e1';
const code = 'PRIVATE_GUEST_PASSWORD';
const secret = 'PRIVATE_VIDEO_SIGNING_SECRET_more_than_32_chars';

function fixture() {
  let instant = Date.parse('2026-11-21T08:00:00Z');
  let inFolder = true;
  const video = { id: videoId, fileId: 'PRIVATE_DRIVE_VIDEO', size: 10, mimeType: 'video/mp4', createdAt: new Date(instant), guestName: 'Guest' };
  const image = { ...video, id: photoId, fileId: 'PRIVATE_DRIVE_PHOTO', mimeType: 'image/jpeg' };
  const records = new Map([[videoId, video], [photoId, image]]);
  const counts = { reads: 0, media: 0, poster: 0 };
  let metadataChanges = {};
  const mediaCalls = [];
  const service = createGalleryService({
    folderId: 'PRIVATE_FOLDER', uploadCode: code, tokenSecret: secret, now: () => instant,
    repository: {
      async seedCompletedUploads() { counts.reads += 1; },
      async get(id) { counts.reads += 1; return records.get(id) || null; },
      async list() { counts.reads += 1; return { photos: [...records.values()], nextCursor: null }; },
    },
    drive: {
      async getFolderFileIds(_folder, ids) { counts.reads += 1; return new Set(inFolder ? ids.map((id) => records.get(id)?.fileId).filter(Boolean) : []); },
      async getMetadata(fileId) {
        counts.reads += 1;
        const record = [...records.values()].find((value) => value.fileId === fileId);
        return record ? { id: record.fileId, size: String(record.size), mimeType: record.mimeType, appProperties: { uploadId: record.id }, ...metadataChanges } : null;
      },
      async thumbnail() { counts.poster += 1; return { bytes: Buffer.from('poster'), contentType: 'image/jpeg' }; },
      async media(metadata, { range, signal }) {
        counts.media += 1;
        mediaCalls.push({ metadata, range, signal });
        return {
          status: range ? 206 : 200, body: new ReadableStream({ start(controller) { controller.close(); } }),
          contentType: metadata.mimeType, contentLength: range ? range.end - range.start + 1 : Number(metadata.size),
          ...(range ? { contentRange: `bytes ${range.start}-${range.end}/${metadata.size}` } : {}),
        };
      },
    },
  });
  return {
    service, counts, mediaCalls, video,
    advance: (milliseconds) => { instant += milliseconds; },
    setFolder: (value) => { inFolder = value; },
    setMetadata: (value) => { metadataChanges = value; },
  };
}

test('single video ranges normalize closed, open, suffix and oversized-end requests', () => {
  assert.equal(parseVideoRange(undefined, 100), undefined);
  for (const [value, expected] of [
    ['bytes=0-0', { start: 0, end: 0 }], ['bytes=50-', { start: 50, end: 99 }],
    ['bytes=-10', { start: 90, end: 99 }], ['bytes=-200', { start: 0, end: 99 }],
    ['bytes=50-999', { start: 50, end: 99 }], ['bytes=000-009', { start: 0, end: 9 }],
  ]) assert.deepEqual(parseVideoRange(value, 100), expected);
  for (const value of [null, '', 'items=0-1', 'bytes=-', 'bytes=-0', 'bytes=100-', 'bytes=9-2', 'bytes=1.2-9', 'bytes=0-1,5-9', 'bytes=9007199254740992-', 'x'.repeat(129)]) {
    assert.throws(() => parseVideoRange(value, 100), (error) => error.status === 416 && error.rangeSize === 100);
  }
  assert.throws(() => parseVideoRange(undefined, MAX_GALLERY_VIDEO_BYTES + 1), { status: 416 });
});

test('playback capabilities are scoped to a gallery UUID, signed and limited to thirty minutes', () => {
  let now = Date.parse('2026-11-21T08:00:00Z');
  const auth = createPlaybackAuth({ tokenSecret: secret, now: () => now });
  const issued = auth.issue(videoId);
  assert.equal(Date.parse(issued.expiresAt) - now, PLAYBACK_TOKEN_TTL_MS);
  assert.equal(auth.check(videoId, issued.token), true);
  assert.equal(createPlaybackAuth({ tokenSecret: secret, now: () => now - 500 }).check(videoId, issued.token), true, 'Minor clock differences between instances must not reject a newly issued signed capability');
  assert.equal(auth.check(photoId, issued.token), false);
  for (const token of [undefined, '', issued.token + 'x', 'x'.repeat(101), issued.token.replace(/.$/, (value) => value === 'A' ? 'B' : 'A')]) assert.equal(auth.check(videoId, token), false);
  const [expiry, signature] = issued.token.split('.');
  assert.equal(auth.check(videoId, `${Number(expiry) + 1000}.${signature}`), false);
  now += PLAYBACK_TOKEN_TTL_MS;
  assert.equal(auth.check(videoId, issued.token), false);
  assert.equal(auth.check(videoId, auth.issue(videoId).token), true);
  assert.equal(createPlaybackAuth({ tokenSecret: secret + 'rotated', now: () => now }).check(videoId, auth.issue(videoId).token), false);
});

test('videos share the gallery DTO and authenticated poster endpoint without exposing provider fields', async () => {
  const { service, video, counts } = fixture();
  const page = await service.list({}, code);
  assert.equal(page.photos.length, 2);
  assert.deepEqual(page.photos[0], { id: videoId, mimeType: 'video/mp4', createdAt: video.createdAt.toISOString(), guestName: 'Guest' });
  assert.doesNotMatch(JSON.stringify(page), /PRIVATE|fileId|size|thumbnailLink/);
  const poster = await service.image(videoId, {}, code);
  assert.equal(poster.contentType, 'image/jpeg');
  assert.equal(counts.poster, 1);
});

test('ticket issuance requires the guest code and playback rejects missing, changed, wrong-file and expired tokens before reads', async () => {
  const f = fixture();
  await assert.rejects(f.service.playback(videoId, 'wrong'), { status: 401 });
  assert.equal(f.counts.reads, 0);
  const ticket = await f.service.playback(videoId, code);
  assert.deepEqual(Object.keys(ticket).sort(), ['expiresAt', 'mimeType', 'ok', 'token']);
  assert.equal(ticket.mimeType, 'video/mp4');
  assert.doesNotMatch(JSON.stringify(ticket), /PRIVATE|fileId|https:|sessionUrl/);
  const before = f.counts.reads;
  for (const options of [{}, { token: 'bad' }, { token: ticket.token + 'x' }, null]) await assert.rejects(f.service.video(videoId, options), { status: 401 });
  await assert.rejects(f.service.video(photoId, { token: ticket.token }), { status: 401 });
  assert.equal(f.counts.reads, before);
  f.advance(PLAYBACK_TOKEN_TTL_MS);
  await assert.rejects(f.service.video(videoId, { token: ticket.token }), { status: 401 });
  assert.equal(f.counts.reads, before);
  await assert.rejects(f.service.playback(photoId, code), { status: 404 });
});

test('playback forwards normalized ranges and disconnect signals without buffering or authorizing arbitrary files', async () => {
  const f = fixture();
  const ticket = await f.service.playback(videoId, code);
  const controller = new AbortController();
  const partial = await f.service.video(videoId, { token: ticket.token, range: 'bytes=-3', signal: controller.signal });
  assert.equal(partial.status, 206);
  assert.equal(partial.contentLength, 3);
  assert.deepEqual(f.mediaCalls[0].range, { start: 7, end: 9 });
  assert.equal(f.mediaCalls[0].signal, controller.signal);
  const full = await f.service.video(videoId, { token: ticket.token });
  assert.equal(full.status, 200);
  assert.equal(f.mediaCalls[1].range, undefined);
  await assert.rejects(f.service.video(videoId, { token: ticket.token, range: 'bytes=10-' }), { status: 416, rangeSize: 10 });
  assert.equal(f.counts.media, 2);
});

test('every video range checks current folder membership, trash state and original upload identity', async () => {
  const f = fixture();
  const { token } = await f.service.playback(videoId, code);
  await f.service.video(videoId, { token, range: 'bytes=0-1' });
  f.setFolder(false);
  await assert.rejects(f.service.video(videoId, { token, range: 'bytes=2-3' }), { status: 404 });
  f.setFolder(true);
  f.setMetadata({ trashed: true });
  await assert.rejects(f.service.video(videoId, { token }), { status: 404 });
  for (const changes of [{ size: '11' }, { mimeType: 'video/webm' }, { appProperties: { uploadId: photoId } }]) {
    f.setMetadata(changes);
    await assert.rejects(f.service.video(videoId, { token }), { status: 503 });
  }
  assert.equal(f.counts.media, 1);
});
