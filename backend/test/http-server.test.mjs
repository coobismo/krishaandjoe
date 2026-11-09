import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import test from 'node:test';
import { ApiError } from '../src/errors.mjs';
import { createUploadServer } from '../src/http-server.mjs';

const uploadId = '090b48b1-833f-4e70-9312-d4cd9563bb78';
const origin = 'https://krisha-and-joe.example';
const receipt = { ok: true, uploadId, status: 'uploading', uploadedBytes: 0, chunkBytes: 4194304 };

async function start(t, overrides = {}) {
  const calls = [];
  const service = {
    async initialize(...args) { calls.push(['initialize', ...args]); return { ...receipt, token: 'an-upload-token' }; },
    async status(...args) { calls.push(['status', ...args]); return receipt; },
    async putChunk(...args) { calls.push(['putChunk', ...args]); return { ...receipt, uploadedBytes: args[3].length }; },
    ...overrides,
  };
  const logs = [];
  const server = createUploadServer({ service, allowedOrigins: [origin], logger: { error: (value) => logs.push(value) } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closing = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closing;
  });
  return { url: `http://127.0.0.1:${server.address().port}`, calls, logs, server };
}

function sendRaw(url, { method = 'POST', path = '/v1/uploads', headers = {}, chunks = [] } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(path, url);
    const req = request(target, { method, headers }, (response) => {
      const body = [];
      response.on('data', (chunk) => body.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(Buffer.concat(body).toString('utf8')) }));
      response.on('error', reject);
    });
    req.on('error', reject);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}

test('root and health checks expose only readiness and disable caching', async (t) => {
  const { url, calls } = await start(t);
  for (const path of ['/', '/health', '/healthz']) {
    const response = await fetch(`${url}${path}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  }
  assert.equal(calls.length, 0);
});

test('initialization forwards metadata and guest code, with exact allowed CORS origin', async (t) => {
  const { url, calls } = await start(t);
  const payload = { uploadId, name: 'dance.mp4', mimeType: 'video/mp4', size: 12 };
  const response = await fetch(`${url}/v1/uploads`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json; charset=utf-8', 'X-Upload-Code': 'guest-code' },
    body: JSON.stringify(payload),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  assert.equal(response.headers.get('vary'), 'Origin');
  assert.deepEqual(await response.json(), { ...receipt, token: 'an-upload-token' });
  assert.deepEqual(calls, [['initialize', payload, 'guest-code']]);
});

test('preflight permits required methods and headers and exposes Retry-After', async (t) => {
  const { url, calls } = await start(t);
  const response = await fetch(`${url}/v1/uploads/${uploadId}`, {
    method: 'OPTIONS',
    headers: { Origin: origin, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'content-range,x-upload-token,content-type' },
  });
  assert.equal(response.status, 204);
  assert.match(response.headers.get('access-control-allow-methods'), /PUT/);
  assert.match(response.headers.get('access-control-allow-headers'), /X-Upload-Token/);
  assert.equal(response.headers.get('access-control-expose-headers'), 'Retry-After');
  assert.equal(calls.length, 0);
});

test('CORS rejects prefix/suffix matches and null origins without calling the service', async (t) => {
  const { url, calls } = await start(t);
  for (const forbidden of ['https://krisha-and-joe.example.evil.test', `${origin}/path`, 'null']) {
    const response = await fetch(`${url}/v1/uploads/${uploadId}`, { headers: { Origin: forbidden } });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.equal((await response.json()).ok, false);
  }
  assert.equal(calls.length, 0);
});

test('status and chunks forward upload tokens and return ordinary JSON receipts', async (t) => {
  const { url, calls } = await start(t);
  const status = await fetch(`${url}/v1/uploads/${uploadId}`, { headers: { 'X-Upload-Token': 'private-token' } });
  assert.deepEqual(await status.json(), receipt);
  const chunk = await fetch(`${url}/v1/uploads/${uploadId}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Content-Range': 'bytes 0-3/4', 'X-Upload-Token': 'private-token' },
    body: new Uint8Array([1, 2, 3, 4]),
  });
  assert.equal(chunk.status, 200);
  assert.equal((await chunk.json()).uploadedBytes, 4);
  assert.deepEqual(calls[0], ['status', uploadId, 'private-token']);
  assert.equal(calls[1][0], 'putChunk');
  assert.equal(calls[1][2], 'private-token');
  assert.deepEqual(calls[1][3], { start: 0, end: 3, total: 4 });
  assert.deepEqual(calls[1][4], Buffer.from([1, 2, 3, 4]));
});

test('invalid JSON and unsupported content types fail before service calls', async (t) => {
  const { url, calls } = await start(t);
  const cases = [
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' },
    { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' },
    { method: 'PUT', path: `/v1/uploads/${uploadId}`, headers: { 'Content-Type': 'image/jpeg' }, body: '1' },
  ];
  for (const { path = '/v1/uploads', ...options } of cases) {
    const response = await fetch(url + path, options);
    assert.ok([400, 415].includes(response.status));
    assert.equal((await response.json()).ok, false);
  }
  assert.equal(calls.length, 0);
});

test('rejects invalid, unsafe, oversized, and mismatched Content-Range values', async (t) => {
  const { url, calls } = await start(t);
  const ranges = [undefined, 'bytes */4', 'bytes 3-2/4', 'bytes 0-4/4', 'bytes -1-0/4', 'bytes 0-9007199254740992/9007199254740993', 'bytes 0-4194304/4194305', 'bytes 0-3/4'];
  for (const range of ranges) {
    const response = await fetch(`${url}/v1/uploads/${uploadId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', ...(range ? { 'Content-Range': range } : {}) }, body: 'x',
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).ok, false);
  }
  assert.equal(calls.length, 0);
});

test('caps declared JSON size before buffering', async (t) => {
  const { url, calls } = await start(t);
  const response = await sendRaw(url, { headers: { 'Content-Type': 'application/json', 'Content-Length': String(32 * 1024 + 1) } });
  assert.equal(response.status, 413);
  assert.equal(response.body.ok, false);
  assert.equal(calls.length, 0);
});

test('caps streamed JSON and chunk bytes when Content-Length is absent', async (t) => {
  const { url, calls } = await start(t);
  const json = await sendRaw(url, {
    headers: { 'Content-Type': 'application/json' }, chunks: [Buffer.alloc(20 * 1024, ' '), Buffer.alloc(20 * 1024, ' ')],
  });
  assert.equal(json.status, 413);
  const chunk = await sendRaw(url, {
    method: 'PUT', path: `/v1/uploads/${uploadId}`,
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Range': 'bytes 0-4194303/4194304' },
    chunks: [Buffer.alloc(2 * 1024 * 1024), Buffer.alloc(2 * 1024 * 1024 + 1)],
  });
  assert.equal(chunk.status, 413);
  assert.equal(calls.length, 0);
});

test('auth and concurrency errors preserve status and retry semantics', async (t) => {
  const { url } = await start(t, {
    async initialize() { throw new ApiError(401, 'An upload code is required.'); },
    async status() { throw new ApiError(503, 'This file is busy.', { retryable: true, retryAfter: 3 }); },
  });
  const auth = await fetch(`${url}/v1/uploads`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(auth.status, 401);
  assert.deepEqual(await auth.json(), { ok: false, error: 'An upload code is required.', generic: false, retryable: false });
  const busy = await fetch(`${url}/v1/uploads/${uploadId}`);
  assert.equal(busy.status, 503);
  assert.equal(busy.headers.get('retry-after'), '3');
  assert.deepEqual(await busy.json(), { ok: false, error: 'This file is busy.', generic: true, retryable: true });
});

test('unexpected provider exceptions reveal no secrets in responses or logs', async (t) => {
  const secret = 'https://www.googleapis.com/upload/session?upload_id=private-token';
  const { url, logs } = await start(t, { async status() { throw new Error(secret); } });
  const response = await fetch(`${url}/v1/uploads/${uploadId}`);
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.generic, true);
  assert.equal(body.retryable, true);
  assert.ok(!JSON.stringify(body).includes(secret));
  assert.deepEqual(logs, [{ event: 'upload_request_failed', status: 500 }]);
});

test('unknown paths and methods return JSON errors', async (t) => {
  const { url } = await start(t);
  const missing = await fetch(`${url}/no-such-path`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).ok, false);
  const wrongMethod = await fetch(`${url}/v1/uploads`, { method: 'DELETE' });
  assert.equal(wrongMethod.status, 405);
  assert.equal((await wrongMethod.json()).ok, false);
  assert.equal(wrongMethod.headers.get('allow'), 'POST, OPTIONS');
});
