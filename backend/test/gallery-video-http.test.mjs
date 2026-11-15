import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { ApiError } from '../src/errors.mjs';
import { createUploadServer } from '../src/http-server.mjs';

const id = 'af8d3c2a-7891-4b21-9c54-bd1e4eb6a7e0';
const code = 'private-guest-code';
const origin = 'https://wedding.example';
const token = 'private-playback-capability';
const bytes = Buffer.from('video-content');
const stream = (value = bytes) => new ReadableStream({ start(controller) { controller.enqueue(value); controller.close(); } });

async function start(t, overrides = {}) {
  const calls = [];
  const gallery = {
    async playback(key, suppliedCode) {
      calls.push({ method: 'playback', key });
      if (suppliedCode !== code) throw new ApiError(401, 'Enter the guest password again.');
      return { ok: true, token, expiresAt: '2026-11-21T08:30:00.000Z', mimeType: 'video/mp4' };
    },
    async video(key, options) {
      calls.push({ method: 'video', key, range: options.range, signal: options.signal });
      if (options.token !== token) throw new ApiError(401, 'Reopen this video to play it.');
      const partial = options.range === 'bytes=2-5';
      const content = partial ? bytes.subarray(2, 6) : bytes;
      return { body: stream(content), status: partial ? 206 : 200, contentType: 'video/mp4', contentLength: content.length,
        ...(partial ? { contentRange: `bytes 2-5/${bytes.length}` } : {}) };
    },
    ...overrides,
  };
  const logs = [];
  const server = createUploadServer({ service: {}, gallery, allowedOrigins: [origin], logger: { error: (value) => logs.push(value) } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });
  return { base: `http://127.0.0.1:${server.address().port}`, calls, logs };
}

test('playback tickets require guest authentication and reject queries or unsupported methods', async (t) => {
  const { base, calls } = await start(t);
  const path = `${base}/v1/gallery/${id}/playback`;
  assert.equal((await fetch(path)).status, 401);
  const response = await fetch(path, { headers: { Origin: origin, 'X-Upload-Code': code } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(await response.json(), { ok: true, token, expiresAt: '2026-11-21T08:30:00.000Z', mimeType: 'video/mp4' });
  const previous = calls.length;
  assert.equal((await fetch(`${path}?token=${token}`, { headers: { 'X-Upload-Code': code } })).status, 400);
  assert.equal((await fetch(path, { method: 'POST' })).status, 405);
  assert.equal(calls.length, previous);
});

test('native video URLs stream originals without guest headers and retain private media response headers', async (t) => {
  const { base, calls } = await start(t);
  const response = await fetch(`${base}/v1/gallery/${id}/video?token=${token}`, { headers: { Origin: origin } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.equal(response.headers.get('content-length'), null, 'Full originals stay chunked on Cloud Run');
  assert.equal(response.headers.get('transfer-encoding'), 'chunked');
  assert.equal(response.headers.get('content-disposition'), 'inline');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.equal(calls[0].key, id);
  assert.equal(calls[0].signal.aborted, false);
});

test('video range requests forward the browser range and return a seekable 206 response', async (t) => {
  const { base, calls } = await start(t);
  const response = await fetch(`${base}/v1/gallery/${id}/video?token=${token}`, { headers: { Origin: origin, Range: 'bytes=2-5' } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), `bytes 2-5/${bytes.length}`);
  assert.equal(response.headers.get('content-length'), '4');
  assert.match(response.headers.get('access-control-expose-headers'), /Content-Range/);
  assert.equal(calls[0].range, 'bytes=2-5');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(2, 6));
});

test('large partial video responses remain chunked without allocating the original', async (t) => {
  const size = 32 * 1024 * 1024;
  let cancelled;
  const cancellation = new Promise((resolve) => { cancelled = resolve; });
  let chunks = 0;
  const { base } = await start(t, { async video() {
    return {
      body: new ReadableStream({
        pull(controller) { if (chunks++ === 0) controller.enqueue(Buffer.from('start')); },
        cancel() { cancelled(); },
      }),
      status: 206, contentType: 'video/mp4', contentLength: size, contentRange: `bytes 0-${size - 1}/${size}`,
    };
  } });
  const response = await fetch(`${base}/v1/gallery/${id}/video?token=${token}`, { headers: { Range: 'bytes=0-' } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-length'), null);
  assert.equal(response.headers.get('transfer-encoding'), 'chunked');
  assert.equal(response.headers.get('content-range'), `bytes 0-${size - 1}/${size}`);
  await response.body.cancel();
  await cancellation;
});

test('unsatisfiable ranges retain 416 and a safe total-size header', async (t) => {
  const { base } = await start(t, { async video() {
    const error = new ApiError(416, 'This video range is invalid.');
    error.rangeSize = bytes.length;
    throw error;
  } });
  const response = await fetch(`${base}/v1/gallery/${id}/video?token=${token}`, { headers: { Range: 'bytes=999-' } });
  assert.equal(response.status, 416);
  assert.equal(response.headers.get('content-range'), `bytes */${bytes.length}`);
  assert.equal((await response.json()).ok, false);
});

test('video routes require a single capability and permit Range preflight without reading a video', async (t) => {
  const { base, calls } = await start(t);
  const path = `${base}/v1/gallery/${id}/video`;
  for (const suffix of ['', `?token=${token}&token=other`, `?token=${token}&fileId=private`]) {
    assert.equal((await fetch(path + suffix)).status, 400);
  }
  assert.equal((await fetch(`${path}?token=invalid`)).status, 401);
  const previous = calls.length;
  const preflight = await fetch(`${path}?token=${token}`, { method: 'OPTIONS', headers: {
    Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'range',
  } });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-headers'), /Range/);
  assert.equal(calls.length, previous);
});

test('invalid streamed media is cancelled before response headers expose unsafe content', async (t) => {
  let cancelled = 0;
  const { base } = await start(t, { async video() {
    return { body: new ReadableStream({ cancel() { cancelled += 1; } }), status: 200, contentType: 'text/html', contentLength: 3 };
  } });
  const response = await fetch(`${base}/v1/gallery/${id}/video?token=${token}`);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(cancelled, 1);
  assert.equal((await response.json()).ok, false);
});

test('closing the video response aborts upstream work and cancels its body', async (t) => {
  let sourceCancelled;
  const cancelled = new Promise((resolve) => { sourceCancelled = resolve; });
  let upstreamSignal;
  let chunks = 0;
  const { base } = await start(t, { async video(_key, { signal }) {
    upstreamSignal = signal;
    return { body: new ReadableStream({
      pull(controller) { if (chunks++ === 0) controller.enqueue(Buffer.from('start')); },
      cancel() { sourceCancelled(); },
    }), status: 200, contentType: 'video/mp4', contentLength: 1000 };
  } });
  const response = await fetch(`${base}/v1/gallery/${id}/video?token=${token}`);
  const reader = response.body.getReader();
  assert.deepEqual((await reader.read()).value, new Uint8Array(Buffer.from('start')));
  await reader.cancel();
  await cancelled;
  assert.equal(upstreamSignal.aborted, true);
});

test('streamed bodies cannot exceed their verified declared length', async (t) => {
  const { base, logs } = await start(t, { async video() {
    return { body: stream(Buffer.from('too many bytes')), status: 200, contentType: 'video/mp4', contentLength: 3 };
  } });
  await assert.rejects(fetch(`${base}/v1/gallery/${id}/video?token=${token}`).then((response) => response.arrayBuffer()), TypeError);
  assert.ok(logs.every((entry) => !entry.includes(token)));
});
