import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createDriveProvider } from '../src/drive-provider.mjs';
import { createUploadService } from '../src/upload-service.mjs';

const sessionUrl = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=private-session-token';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const empty = (status, headers) => new Response(null, { status, headers });

function providerFor(responses, options = {}) {
  const calls = [];
  let tokens = 0;
  const drive = createDriveProvider({
    auth: { getAccessToken: async () => ({ token: `server-access-token-${++tokens}` }) },
    fetchImpl: async (url, request) => {
      calls.push({ url, ...request });
      const next = responses.shift();
      if (!next) throw new Error('Unexpected Google request');
      return typeof next === 'function' ? next(url, request) : next;
    },
    ...options,
  });
  return { drive, calls };
}

test('generates a Drive file ID and refreshes server-only auth headers for each request', async () => {
  const { drive, calls } = providerFor([json({ ids: ['generated-file'] }), empty(404)]);
  assert.equal(await drive.generateFileId(), 'generated-file');
  assert.equal(await drive.getFile('generated-file'), null);
  assert.match(calls[0].url, /files\/generateIds\?count=1&space=drive&type=files$/);
  assert.equal(calls[0].headers.Authorization, 'Bearer server-access-token-1');
  assert.equal(calls[1].headers.Authorization, 'Bearer server-access-token-2');
  assert.ok(calls[1].url.includes('appProperties'));
  assert.equal(calls[0].redirect, 'manual');
  assert.ok(calls[0].signal instanceof AbortSignal);
});

test('starts a resumable create with the durable generated ID, parent and uploadId property', async () => {
  const { drive, calls } = providerFor([empty(200, { Location: sessionUrl })]);
  const upload = { fileId: 'file-1', uploadId: randomUUID(), name: 'photo.jpg', mimeType: 'image/jpeg', size: 7, folderId: 'folder-1', guestName: 'A guest' };
  assert.equal(await drive.createSession(upload), sessionUrl);
  const request = calls[0];
  assert.equal(request.method, 'POST');
  assert.equal(request.headers['X-Upload-Content-Type'], 'image/jpeg');
  assert.equal(request.headers['X-Upload-Content-Length'], '7');
  assert.deepEqual(JSON.parse(request.body), {
    id: 'file-1', name: 'photo.jpg', mimeType: 'image/jpeg', parents: ['folder-1'],
    appProperties: { uploadId: upload.uploadId }, description: 'Shared by A guest',
  });
});

test('folder repair updates only the known file’s parent relationship and preserves content', async () => {
  const { drive, calls } = providerFor([empty(200)]);
  await drive.moveFileToFolder({ fileId: 'known-upload', folderId: 'canonical-folder', currentParents: ['old-parent', 'old-parent'] });
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/drive/v3/files/known-upload');
  assert.equal(url.searchParams.get('addParents'), 'canonical-folder');
  assert.equal(url.searchParams.get('removeParents'), 'old-parent');
  assert.equal(url.searchParams.get('supportsAllDrives'), 'true');
  assert.equal(calls[0].method, 'PATCH');
  assert.equal(calls[0].body, '{}');
  assert.equal(url.searchParams.has('uploadType'), false);
});

test('a parentless upload can be attached without removing any unknown parent', async () => {
  const { drive, calls } = providerFor([empty(200)]);
  await drive.moveFileToFolder({ fileId: 'known-upload', folderId: 'destination', currentParents: [] });
  assert.equal(new URL(calls[0].url).searchParams.has('removeParents'), false);
});

test('invalid folder updates are rejected locally and Google permission errors stay private', async () => {
  const { drive, calls } = providerFor([json({ error: { message: 'private', errors: [{ reason: 'insufficientFilePermissions' }] } }, 403)]);
  for (const invalid of [
    { fileId: '../other', folderId: 'destination', currentParents: [] },
    { fileId: 'known-upload', folderId: 'bad/folder', currentParents: [] },
    { fileId: 'known-upload', folderId: 'destination', currentParents: ['bad/parent'] },
  ]) await assert.rejects(drive.moveFileToFolder(invalid), { status: 502 });
  assert.equal(calls.length, 0);
  await assert.rejects(drive.moveFileToFolder({ fileId: 'known-upload', folderId: 'destination', currentParents: ['old-parent'] }), (error) => {
    assert.equal(error.status, 403);
    assert.equal(error.diagnostics.operation, 'move_file');
    assert.equal(error.diagnostics.reason, 'insufficientFilePermissions');
    assert.equal(error.message.includes('private'), false);
    return true;
  });
});

test('zero-byte status PUT normalizes308 Range and missing Range to received bytes', async () => {
  const { drive, calls } = providerFor([empty(308, { Range: 'bytes=0-4194303' }), empty(308)]);
  assert.deepEqual(await drive.querySession(sessionUrl, 5000000), { status: 'uploading', uploadedBytes: 4194304 });
  assert.deepEqual(await drive.querySession(sessionUrl, 5000000), { status: 'uploading', uploadedBytes: 0 });
  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].body.length, 0);
  assert.equal(calls[0].headers['Content-Length'], '0');
  assert.equal(calls[0].headers['Content-Range'], 'bytes */5000000');
});

test('binary chunk preserves content and normalizes final Google201 to a completed progress result', async () => {
  const { drive, calls } = providerFor([empty(308, { Range: 'bytes=0-16' }), json({ id: 'file-1' }, 201)]);
  const bytes = Buffer.from('abcdefg');
  assert.deepEqual(await drive.putChunk(sessionUrl, { start: 10, end: 16, total: 24 }, bytes), { status: 'uploading', uploadedBytes: 17 });
  assert.deepEqual(await drive.putChunk(sessionUrl, { start: 17, end: 23, total: 24 }, bytes), { status: 'complete', uploadedBytes: 24 });
  assert.equal(calls[0].headers['Content-Range'], 'bytes 10-16/24');
  assert.equal(calls[0].headers['Content-Type'], 'application/octet-stream');
  assert.equal(calls[0].body, bytes);
});

test('both404 and410 Google session responses signal expiration without treating it as completion', async () => {
  const { drive } = providerFor([empty(404), empty(410)]);
  assert.deepEqual(await drive.querySession(sessionUrl, 7), { status: 'expired', uploadedBytes: 0 });
  assert.deepEqual(await drive.putChunk(sessionUrl, { start: 0, end: 6, total: 7 }, Buffer.alloc(7)), { status: 'expired', uploadedBytes: 0 });
});

test('rejects malformed offsets, excessive Google JSON, and unsafe session URLs', async () => {
  for (const range of ['bytes=10-100', 'bytes=0-100', 'not a range']) {
    const { drive } = providerFor([empty(308, { Range: range })]);
    await assert.rejects(drive.querySession(sessionUrl, 7), { status: 502 });
  }
  const { drive: oversized } = providerFor([new Response('x'.repeat(65537))]);
  await assert.rejects(oversized.generateFileId(), { status: 502 });
  const { drive, calls } = providerFor([]);
  for (const url of [
    'https://evil.example/upload/drive/v3/files?upload_id=secret',
    'http://www.googleapis.com/upload/drive/v3/files?upload_id=secret',
    'https://www.googleapis.com/other?upload_id=secret',
    'https://www.googleapis.com/upload/drive/v3/files',
  ]) await assert.rejects(drive.querySession(url, 7), { status: 502 });
  assert.equal(calls.length, 0);
});

test('translates quota403 into429 and preserves409 to enable generated-ID recovery', async () => {
  const { drive } = providerFor([
    json({ error: { errors: [{ reason: 'userRateLimitExceeded' }] } }, 403), empty(409),
  ]);
  await assert.rejects(drive.generateFileId(), { status: 429 });
  await assert.rejects(drive.createSession({ fileId: 'file-1', folderId: 'folder-1' }), { status: 409 });
});

test('auth refresh and Google HTTP operations have bounded timeouts', async () => {
  const { drive: authStall } = providerFor([], {
    timeoutMs: 5,
    auth: { getAccessToken: () => new Promise(() => {}) },
  });
  await assert.rejects(authStall.generateFileId(), { status: 503 });
  const { drive: networkStall } = providerFor([], {
    timeoutMs: 5,
    fetchImpl: (_url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  });
  const keepAlive = setTimeout(() => {}, 100);
  try { await assert.rejects(networkStall.generateFileId(), { status: 503 }); }
  finally { clearTimeout(keepAlive); }
});

test('real provider + domain confirms final metadata and does not expose session URL or Google tokens', async () => {
  const uploadId = randomUUID();
  const file = { id: 'file-1', size: '7', mimeType: 'image/jpeg', parents: ['folder-1'], appProperties: { uploadId } };
  const { drive, calls } = providerFor([
    json({ ids: ['file-1'] }), empty(404), empty(200, { Location: sessionUrl }),
    empty(308), json({ id: 'file-1' }, 201), json(file),
  ]);
  const records = new Map();
  const repository = {
    async transaction(id, mutate) {
      const result = mutate(records.get(id) || null);
      if (result.record !== undefined) records.set(id, result.record);
      return result.value;
    },
  };
  const service = createUploadService({ repository, drive, folderId: 'folder-1', uploadCode: 'guest-code', tokenSecret: 'a-token-secret-longer-than-32-characters' });
  const init = await service.initialize({ uploadId, name: 'photo.jpg', mimeType: 'image/jpeg', size: 7 }, 'guest-code');
  const beforeBytes = await service.status(uploadId, init.token);
  assert.equal(beforeBytes.status, 'uploading');
  assert.equal(beforeBytes.uploadedBytes, 0);
  const receipt = await service.putChunk(uploadId, init.token, { start: 0, end: 6, total: 7 }, Buffer.alloc(7));
  assert.equal(receipt.status, 'complete');
  assert.equal(calls.length, 6);
  assert.equal(calls[3].method, 'PUT');
  assert.equal(calls[3].headers['Content-Range'], 'bytes */7');
  assert.equal(calls[4].headers['Content-Range'], 'bytes 0-6/7');
  assert.ok(calls[5].url.startsWith('https://www.googleapis.com/drive/v3/files/file-1?'));
  assert.doesNotMatch(JSON.stringify([init, receipt]), /private-session-token|server-access-token|www.googleapis.com|file-1/);
});

test('a Google success body cannot substitute for independent final metadata verification', async () => {
  const uploadId = randomUUID();
  const { drive } = providerFor([
    json({ ids: ['file-1'] }), empty(404), empty(200, { Location: sessionUrl }),
    json({ id: 'file-1', size: '7' }, 201),
    json({ id: 'file-1', size: '7', mimeType: 'image/jpeg', parents: ['wrong-parent'], appProperties: { uploadId } }),
  ]);
  const records = new Map();
  const service = createUploadService({
    drive, folderId: 'folder-1', uploadCode: 'guest-code', tokenSecret: 'a-token-secret-longer-than-32-characters',
    repository: { async transaction(id, mutate) {
      const result = mutate(records.get(id) || null);
      if (result.record !== undefined) records.set(id, result.record);
      return result.value;
    } },
  });
  const init = await service.initialize({ uploadId, name: 'photo.jpg', mimeType: 'image/jpeg', size: 7 }, 'guest-code');
  await assert.rejects(service.putChunk(uploadId, init.token, { start: 0, end: 6, total: 7 }, Buffer.alloc(7)), { status: 503, retryable: true });
  assert.equal(records.get(uploadId).status, 'uploading');
});
