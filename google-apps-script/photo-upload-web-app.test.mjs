import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('./photo-upload-web-app.gs', import.meta.url), 'utf8');
const uploadId = 'a102f2de-6db9-4cb1-9b78-147a4510c759';
const validUpload = () => ({
  uploadId,
  name: 'celebration.jpg',
  mimeType: 'image/jpeg',
  data: Buffer.from('a wedding photo').toString('base64'),
  guestName: 'A guest',
});

function server(options = {}) {
  const calls = { decode: 0, create: 0, folder: 0, release: 0, names: [] };
  const files = new Map();
  const folder = {
    getFilesByName(name) {
      calls.names.push(name);
      const file = files.get(name);
      return { hasNext: () => Boolean(file), next: () => file };
    },
    createFile(blob) {
      calls.create += 1;
      if (options.createError) throw new Error('Private Google Drive account information');
      const file = {
        getSize: () => options.wrongSize ? 0 : blob.bytes.length,
        getMimeType: () => options.wrongType ? 'text/html' : blob.mimeType,
        isTrashed: () => Boolean(options.trashed),
        setDescription(description) { this.description = description; },
      };
      files.set(blob.name, file);
      return file;
    },
  };
  const context = vm.createContext({
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: () => options.folderId === undefined ? 'private-folder-id' : options.folderId }),
    },
    Utilities: {
      base64Decode(data) {
        calls.decode += 1;
        return options.decodedBytes || [...Buffer.from(data, 'base64')];
      },
      newBlob: (bytes, mimeType, name) => ({ bytes, mimeType, name }),
    },
    DriveApp: {
      getFolderById() {
        calls.folder += 1;
        if (options.folderError) throw new Error('Private folder ID and credential details');
        return folder;
      },
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => options.busy !== true,
        releaseLock() { calls.release += 1; },
      }),
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (text) => ({ setMimeType: () => JSON.parse(text) }),
    },
  });
  vm.runInContext(source, context);
  return { calls, files, post: (body) => context.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } }) };
}

test('creates one private file and acknowledges the exact upload ID', () => {
  const api = server();
  const result = api.post(validUpload());
  assert.deepEqual(result, { ok: true, uploadId });
  assert.equal(api.calls.create, 1);
  assert.equal(api.calls.release, 1);
  assert.equal(api.files.get(`${uploadId}_celebration.jpg`).description, 'Shared by A guest');
  assert.deepEqual(Object.keys(result).sort(), ['ok', 'uploadId']);
});

test('retrying the same ID and file returns success without creating a duplicate', () => {
  const api = server();
  assert.equal(api.post(validUpload()).ok, true);
  assert.equal(api.post(validUpload()).ok, true);
  assert.equal(api.calls.create, 1);
  assert.equal(api.calls.release, 2);
});

test('sanitizes path components and control characters in filenames and guest names', () => {
  const api = server();
  assert.equal(api.post({ ...validUpload(), name: '../photos/..a:<b>\u0000.jpg', guestName: '  A\nGuest  ' }).ok, true);
  const file = api.files.get(`${uploadId}_a__b__.jpg`);
  assert.ok(file);
  assert.equal(file.description, 'Shared by AGuest');
});

test('rejects malformed requests before decoding or accessing Drive', () => {
  const invalid = [
    'not JSON', null, [], {},
    { ...validUpload(), uploadId: 'anything' },
    { ...validUpload(), name: '' },
    { ...validUpload(), name: 'x'.repeat(256) },
    { ...validUpload(), mimeType: 'text/html' },
    { ...validUpload(), mimeType: 'image/svg+xml' },
    { ...validUpload(), guestName: {} },
    { ...validUpload(), guestName: 'x'.repeat(121) },
    { ...validUpload(), data: 'data:image/jpeg;base64,YQ==' },
    { ...validUpload(), data: 'YQ=' },
    { ...validUpload(), data: 'Y=Q=' },
    { ...validUpload(), data: 'a===' },
    { ...validUpload(), data: '' },
  ];
  for (const payload of invalid) {
    const api = server();
    assert.equal(api.post(payload).ok, false, JSON.stringify(payload));
    assert.equal(api.calls.decode, 0);
    assert.equal(api.calls.folder, 0);
  }
});

test('rejects oversized body and oversized decoded length before base64 decoding', () => {
  const limit = 20 * 1024 * 1024;
  const maxEncoded = Math.ceil(limit / 3) * 4;
  const api = server();
  assert.equal(api.post('x'.repeat(maxEncoded + 4097)).ok, false);
  // This uses the maximum base64 string length but encodes one byte too many.
  assert.equal(api.post({ ...validUpload(), data: 'A'.repeat(maxEncoded) }).ok, false);
  assert.equal(api.calls.decode, 0);
  assert.equal(api.calls.folder, 0);
});

test('accepts the full 20 MB boundary without rejecting valid base64 padding', () => {
  const limit = 20 * 1024 * 1024;
  const maxEncoded = Math.ceil(limit / 3) * 4;
  const api = server({ decodedBytes: { length: limit } });
  assert.equal(api.post({ ...validUpload(), data: 'A'.repeat(maxEncoded - 1) + '=' }).ok, true);
  assert.equal(api.calls.create, 1);
});

test('never writes empty decoded content or an oversized decoded result', () => {
  for (const decodedBytes of [[], { length: 20 * 1024 * 1024 + 1 }]) {
    const api = server({ decodedBytes });
    assert.equal(api.post(validUpload()).ok, false);
    assert.equal(api.calls.create, 0);
  }
});

test('missing or invalid destination configuration never accepts an upload', () => {
  for (const folderId of ['', null, 'https://drive.google.com/folders/private-id']) {
    const api = server({ folderId });
    assert.equal(api.post(validUpload()).ok, false);
    assert.equal(api.calls.create, 0);
    assert.equal(api.calls.decode, 0);
  }
});

test('a busy lock returns a retryable failure without a write or release', () => {
  const api = server({ busy: true });
  const result = api.post(validUpload());
  assert.equal(result.ok, false);
  assert.match(result.error, /busy/i);
  assert.equal(api.calls.create, 0);
  assert.equal(api.calls.release, 0);
});

test('Drive errors return a safe failure instead of success or private details', () => {
  for (const options of [{ folderError: true }, { createError: true }]) {
    const api = server(options);
    const result = api.post(validUpload());
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.error, /Private|credential|account information/);
    assert.equal(api.calls.release, options.createError ? 1 : 0);
  }
});

test('a mismatched, trashed, or incomplete stored file is never acknowledged', () => {
  for (const options of [{ wrongSize: true }, { wrongType: true }, { trashed: true }]) {
    const api = server(options);
    assert.equal(api.post(validUpload()).ok, false);
    assert.equal(api.post(validUpload()).ok, false);
    assert.equal(api.calls.create, 1);
    assert.equal(api.calls.release, 2);
  }
});
