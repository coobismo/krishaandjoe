import assert from 'node:assert/strict';
import test from 'node:test';
import { uploadPhoto } from './uploadPhoto.mjs';

const endpoint = 'https://wedding-uploader.example/api';
const uploadId = 'baad6106-995a-4b81-926b-632648c02284';
const chunkBytes = 4 * 1024 * 1024;
const token = 'private-upload-capability';
const options = { provider: 'cloud-run', uploadCode: 'private-guest-code', retryBaseMs: 0, timeoutMs: 1000 };
const receipt = (uploadedBytes, status = 'uploading', extra = {}) => ({ ok: true, uploadId, uploadedBytes, status, chunkBytes, ...extra });
const response = (value) => new Response(JSON.stringify(value), { status: 200 });
const flush = async () => { for (let index = 0; index < 30; index += 1) await Promise.resolve(); };
const photo = (size) => Object.assign(new Blob([Buffer.alloc(size)], { type: 'image/jpeg' }), { name: 'guests.jpg' });

function browserRequests(t) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'XMLHttpRequest');
  const requests = [];
  class BrowserRequest {
    constructor() { this.upload = {}; this.headers = {}; }
    open(method, url, async) { this.method = method; this.responseURL = url; assert.equal(async, true); }
    setRequestHeader(name, value) { this.headers[name] = value; }
    getResponseHeader() { return null; }
    send(body) { this.body = body; requests.push(this); }
    abort() { this.aborted = true; this.onabort?.(); }
    progress(loaded) { this.upload.onprogress?.({ loaded, total: this.body.size, lengthComputable: true }); }
    sent() { this.upload.onload?.({ loaded: this.body.size }); }
    finish(value, status = 200) { this.status = status; this.responseText = JSON.stringify(value); this.onload?.(); }
    fail() { this.onerror?.(); }
  }
  globalThis.XMLHttpRequest = BrowserRequest;
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'XMLHttpRequest', previous);
    else delete globalThis.XMLHttpRequest;
  });
  return requests;
}

test('a small browser photo reports real intermediate bytes and waits for the verified final receipt', async (t) => {
  const requests = browserRequests(t);
  const file = photo(2000);
  const progress = [];
  let completed = false;
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    assert.equal(request.method, 'POST');
    return response(receipt(0, 'uploading', { token }));
  });
  const running = uploadPhoto(endpoint, { file, uploadId }, { ...options, onProgress: (event) => progress.push(event) })
    .then((result) => { completed = true; return result; });
  assert.equal(progress[0].phase, 'preparing');
  await flush();
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(request.headers['X-Upload-Token'], token);
  assert.equal(request.headers['X-Upload-Code'], undefined);
  assert.equal(request.withCredentials, false);
  request.progress(500);
  assert.deepEqual(progress.at(-1), { uploadedBytes: 0, sentBytes: 500, totalBytes: 2000, phase: 'uploading' });
  request.progress(1000);
  request.progress(750);
  assert.equal(progress.at(-1).sentBytes, 1000, 'Out-of-order browser events must not regress this attempt');
  request.sent();
  await flush();
  assert.deepEqual(progress.at(-1), { uploadedBytes: 0, sentBytes: 2000, totalBytes: 2000, phase: 'saving' });
  assert.equal(completed, false, 'Sending the body must never mean the photo is saved');
  request.finish(receipt(file.size, 'complete'));
  assert.deepEqual(await running, { ok: true, uploadId });
  assert.equal(progress.at(-1).uploadedBytes, file.size);
  assert.equal(progress.at(-1).phase, 'confirming');
});

test('browser byte progress is cumulative across chunks without changing acknowledged-byte accounting', async (t) => {
  const requests = browserRequests(t);
  const file = photo(chunkBytes + 1000);
  const progress = [];
  t.mock.method(globalThis, 'fetch', async () => response(receipt(0, 'uploading', { token })));
  const running = uploadPhoto(endpoint, { file, uploadId }, { ...options, onProgress: (event) => progress.push(event) });
  await flush();
  requests[0].progress(chunkBytes / 2);
  assert.equal(progress.at(-1).uploadedBytes, 0);
  assert.equal(progress.at(-1).sentBytes, chunkBytes / 2);
  requests[0].sent();
  requests[0].finish(receipt(chunkBytes));
  await flush();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].headers['Content-Range'], `bytes ${chunkBytes}-${file.size - 1}/${file.size}`);
  requests[1].progress(500);
  assert.equal(progress.at(-1).uploadedBytes, chunkBytes);
  assert.equal(progress.at(-1).sentBytes, chunkBytes + 500);
  requests[1].sent();
  requests[1].finish(receipt(file.size, 'complete'));
  await running;
  assert.equal(progress.at(-1).uploadedBytes, file.size);
});

test('a lost browser response probes the server and discards provisional bytes before retrying', async (t) => {
  const requests = browserRequests(t);
  const file = photo(2000);
  const progress = [];
  const methods = [];
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    methods.push(request.method);
    return response(request.method === 'POST' ? receipt(0, 'uploading', { token }) : receipt(0));
  });
  const running = uploadPhoto(endpoint, { file, uploadId }, { ...options, onProgress: (event) => progress.push(event) });
  await flush();
  requests[0].sent();
  assert.equal(progress.at(-1).sentBytes, file.size);
  requests[0].fail();
  await flush();
  assert.deepEqual(methods, ['POST', 'GET']);
  assert.equal(requests.length, 2);
  assert.ok(progress.some((event) => event.phase === 'retrying' && event.sentBytes === 0));
  assert.equal(progress.at(-1).sentBytes, 0);
  requests[1].progress(500);
  assert.equal(progress.at(-1).sentBytes, 500);
  requests[1].finish(receipt(file.size, 'complete'));
  await running;
});

test('a lost browser final response confirms saved bytes through GET without sending a duplicate chunk', async (t) => {
  const requests = browserRequests(t);
  const file = photo(2000);
  const methods = [];
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    methods.push(request.method);
    return response(request.method === 'POST' ? receipt(0, 'uploading', { token }) : receipt(file.size, 'complete'));
  });
  const running = uploadPhoto(endpoint, { file, uploadId }, options);
  await flush();
  requests[0].sent();
  requests[0].fail();
  assert.deepEqual(await running, { ok: true, uploadId });
  assert.deepEqual(methods, ['POST', 'GET']);
  assert.equal(requests.length, 1);
});

test('browser chunk deadlines abort the request and ignore late progress while checking saved status', async (t) => {
  const requests = browserRequests(t);
  const file = photo(2000);
  const progress = [];
  t.mock.method(globalThis, 'fetch', async (_url, request) => response(
    request.method === 'POST' ? receipt(0, 'uploading', { token }) : receipt(file.size, 'complete'),
  ));
  const running = uploadPhoto(endpoint, { file, uploadId }, {
    ...options, timeoutMs: 20, onProgress: (event) => progress.push(event),
  });
  await flush();
  const lateProgress = requests[0].upload.onprogress;
  assert.deepEqual(await running, { ok: true, uploadId });
  assert.equal(requests[0].aborted, true);
  const count = progress.length;
  lateProgress({ loaded: 1000 });
  assert.equal(progress.length, count);
  assert.equal(requests.length, 1);
});
