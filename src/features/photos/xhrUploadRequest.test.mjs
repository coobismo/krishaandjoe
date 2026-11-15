import assert from 'node:assert/strict';
import test from 'node:test';
import { xhrUploadRequest } from './xhrUploadRequest.mjs';

const url = 'https://uploads.example/v1/uploads/test-id';
const body = new Blob(['0123456789']);

function fakeRequests(t) {
  const requests = [];
  const previous = globalThis.XMLHttpRequest;
  class FakeXMLHttpRequest {
    constructor() {
      this.upload = {};
      this.headers = {};
      this.responseHeaders = {};
      requests.push(this);
    }
    open(method, target, async) { this.method = method; this.url = target; this.async = async; }
    setRequestHeader(name, value) { this.headers[name] = value; }
    getResponseHeader(name) { return this.responseHeaders[name.toLowerCase()] ?? null; }
    send(value) { this.body = value; this.sent = true; }
    abort() { this.aborted = true; this.onabort?.(); }
    respond({ status = 200, text = '{"ok":true}', responseURL = this.url, retryAfter } = {}) {
      this.status = status;
      this.responseText = text;
      this.responseURL = responseURL;
      this.responseHeaders['retry-after'] = retryAfter ?? null;
      this.onload?.();
    }
  }
  globalThis.XMLHttpRequest = FakeXMLHttpRequest;
  t.after(() => {
    if (previous === undefined) delete globalThis.XMLHttpRequest;
    else globalThis.XMLHttpRequest = previous;
  });
  return requests;
}

function assertClean(request) {
  for (const name of ['onload', 'onerror', 'onabort', 'ontimeout']) assert.equal(request[name], null);
  assert.equal(request.upload.onprogress, null);
  assert.equal(request.upload.onload, null);
}

test('browser chunk progress reports real sent bytes without completing before a response', async (t) => {
  const requests = fakeRequests(t);
  const controller = new AbortController();
  const progress = [];
  let finished = false;
  const running = xhrUploadRequest(url, {
    body, signal: controller.signal, headers: { 'Content-Type': 'application/octet-stream', 'X-Upload-Token': 'private-token' },
    onUploadProgress: (bytes) => progress.push(bytes),
  }).then((response) => { finished = true; return response; });
  const request = requests[0];
  assert.equal(request.method, 'PUT');
  assert.equal(request.async, true);
  assert.equal(request.withCredentials, false);
  assert.equal(request.headers['X-Upload-Token'], 'private-token');
  assert.equal(request.body, body);
  request.upload.onprogress({ loaded: 2, lengthComputable: true });
  request.upload.onprogress({ loaded: 7, lengthComputable: false });
  for (const loaded of [-1, NaN, 1.5]) request.upload.onprogress({ loaded });
  request.upload.onload({ loaded: 0 });
  await Promise.resolve();
  assert.deepEqual(progress, [2, 7, 10]);
  assert.equal(finished, false, 'Finishing the body transfer is not a saved-file receipt');
  request.respond();
  const response = await running;
  assert.equal(response.ok, true);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assertClean(request);
  controller.abort();
  assert.equal(request.aborted, undefined, 'A completed request removes its abort listener');
});

test('HTTP errors preserve status, body and Retry-After for the caller to classify safely', async (t) => {
  const requests = fakeRequests(t);
  const running = xhrUploadRequest(url, { body });
  requests[0].respond({ status: 503, text: '{"ok":false,"retryable":true}', retryAfter: '2' });
  const response = await running;
  requests[0].responseText = 'private changed response';
  requests[0].responseHeaders['retry-after'] = '99';
  assert.equal(response.ok, false);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '2');
  assert.equal(response.headers.get('Retry-After'), '2');
  assert.equal(response.headers.get('Authorization'), null);
  assert.deepEqual(await response.json(), { ok: false, retryable: true });
  assertClean(requests[0]);
});

test('progress callbacks cannot fail uploads and late events cannot report after settlement', async (t) => {
  const requests = fakeRequests(t);
  let reports = 0;
  const running = xhrUploadRequest(url, {
    body, onUploadProgress: () => { reports += 1; throw new Error('private callback details'); },
  });
  const request = requests[0];
  const lateProgress = request.upload.onprogress;
  const lateUpload = request.upload.onload;
  const lateError = request.onerror;
  request.upload.onprogress({ loaded: 3 });
  request.respond();
  assert.equal((await running).ok, true);
  lateProgress({ loaded: 8 });
  lateUpload({ loaded: 10 });
  lateError();
  assert.equal(reports, 1);
  assertClean(request);
});

test('network and native timeout failures are private and leave no event handlers', async (t) => {
  const requests = fakeRequests(t);
  for (const event of ['onerror', 'ontimeout']) {
    const running = xhrUploadRequest(url, { body });
    const request = requests.at(-1);
    request[event]({ message: 'private-token https://private.example' });
    await assert.rejects(running, (error) => {
      assert.equal(error.name, 'TypeError');
      assert.doesNotMatch(error.message, /private-token|private\.example/);
      return true;
    });
    assertClean(request);
  }
});

test('abort signals cancel an active request and reject before constructing an already aborted request', async (t) => {
  const requests = fakeRequests(t);
  const controller = new AbortController();
  const running = xhrUploadRequest(url, { body, signal: controller.signal });
  const request = requests[0];
  controller.abort();
  await assert.rejects(running, { name: 'AbortError' });
  assert.equal(request.aborted, true);
  assertClean(request);
  await assert.rejects(xhrUploadRequest(url, { body, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(requests.length, 1);
});

test('native abort rejects safely and redirects or missing/invalid response URLs are not accepted', async (t) => {
  const requests = fakeRequests(t);
  const abortedRequest = xhrUploadRequest(url, { body });
  requests[0].onabort();
  await assert.rejects(abortedRequest, { name: 'AbortError' });
  assertClean(requests[0]);
  for (const responseURL of ['https://attacker.example/v1/uploads/test-id', `${url}/other`, '', 'invalid']) {
    const running = xhrUploadRequest(url, { body });
    const request = requests.at(-1);
    request.respond({ responseURL });
    await assert.rejects(running, TypeError);
    assertClean(request);
  }
});

test('invalid HTTP status and malformed JSON cannot become a valid response receipt', async (t) => {
  const requests = fakeRequests(t);
  for (const status of [0, 101, 999, NaN]) {
    const running = xhrUploadRequest(url, { body });
    requests.at(-1).respond({ status });
    await assert.rejects(running, TypeError);
    assertClean(requests.at(-1));
  }
  const running = xhrUploadRequest(url, { body });
  requests.at(-1).respond({ text: '<html>Not a receipt</html>' });
  const response = await running;
  await assert.rejects(response.json(), SyntaxError);
});
