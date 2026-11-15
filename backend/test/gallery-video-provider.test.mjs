import assert from 'node:assert/strict';
import test from 'node:test';
import { createDriveGalleryProvider } from '../src/drive-gallery-provider.mjs';

const bytes = Buffer.from('video-data');
const metadata = { id: 'private-video-file', mimeType: 'video/mp4', size: String(bytes.length) };
const mediaResponse = (body = bytes, status = 200, headers = {}) => new Response(body, {
  status, headers: { 'content-type': 'video/mp4', 'content-length': String(body.length), ...headers },
});

function provider(fetchImpl, options = {}) {
  const requests = [];
  let refreshes = 0;
  const drive = createDriveGalleryProvider({
    auth: { async getAccessToken() { refreshes += 1; return { token: 'PRIVATE_OWNER_TOKEN' }; } },
    fetchImpl: async (url, request) => { requests.push({ url, ...request }); return fetchImpl(url, request); },
    ...options,
  });
  return { drive, requests, refreshes: () => refreshes };
}

test('video bytes stream from a fixed authenticated Drive URL and exact ranges retain safe headers only', async () => {
  const fixture = provider(() => mediaResponse(bytes.subarray(2, 6), 206, { 'content-range': `bytes 2-5/${bytes.length}` }));
  const result = await fixture.drive.media(metadata, { range: { start: 2, end: 5 } });
  assert.equal(result.status, 206);
  assert.equal(result.contentLength, 4);
  assert.equal(result.contentType, 'video/mp4');
  assert.equal(result.contentRange, `bytes 2-5/${bytes.length}`);
  assert.deepEqual(Buffer.from(await new Response(result.body).arrayBuffer()), bytes.subarray(2, 6));
  const request = fixture.requests[0];
  assert.equal(request.url, 'https://www.googleapis.com/drive/v3/files/private-video-file?alt=media&supportsAllDrives=true');
  assert.equal(request.headers.Authorization, 'Bearer PRIVATE_OWNER_TOKEN');
  assert.equal(request.headers.Range, 'bytes=2-5');
  assert.equal(request.redirect, 'manual');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_OWNER_TOKEN|private-video-file|https:/);
});

test('full video responses remain streaming and do not prebuffer a declared 500 MiB original', async () => {
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) { pulls += 1; controller.enqueue(new Uint8Array([1, 2, 3])); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const size = 500 * 1024 * 1024;
  const fixture = provider(() => new Response(body, { headers: { 'content-type': 'video/mp4', 'content-length': String(size) } }));
  const result = await fixture.drive.media({ ...metadata, size: String(size) });
  assert.equal(result.contentLength, size);
  assert.equal(result.status, 200);
  assert.equal(result.contentRange, undefined);
  assert.equal(pulls, 0, 'Opening a video must not read or allocate its entire body');
  const reader = result.body.getReader();
  assert.deepEqual((await reader.read()).value, new Uint8Array([1, 2, 3]));
  assert.equal(pulls, 1);
  await reader.cancel();
  assert.equal(cancelled, true);
  assert.equal(fixture.requests[0].signal.aborted, true);
});

test('video posters reuse Drive image thumbnails and never fetch a video original as fallback', async () => {
  const fixture = provider(() => new Response(Buffer.from('poster'), { headers: { 'content-type': 'image/jpeg' } }));
  const poster = await fixture.drive.thumbnail({ ...metadata, thumbnailLink: 'https://lh3.googleusercontent.com/poster=s220' });
  assert.equal(poster.contentType, 'image/jpeg');
  assert.equal(poster.bytes.toString(), 'poster');
  assert.equal(fixture.requests[0].url, 'https://lh3.googleusercontent.com/poster=s480');
  const missingPoster = provider(() => { throw new Error('must not download an original'); });
  await assert.rejects(missingPoster.drive.thumbnail(metadata), { status: 503, retryable: true });
  assert.equal(missingPoster.requests.length, 0);
  assert.equal(missingPoster.refreshes(), 0);
});

test('invalid media metadata and range objects fail before OAuth or an upstream request', async () => {
  const fixture = provider(() => { throw new Error('must not send'); });
  for (const input of [
    { ...metadata, id: '../unsafe' }, { ...metadata, mimeType: 'text/html' }, { ...metadata, size: '0' },
    { ...metadata, size: String(500 * 1024 * 1024 + 1) },
  ]) await assert.rejects(fixture.drive.media(input), { status: 502 });
  for (const range of [{ start: -1, end: 1 }, { start: 2, end: 1 }, { start: 0, end: bytes.length }, {}]) {
    await assert.rejects(fixture.drive.media(metadata, { range }), { status: 502 });
  }
  assert.equal(fixture.refreshes(), 0);
  assert.equal(fixture.requests.length, 0);
});

test('wrong response types, lengths, ranges and redirects are rejected before returning a video stream', async () => {
  const cases = [
    () => mediaResponse(bytes, 200, { 'content-type': 'text/html' }),
    () => mediaResponse(bytes, 200, { 'content-length': String(bytes.length + 1) }),
    () => new Response(bytes, { headers: { 'content-type': 'video/mp4' } }),
    () => mediaResponse(bytes, 200, { 'content-range': `bytes 0-${bytes.length - 1}/${bytes.length}` }),
    () => mediaResponse(bytes, 206, { 'content-range': `bytes 0-${bytes.length - 1}/${bytes.length}` }),
    () => new Response(null, { status: 302, headers: { Location: 'https://private.example/PRIVATE_PROVIDER_TOKEN' } }),
  ];
  for (const makeResponse of cases) {
    const fixture = provider(makeResponse);
    await assert.rejects(fixture.drive.media(metadata), (error) => {
      assert.ok([302, 502].includes(error.status));
      assert.equal(error.diagnostics.operation, 'get_media');
      assert.doesNotMatch(JSON.stringify(error), /PRIVATE_PROVIDER_TOKEN|private\.example|OWNER_TOKEN/);
      return true;
    });
    assert.equal(fixture.requests.length, 1);
  }
  const mismatch = provider(() => mediaResponse(bytes.subarray(2, 6), 206, { 'content-range': `bytes 1-4/${bytes.length}` }));
  await assert.rejects(mismatch.drive.media(metadata, { range: { start: 2, end: 5 } }), { status: 502 });
});

test('video stream byte accounting rejects truncated or excessive bodies instead of accepting a partial original', async () => {
  for (const content of [bytes.subarray(0, 3), Buffer.concat([bytes, Buffer.from('extra')])]) {
    const fixture = provider(() => mediaResponse(content, 200, { 'content-length': String(bytes.length) }));
    const result = await fixture.drive.media(metadata);
    await assert.rejects(new Response(result.body).arrayBuffer(), { status: 502 });
    assert.equal(fixture.requests[0].signal.aborted, true);
  }
});

test('video response headers have a bounded deadline and caller cancellation prevents requests', async () => {
  const fixture = provider((_url, request) => new Promise((_resolve, reject) => {
    request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
  }), { mediaHeaderTimeoutMs: 5 });
  await assert.rejects(fixture.drive.media(metadata), {
    status: 503, diagnostics: { upstream: 'drive', operation: 'get_media', reason: 'timeout' },
  });
  const cancelled = provider(() => { throw new Error('must not send'); });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(cancelled.drive.media(metadata, { signal: controller.signal }), { status: 503 });
  assert.equal(cancelled.refreshes(), 0);
  assert.equal(cancelled.requests.length, 0);
});
