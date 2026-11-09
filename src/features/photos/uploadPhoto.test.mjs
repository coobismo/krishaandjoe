import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_FILE_BYTES, MAX_FILES, ACCEPTED_FILES, getPhotoMimeType, validatePhoto,
  formatFileSize, isUploadEndpoint, uploadPhoto, RESUMABLE_MAX_FILE_BYTES, getUploadLimits,
} from './uploadPhoto.mjs';

const endpoint = 'https://script.google.com/macros/s/deployment-123/exec';
const file = { name: 'wedding.jpg', type: 'image/jpeg', size: 3 };
const uploadId = 'baad6106-995a-4b81-926b-632648c02284';

function mockReader(t, { stalled = false, broken = false } = {}) {
  let aborted = false;
  const OriginalReader = globalThis.FileReader;
  class FakeReader {
    readAsDataURL() {
      if (stalled) return;
      queueMicrotask(() => {
        if (broken) this.onerror?.();
        else {
          this.result = 'data:image/jpeg;base64,YWJj';
          this.onload?.();
        }
      });
    }
    abort() { aborted = true; this.onabort?.(); }
  }
  globalThis.FileReader = FakeReader;
  t.after(() => {
    if (OriginalReader === undefined) delete globalThis.FileReader;
    else globalThis.FileReader = OriginalReader;
  });
  return () => aborted;
}

test('supports common camera formats without trusting a conflicting MIME type', () => {
  assert.equal(MAX_FILES, 20);
  assert.match(ACCEPTED_FILES, /\.heic/);
  assert.match(ACCEPTED_FILES, /\.mov/);
  assert.equal(getPhotoMimeType({ name: 'IMG.HEIC', type: '' }), 'image/heic');
  assert.equal(getPhotoMimeType({ name: 'clip.MOV', type: 'application/octet-stream' }), 'video/quicktime');
  assert.equal(getPhotoMimeType({ name: 'photo.jpg', type: 'text/html' }), '');
  assert.equal(getPhotoMimeType({ name: 'other.svg', type: 'image/svg+xml' }), '');
  assert.equal(getPhotoMimeType({ name: 'image.jpg', type: 'IMAGE/JPEG' }), 'image/jpeg');
  assert.equal(getPhotoMimeType({ name: 'constructor', type: '' }), '');
  assert.equal(getPhotoMimeType({ name: 'heic', type: '' }), '');
});

test('rejects empty, oversized, and unsupported files and accepts the size boundary', () => {
  assert.match(validatePhoto({ ...file, size: 0 }), /empty/);
  assert.match(validatePhoto({ ...file, size: MAX_FILE_BYTES + 1 }), /20 MB/);
  assert.match(validatePhoto({ ...file, type: 'text/html' }), /supported/);
  assert.equal(validatePhoto({ ...file, size: MAX_FILE_BYTES }), '');
  assert.equal(formatFileSize(0), '0 B');
  assert.equal(formatFileSize(512), '512 B');
  assert.equal(formatFileSize(2048), '2 KB');
  assert.equal(formatFileSize(MAX_FILE_BYTES), '20.0 MB');
});

test('only accepts production Google Apps Script web app URLs', () => {
  assert.equal(isUploadEndpoint(endpoint), true);
  for (const bad of ['', undefined, 'https://example.com/exec', endpoint.replace('/exec', '/dev'),
    endpoint.replace('https:', 'http:'), `${endpoint}?callback=test`,
    endpoint.replace('script.google.com', 'script.google.com.attacker.test'),
    endpoint.replace('script.google.com', 'user:password@script.google.com')]) {
    assert.equal(isUploadEndpoint(bad), false, String(bad));
  }
});

test('posts the original file with a readable receipt and follows the Apps Script redirect', async (t) => {
  mockReader(t);
  let options;
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    assert.equal(url, endpoint);
    options = request;
    return { ok: true, json: async () => ({ ok: true, uploadId }) };
  });
  const receipt = await uploadPhoto(endpoint, { file, uploadId, guestName: 'Joe' });
  assert.deepEqual(receipt, { ok: true, uploadId });
  assert.equal(options.mode, 'cors');
  assert.equal(options.redirect, 'follow');
  assert.equal(options.credentials, 'omit');
  assert.equal(options.method, 'POST');
  assert.equal(options.headers['Content-Type'], 'text/plain;charset=utf-8');
  assert.deepEqual(JSON.parse(options.body), {
    uploadId, name: file.name, mimeType: 'image/jpeg', data: 'YWJj', guestName: 'Joe',
  });
  assert.equal(options.signal.aborted, false);
});

test('rejects unreadable responses and receipts that cannot confirm this exact upload', async (t) => {
  mockReader(t);
  const replies = [
    { ok: false },
    { ok: true, type: 'opaque' },
    { ok: true, json: async () => ({ ok: true, uploadId: 'someone-else' }) },
    { ok: true, json: async () => ({ ok: 'true', uploadId }) },
    { ok: true, json: async () => ({}) },
    { ok: true, json: async () => { throw new SyntaxError('HTML response'); } },
  ];
  const mock = t.mock.method(globalThis, 'fetch', async () => replies.shift());
  for (let index = 0; index < 6; index += 1) {
    await assert.rejects(uploadPhoto(endpoint, { file, uploadId }), /could not confirm.*will not create a duplicate/);
  }
  assert.equal(mock.mock.callCount(), 6);
});

test('shows explicit server rejection without marking the file uploaded', async (t) => {
  mockReader(t);
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true, json: async () => ({ ok: false, error: 'The upload folder is unavailable.' }),
  }));
  await assert.rejects(uploadPhoto(endpoint, { file, uploadId }), /folder is unavailable/);
});

test('network errors remain unconfirmed and retryable', async (t) => {
  mockReader(t);
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(uploadPhoto(endpoint, { file, uploadId }), /could not confirm.*try again/);
});

test('times out a stalled file reader and aborts its work', async (t) => {
  const wasAborted = mockReader(t, { stalled: true });
  const mock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not send'); });
  await assert.rejects(uploadPhoto(endpoint, { file, uploadId }, { timeoutMs: 5 }), /could not confirm/);
  assert.equal(wasAborted(), true);
  assert.equal(mock.mock.callCount(), 0);
});

test('timeout also covers a stalled response body', async (t) => {
  mockReader(t);
  let signal;
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    signal = request.signal;
    return { ok: true, json: () => new Promise(() => {}) };
  });
  await assert.rejects(uploadPhoto(endpoint, { file, uploadId }, { timeoutMs: 5 }), /could not confirm/);
  assert.equal(signal.aborted, true);
});

test('clears the timeout after a confirmed response', async (t) => {
  mockReader(t);
  let signal;
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    signal = request.signal;
    return { ok: true, json: async () => ({ ok: true, uploadId }) };
  });
  await uploadPhoto(endpoint, { file, uploadId }, { timeoutMs: 5 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(signal.aborted, false);
});

test('rejects invalid configuration and files before any upload starts', async (t) => {
  const mock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not send'); });
  await assert.rejects(uploadPhoto('', { file, uploadId }), /not connected/);
  await assert.rejects(uploadPhoto(endpoint, { file: { ...file, size: 0 }, uploadId }), /empty/);
  assert.equal(mock.mock.callCount(), 0);
});

test('file read failures do not send a request', async (t) => {
  mockReader(t, { broken: true });
  const mock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not send'); });
  await assert.rejects(uploadPhoto(endpoint, { file, uploadId }), /could not read/);
  assert.equal(mock.mock.callCount(), 0);
});

const cloudEndpoint = 'https://wedding-uploader.example/api';
const chunkBytes = 4 * 1024 * 1024;
const cloudOptions = { provider: 'cloud-run', uploadCode: 'guest-code', retryBaseMs: 0 };
const token = 'private-session-capability';

function makeVideo(size = 3) {
  return Object.assign(new Blob([new Uint8Array(size)], { type: 'video/mp4' }), { name: 'wedding.mp4' });
}

function cloudReceipt(uploadedBytes, status = 'uploading', extra = {}) {
  return { ok: true, uploadId, status, uploadedBytes, chunkBytes, ...extra };
}

function cloudResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

test('Cloud Run accepts configurable HTTPS bases and local development only over HTTP', () => {
  for (const url of [cloudEndpoint, `${cloudEndpoint}/`, 'http://localhost:8080', 'http://127.0.0.1:8080', 'http://[::1]:8080']) {
    assert.equal(isUploadEndpoint(url, 'cloud-run'), true, url);
  }
  for (const url of ['http://uploader.example', 'http://localhost.attacker.test:8080', `${cloudEndpoint}?key=value`,
    `${cloudEndpoint}#fragment`, 'https://code:secret@uploader.example', 'javascript:alert(1)', '']) {
    assert.equal(isUploadEndpoint(url, 'cloud-run'), false, url);
  }
  assert.equal(isUploadEndpoint(cloudEndpoint, 'unknown'), false);
  assert.deepEqual(getUploadLimits('cloud-run'), { maxFileBytes: RESUMABLE_MAX_FILE_BYTES, maxFiles: 20 });
  assert.deepEqual(getUploadLimits(), { maxFileBytes: MAX_FILE_BYTES, maxFiles: 20 });
  assert.equal(validatePhoto({ ...file, size: RESUMABLE_MAX_FILE_BYTES }, RESUMABLE_MAX_FILE_BYTES), '');
  assert.match(validatePhoto({ ...file, size: RESUMABLE_MAX_FILE_BYTES + 1 }, RESUMABLE_MAX_FILE_BYTES), /500 MB/);
});

test('Cloud Run uploads binary slices and reports only acknowledged byte progress', async (t) => {
  const video = makeVideo(chunkBytes + 7);
  const calls = [];
  const progress = [];
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    calls.push({ url, ...request });
    if (request.method === 'POST') return cloudResponse(cloudReceipt(0, 'uploading', { token }));
    if (calls.length === 2) return cloudResponse(cloudReceipt(chunkBytes));
    return cloudResponse(cloudReceipt(video.size, 'complete'));
  });
  assert.deepEqual(await uploadPhoto(`${cloudEndpoint}/`, { file: video, uploadId, guestName: 'Joe' }, {
    ...cloudOptions, onProgress: (event) => progress.push(event),
  }), { ok: true, uploadId });
  assert.equal(calls[0].url, `${cloudEndpoint}/v1/uploads`);
  assert.deepEqual(JSON.parse(calls[0].body), {
    uploadId, name: video.name, mimeType: 'video/mp4', size: video.size, guestName: 'Joe',
  });
  assert.equal(calls[0].headers['X-Upload-Code'], 'guest-code');
  assert.equal(calls[1].headers['X-Upload-Code'], undefined);
  assert.equal(calls[1].headers['X-Upload-Token'], token);
  assert.equal(calls[1].headers['Content-Range'], `bytes 0-${chunkBytes - 1}/${video.size}`);
  assert.equal(calls[1].body.size, chunkBytes);
  assert.equal(calls[2].headers['Content-Range'], `bytes ${chunkBytes}-${video.size - 1}/${video.size}`);
  assert.equal(calls[2].body.size, 7);
  assert.equal(calls[1].headers['Content-Type'], 'application/octet-stream');
  assert.ok(calls.every((call) => call.credentials === 'omit' && call.redirect === 'error' && call.mode === 'cors'));
  assert.deepEqual(progress.map((event) => event.uploadedBytes), [0, chunkBytes, video.size]);
  assert.equal(progress.at(-1).phase, 'confirming');
  assert.ok(progress.every((event) => event.totalBytes === video.size));
});

test('manual retry reinitializes the same ID and resumes from the server offset', async (t) => {
  const video = makeVideo(chunkBytes + 5);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    calls.push(request);
    if (request.method === 'POST') return cloudResponse(cloudReceipt(chunkBytes, 'uploading', { token }));
    return cloudResponse(cloudReceipt(video.size, 'complete'));
  });
  await uploadPhoto(cloudEndpoint, { file: video, uploadId }, cloudOptions);
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(calls[0].body).uploadId, uploadId);
  assert.equal(calls[1].headers['Content-Range'], `bytes ${chunkBytes}-${video.size - 1}/${video.size}`);
  assert.equal(calls[1].body.size, 5);
});

test('a lost final response is confirmed with GET before any resend', async (t) => {
  const video = makeVideo();
  const methods = [];
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    methods.push(request.method);
    if (request.method === 'POST') return cloudResponse(cloudReceipt(0, 'uploading', { token }));
    if (request.method === 'PUT') throw new TypeError('Connection lost after Drive accepted the bytes');
    assert.equal(request.headers['X-Upload-Token'], token);
    return cloudResponse(cloudReceipt(video.size, 'complete'));
  });
  assert.deepEqual(await uploadPhoto(cloudEndpoint, { file: video, uploadId }, cloudOptions), { ok: true, uploadId });
  assert.deepEqual(methods, ['POST', 'PUT', 'GET']);
});

test('an offset conflict probes the server and continues after a partially accepted chunk', async (t) => {
  const video = makeVideo(chunkBytes + 9);
  const partialOffset = 12345;
  const methods = [];
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    methods.push(request.method);
    if (request.method === 'POST') return cloudResponse(cloudReceipt(0, 'uploading', { token }));
    if (methods.length === 2) return cloudResponse({ ok: false, error: 'offset conflict', retryable: true }, 409);
    if (request.method === 'GET') return cloudResponse(cloudReceipt(partialOffset));
    assert.equal(request.headers['Content-Range'], `bytes ${partialOffset}-${video.size - 1}/${video.size}`);
    return cloudResponse(cloudReceipt(video.size, 'complete'));
  });
  await uploadPhoto(cloudEndpoint, { file: video, uploadId }, cloudOptions);
  assert.deepEqual(methods, ['POST', 'PUT', 'GET', 'PUT']);
});

test('an expired Drive session can reset its offset without creating a new upload ID', async (t) => {
  const video = makeVideo(chunkBytes + 2);
  const progress = [];
  const ranges = [];
  let puts = 0;
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    if (request.method === 'POST') return cloudResponse(cloudReceipt(chunkBytes, 'uploading', { token }));
    if (request.method === 'GET') return cloudResponse(cloudReceipt(0));
    ranges.push(request.headers['Content-Range']);
    puts += 1;
    if (puts === 1) return cloudResponse({ ok: false, retryable: true }, 409);
    return cloudResponse(cloudReceipt(puts === 2 ? chunkBytes : video.size, puts === 2 ? 'uploading' : 'complete'));
  });
  await uploadPhoto(cloudEndpoint, { file: video, uploadId }, {
    ...cloudOptions, onProgress: (event) => progress.push(event.uploadedBytes),
  });
  assert.deepEqual(ranges, [
    `bytes ${chunkBytes}-${video.size - 1}/${video.size}`,
    `bytes 0-${chunkBytes - 1}/${video.size}`,
    `bytes ${chunkBytes}-${video.size - 1}/${video.size}`,
  ]);
  assert.ok(progress.includes(0));
});

test('transient server failures are retried a bounded number of times', async (t) => {
  const video = makeVideo();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return cloudResponse({ ok: false, retryable: true }, 503, { 'Retry-After': '0' });
  });
  await assert.rejects(uploadPhoto(cloudEndpoint, { file: video, uploadId }, cloudOptions), /could not confirm/);
  assert.equal(calls, 4);
});

test('repeated failed final chunks probe before retrying and stop after three retries', async (t) => {
  const video = makeVideo();
  const methods = [];
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    methods.push(request.method);
    if (request.method === 'POST') return cloudResponse(cloudReceipt(0, 'uploading', { token }));
    if (request.method === 'GET') return cloudResponse(cloudReceipt(0));
    return cloudResponse({ ok: false, retryable: true }, 503);
  });
  await assert.rejects(uploadPhoto(cloudEndpoint, { file: video, uploadId }, cloudOptions), /could not confirm/);
  assert.deepEqual(methods, ['POST', 'PUT', 'GET', 'PUT', 'GET', 'PUT', 'GET', 'PUT', 'GET']);
});

test('server rejections do not expose echoed upload codes or capability tokens', async (t) => {
  const video = makeVideo();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return cloudResponse({ ok: false, error: `bad guest-code ${token}`, retryable: false }, 401);
  });
  await assert.rejects(uploadPhoto(cloudEndpoint, { file: video, uploadId }, cloudOptions), (error) => {
    assert.match(error.message, /not accepted/);
    assert.ok(!error.message.includes('guest-code') && !error.message.includes(token));
    return true;
  });
  assert.equal(calls, 1);
});

test('Cloud Run rejects premature completion and mismatched upload receipts', async (t) => {
  const video = makeVideo();
  for (const badReceipt of [
    cloudReceipt(1, 'complete', { token }),
    cloudReceipt(0, 'uploading', { token, uploadId: 'different-upload' }),
    cloudReceipt(video.size + 1, 'complete', { token }),
    cloudReceipt(0, 'uploading', { token, chunkBytes: 5 * 1024 * 1024 }),
  ]) {
    const mock = t.mock.method(globalThis, 'fetch', async () => cloudResponse(badReceipt));
    await assert.rejects(uploadPhoto(cloudEndpoint, { file: video, uploadId }, { ...cloudOptions, maxRetries: 0 }), /could not confirm/);
    assert.equal(mock.mock.callCount(), 1);
    mock.mock.restore();
  }
});

test('a completed session returns without reading or resending any file data', async (t) => {
  const video = makeVideo();
  const mock = t.mock.method(globalThis, 'fetch', async () => cloudResponse(cloudReceipt(video.size, 'complete', { token })));
  await uploadPhoto(cloudEndpoint, { file: video, uploadId }, {
    ...cloudOptions, onProgress: () => { throw new Error('unrelated UI failure'); },
  });
  assert.equal(mock.mock.callCount(), 1);
});

test('Cloud Run deadlines abort stalled requests and clear successful request timers', async (t) => {
  const video = makeVideo();
  let signal;
  const mock = t.mock.method(globalThis, 'fetch', async (url, request) => {
    signal = request.signal;
    return new Promise(() => {});
  });
  await assert.rejects(uploadPhoto(cloudEndpoint, { file: video, uploadId }, {
    ...cloudOptions, maxRetries: 0, timeoutMs: 5,
  }), /could not confirm/);
  assert.equal(signal.aborted, true);
  mock.mock.restore();
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    signal = request.signal;
    return cloudResponse(cloudReceipt(video.size, 'complete', { token }));
  });
  await uploadPhoto(cloudEndpoint, { file: video, uploadId }, { ...cloudOptions, timeoutMs: 5 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(signal.aborted, false);
});

test('Cloud Run respects Retry-After before retrying a rate-limited request', async (t) => {
  const video = makeVideo();
  const nativeSetTimeout = globalThis.setTimeout;
  const delays = [];
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    delays.push(delay);
    return nativeSetTimeout(callback, delay === 5000 ? 0 : delay, ...args);
  });
  let attempts = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    attempts += 1;
    return attempts === 1
      ? cloudResponse({ ok: false, retryable: true }, 429, { 'Retry-After': '5' })
      : cloudResponse(cloudReceipt(video.size, 'complete', { token }));
  });
  await uploadPhoto(cloudEndpoint, { file: video, uploadId }, cloudOptions);
  assert.equal(attempts, 2);
  assert.ok(delays.includes(5000));
});

test('repeated Drive session resets cannot restart the file forever', async (t) => {
  const video = makeVideo(chunkBytes + 1);
  let puts = 0;
  let resets = 0;
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    if (request.method === 'POST') return cloudResponse(cloudReceipt(0, 'uploading', { token }));
    if (request.method === 'GET') {
      resets += 1;
      return cloudResponse(cloudReceipt(0));
    }
    puts += 1;
    return puts % 2 === 1
      ? cloudResponse(cloudReceipt(chunkBytes))
      : cloudResponse({ ok: false, retryable: true }, 503);
  });
  await assert.rejects(uploadPhoto(cloudEndpoint, { file: video, uploadId }, {
    ...cloudOptions, maxRetries: 1,
  }), /could not confirm/);
  assert.equal(puts, 4);
  assert.equal(resets, 2);
});
