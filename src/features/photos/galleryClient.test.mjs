import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchGalleryImage, getGallery, MAX_GALLERY_IMAGE_BYTES } from './galleryClient.mjs';

const endpoint = 'https://wedding-uploader.example/api';
const photoId = 'df3846c3-eb9e-42e2-86af-d05c737a1a2a';
const uploadCode = 'PRIVATE_GUEST_CODE';
const photo = { id: photoId, createdAt: '2026-11-21T06:00:00.000Z', mimeType: 'image/heic' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const page = () => json({ ok: true, photos: [photo], nextCursor: null });

test('gallery requests encode the cursor, authenticate with a header, and return only public photo metadata', async (t) => {
  let request;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    request = { url, ...options };
    return json({ ok: true, photos: [{ ...photo, driveFileId: 'PRIVATE_DRIVE_ID', url: 'https://drive.google.com/private' }], nextCursor: 'next-page' });
  });
  const cursor = 'opaque+/=?& cursor';
  assert.deepEqual(await getGallery(`${endpoint}/`, { uploadCode, cursor }), { photos: [photo], nextCursor: 'next-page' });
  assert.equal(new URL(request.url).pathname, '/api/v1/gallery');
  assert.equal(new URL(request.url).searchParams.get('cursor'), cursor);
  assert.equal(request.headers['X-Upload-Code'], uploadCode);
  assert.equal(request.method, 'GET');
  assert.equal(request.mode, 'cors');
  assert.equal(request.credentials, 'omit');
  assert.equal(request.redirect, 'error');
  assert.equal(request.cache, 'no-store');
  assert.ok(!request.url.includes(uploadCode));
});

test('malformed gallery pages are rejected before reaching the UI', async (t) => {
  const invalid = [
    { ok: 'true', photos: [photo], nextCursor: null },
    { ok: true, photos: 'not-an-array', nextCursor: null },
    { ok: true, photos: [photo] },
    { ok: true, photos: [{ ...photo, id: 'a-private-drive-file-id' }], nextCursor: null },
    { ok: true, photos: [{ ...photo, mimeType: 'image/svg+xml' }], nextCursor: null },
    { ok: true, photos: [{ ...photo, createdAt: '2026-02-30T06:00:00.000Z' }], nextCursor: null },
    { ok: true, photos: [photo, photo], nextCursor: null },
    { ok: true, photos: [], nextCursor: 'x'.repeat(2049) },
  ];
  t.mock.method(globalThis, 'fetch', async () => json(invalid.shift()));
  for (let index = 0; index < 8; index += 1) {
    await assert.rejects(getGallery(endpoint, { uploadCode }), { name: 'GalleryError', code: 'invalid-response' });
  }
});

test('optional guest names are normalized and projected without exposing private server metadata', async (t) => {
  const cases = [
    ['  A\t Guest\n ', 'A Guest'],
    ['Jose\u0301 李 👩\u200d💻', 'José 李 👩\u200d💻'],
    ['x'.repeat(100), 'x'.repeat(100)],
    ['<b>A Guest</b>', '<b>A Guest</b>'],
  ];
  let requestIndex = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    const [guestName] = cases[requestIndex++];
    return json({ ok: true, photos: [{
      ...photo, guestName,
      ownerEmail: 'PRIVATE_OWNER_ADDRESS', fileId: 'PRIVATE_DRIVE_ID',
      thumbnailLink: 'https://private.example/PRIVATE_IMAGE_LINK',
    }], nextCursor: null });
  });
  for (const [, expected] of cases) {
    const result = await getGallery(endpoint, { uploadCode });
    assert.deepEqual(result, { photos: [{ ...photo, guestName: expected }], nextCursor: null });
    assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
  }
});

test('missing, blank, oversized, and malformed names keep the photo valid with a neutral credit', async (t) => {
  const values = [undefined, null, '', ' \t\n ', 42, [], { email: 'PRIVATE_EMAIL' }, 'x'.repeat(101), '\ud800', '\u202e\u2066'];
  let requestIndex = 0;
  t.mock.method(globalThis, 'fetch', async () => json({
    ok: true, photos: [{ ...photo, guestName: values[requestIndex++] }], nextCursor: null,
  }));
  for (const value of values) {
    const result = await getGallery(endpoint, { uploadCode });
    assert.deepEqual(result.photos, [photo], `Optional name must not invalidate a photo: ${typeof value}`);
    assert.equal(Object.hasOwn(result.photos[0], 'guestName'), false);
    assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
  }
});

test('image requests use the selected variant and return a Blob with a safe display type', async (t) => {
  let request;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    request = { url, ...options };
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/jpeg; charset=binary' } });
  });
  const blob = await fetchGalleryImage(`${endpoint}/`, photoId, { uploadCode, variant: 'preview' });
  assert.ok(blob instanceof Blob);
  assert.equal(blob.type, 'image/jpeg');
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), new Uint8Array([1, 2, 3]));
  assert.equal(request.url, `${endpoint}/v1/gallery/${photoId}/image?variant=preview`);
  assert.equal(request.headers['X-Upload-Code'], uploadCode);
  assert.equal(request.redirect, 'error');
  assert.equal(request.credentials, 'omit');
  assert.equal(request.cache, 'no-store');
});

test('SVG, HTML, unknown, and empty image responses are rejected', async (t) => {
  const replies = [
    new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } }),
    new Response('<html/>', { headers: { 'Content-Type': 'text/html' } }),
    new Response('unknown', { headers: { 'Content-Type': 'application/octet-stream' } }),
    new Response(null, { headers: { 'Content-Type': 'image/jpeg' } }),
  ];
  t.mock.method(globalThis, 'fetch', async () => replies.shift());
  for (let index = 0; index < 3; index += 1) {
    await assert.rejects(fetchGalleryImage(endpoint, photoId, { uploadCode }), { code: 'unsupported-image' });
  }
  await assert.rejects(fetchGalleryImage(endpoint, photoId, { uploadCode }), { code: 'invalid-image' });
});

test('image size limits reject declared, streamed, and fallback Blob excess and cancel the stream', async (t) => {
  let cancelled = false;
  const replies = [
    new Response('too large', { headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(MAX_GALLERY_IMAGE_BYTES + 1) } }),
    new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(MAX_GALLERY_IMAGE_BYTES + 1)); },
      cancel() { cancelled = true; },
    }), { headers: { 'Content-Type': 'image/png' } }),
    { ok: true, headers: new Headers({ 'Content-Type': 'image/webp' }), blob: async () => ({ size: MAX_GALLERY_IMAGE_BYTES + 1 }) },
  ];
  t.mock.method(globalThis, 'fetch', async () => replies.shift());
  for (let index = 0; index < 3; index += 1) {
    await assert.rejects(fetchGalleryImage(endpoint, photoId, { uploadCode }), { code: 'image-too-large' });
  }
  assert.equal(cancelled, true);
});

test('public errors use local copy and never echo the server response or guest credential', async (t) => {
  const replies = [json({ error: uploadCode }, 404), json({ error: uploadCode }, 503), json({ error: uploadCode }, 401)];
  t.mock.method(globalThis, 'fetch', async () => replies.shift());
  await assert.rejects(fetchGalleryImage(endpoint, photoId, { uploadCode }), (error) => {
    assert.equal(error.message, 'This photo is no longer available.');
    assert.equal(error.code, 'not-found');
    return true;
  });
  await assert.rejects(fetchGalleryImage(endpoint, photoId, { uploadCode }), (error) => {
    assert.equal(error.message, 'This photo’s preview is still being prepared. Please try again.');
    return true;
  });
  await assert.rejects(getGallery(endpoint, { uploadCode }), (error) => {
    assert.equal(error.code, 'unauthorized');
    assert.ok(!`${error.message}${JSON.stringify(error)}`.includes(uploadCode));
    return true;
  });
});

test('request deadlines abort a stalled fetch and include the response body read', async (t) => {
  let signal;
  const mock = t.mock.method(globalThis, 'fetch', async (_url, options) => {
    signal = options.signal;
    return new Promise(() => {});
  });
  await assert.rejects(getGallery(endpoint, { uploadCode, timeoutMs: 5 }), { code: 'timeout' });
  assert.equal(signal.aborted, true);
  mock.mock.restore();
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    signal = options.signal;
    return { ok: true, json: () => new Promise(() => {}) };
  });
  await assert.rejects(getGallery(endpoint, { uploadCode, timeoutMs: 5 }), { code: 'timeout' });
  assert.equal(signal.aborted, true);
});

test('timing out an image cancels a stalled streaming body', async (t) => {
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    cancel() { cancelled = true; },
  }), { headers: { 'Content-Type': 'image/jpeg' } }));
  await assert.rejects(fetchGalleryImage(endpoint, photoId, { uploadCode, timeoutMs: 5 }), { code: 'timeout' });
  assert.equal(cancelled, true);
});

test('caller cancellation stays an AbortError and does not expose a private abort reason', async (t) => {
  const controller = new AbortController();
  let receivedSignal;
  const mock = t.mock.method(globalThis, 'fetch', async (_url, options) => {
    receivedSignal = options.signal;
    return new Promise(() => {});
  });
  const pending = getGallery(endpoint, { uploadCode, signal: controller.signal });
  controller.abort(new Error(uploadCode));
  await assert.rejects(pending, (error) => {
    assert.equal(error.name, 'AbortError');
    assert.ok(!error.message.includes(uploadCode));
    return true;
  });
  assert.equal(receivedSignal.aborted, true);
  await assert.rejects(getGallery(endpoint, { uploadCode, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(mock.mock.callCount(), 1);
});

test('successful requests remove the deadline and caller abort listener', async (t) => {
  const controller = new AbortController();
  let receivedSignal;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    receivedSignal = options.signal;
    return page();
  });
  await getGallery(endpoint, { uploadCode, signal: controller.signal, timeoutMs: 5 });
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(receivedSignal.aborted, false);
});

test('invalid endpoints, cursors, photo IDs, variants, and credentials fail before fetch', async (t) => {
  const mock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not fetch'); });
  await assert.rejects(getGallery('http://remote.example', { uploadCode }), { code: 'not-configured' });
  await assert.rejects(getGallery(endpoint, { uploadCode, cursor: 'x'.repeat(2049) }), { code: 'invalid-cursor' });
  await assert.rejects(fetchGalleryImage(endpoint, '../private-drive-id', { uploadCode }), { code: 'not-found' });
  await assert.rejects(fetchGalleryImage(endpoint, photoId, { uploadCode, variant: 'original' }), { code: 'not-found' });
  await assert.rejects(getGallery(endpoint, { uploadCode: `${uploadCode}\n` }), { code: 'unauthorized' });
  assert.equal(mock.mock.callCount(), 0);
});
