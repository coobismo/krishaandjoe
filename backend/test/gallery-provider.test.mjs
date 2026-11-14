import assert from 'node:assert/strict';
import test from 'node:test';
import { createDriveGalleryProvider } from '../src/drive-gallery-provider.mjs';
import { createGalleryService } from '../src/gallery-service.mjs';

const thumbUrl = 'https://lh3.googleusercontent.com/drive-storage/private-token=s220';
const file = (extra = {}) => ({ id: 'file-1', mimeType: 'image/heic', size: '9000000', thumbnailLink: thumbUrl, ...extra });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const image = (bytes = Buffer.from('jpeg'), contentType = 'image/jpeg', headers = {}) => new Response(bytes, { headers: { 'content-type': contentType, ...headers } });
const uploadId = 'af8d3c2a-7891-4b21-9c54-bd1e4eb6a7e0';

function provider(responses = [], settings = {}) {
  const calls = [];
  let tokens = 0;
  const drive = createDriveGalleryProvider({
    auth: { async getAccessToken() { tokens += 1; return { token: 'server-secret-token' }; } },
    fetchImpl: async (url, options) => {
      calls.push({ url, ...options });
      const response = responses.shift();
      if (!response) throw new Error('Unexpected Google request with private credentials');
      return typeof response === 'function' ? response(url, options) : response;
    },
    ...settings,
  });
  return { drive, calls, tokens: () => tokens };
}

test('metadata lookup uses a fixed Drive endpoint, bounded fields and server-only OAuth', async () => {
  const fixture = provider([json({ id: 'file-1', thumbnailLink: thumbUrl }), new Response(null, { status: 404 })]);
  assert.equal((await fixture.drive.getMetadata('file-1')).id, 'file-1');
  assert.equal(await fixture.drive.getMetadata('deleted-file'), null);
  assert.ok(fixture.calls[0].url.startsWith('https://www.googleapis.com/drive/v3/files/file-1?'));
  assert.ok(fixture.calls[0].url.includes('thumbnailLink'));
  assert.equal(new URL(fixture.calls[0].url).searchParams.get('fields'), 'id,size,mimeType,appProperties,trashed,thumbnailLink,description');
  assert.equal(fixture.calls[0].headers.Authorization, 'Bearer server-secret-token');
  await assert.rejects(fixture.drive.getMetadata('https://evil.example/private'), { status: 502 });
  assert.equal(fixture.calls.length, 2);
});

test('the real provider recovers a verified legacy credit without exposing raw Drive descriptions', async () => {
  const fixture = provider([
    json({ files: [{ id: 'file-1' }] }),
    json(file({ mimeType: 'image/jpeg', size: '123', appProperties: { uploadId }, description: 'Shared by  Jo  Cruz' })),
    json({ files: [{ id: 'file-1' }] }),
    json(file({ mimeType: 'image/jpeg', size: '123', appProperties: { uploadId }, description: 'Private family notes' })),
  ]);
  const photo = { id: uploadId, fileId: 'file-1', mimeType: 'image/jpeg', size: 123, createdAt: new Date('2026-11-12T06:00:00Z') };
  const service = createGalleryService({
    drive: fixture.drive, folderId: 'wedding-folder', uploadCode: 'guests', tokenSecret: 'a-test-secret-with-more-than-32-characters',
    repository: {
      async seedCompletedUploads() {},
      async list() { return { photos: [photo], nextCursor: null }; },
    },
  });
  const result = await service.list({}, 'guests');
  assert.deepEqual(result.photos, [{ id: uploadId, mimeType: photo.mimeType, createdAt: photo.createdAt.toISOString(), guestName: 'Jo Cruz' }]);
  assert.doesNotMatch(JSON.stringify(result), /description|Shared by|file-1|thumbnailLink/);
  const anonymous = await service.list({}, 'guests');
  assert.equal('guestName' in anonymous.photos[0], false);
  assert.doesNotMatch(JSON.stringify(anonymous), /Private family notes|description/);
});

test('folder membership searches only the requested upload markers and follows every result page', async () => {
  const fixture = provider([
    json({ files: [{ id: 'file-1' }], nextPageToken: 'private-next-page', incompleteSearch: false }),
    json({ files: [{ id: 'file-1' }, { id: 'file-2' }], incompleteSearch: false }),
  ]);
  assert.deepEqual(await fixture.drive.getFolderFileIds('wedding-folder', [uploadId]), new Set(['file-1', 'file-2']));
  const first = new URL(fixture.calls[0].url);
  assert.equal(first.origin + first.pathname, 'https://www.googleapis.com/drive/v3/files');
  assert.equal(first.searchParams.get('q'), `'wedding-folder' in parents and trashed = false and (appProperties has { key='uploadId' and value='${uploadId}' })`);
  assert.equal(first.searchParams.get('fields'), 'nextPageToken,incompleteSearch,files(id)');
  assert.equal(first.searchParams.get('includeItemsFromAllDrives'), 'true');
  assert.equal(first.searchParams.get('supportsAllDrives'), 'true');
  assert.equal(new URL(fixture.calls[1].url).searchParams.get('pageToken'), 'private-next-page');
  assert.ok(fixture.calls.every((call) => call.redirect === 'manual' && call.headers.Authorization === 'Bearer server-secret-token'));
  assert.equal(fixture.tokens(), 1);
});

test('folder queries reject arbitrary IDs and excessive pages without reading credentials', async () => {
  const fixture = provider();
  for (const [folder, ids] of [
    ["folder' or trashed=true", [uploadId]], ['https://evil.example', [uploadId]],
    ['folder', ['arbitrary-file-id']], ['folder', Array(37).fill(uploadId)], ['folder', null],
  ]) await assert.rejects(fixture.drive.getFolderFileIds(folder, ids), { status: 502 });
  assert.deepEqual(await fixture.drive.getFolderFileIds('folder', []), new Set());
  assert.equal(fixture.tokens(), 0);
  assert.equal(fixture.calls.length, 0);
});

test('incomplete or malformed folder results never establish that a photo was removed', async () => {
  for (const body of [
    { files: [], incompleteSearch: true }, { files: [], incompleteSearch: 'true' }, {},
    { files: [{ id: 'https://evil.example' }] }, { files: [], nextPageToken: 123 },
    { files: [], nextPageToken: 'a'.repeat(4097) },
  ]) {
    const fixture = provider([json(body)]);
    await assert.rejects(fixture.drive.getFolderFileIds('folder', [uploadId]), (error) => {
      assert.equal(error.status, 502);
      assert.equal(error.diagnostics.operation, 'list_files');
      assert.equal(error.diagnostics.reason, 'invalid_response');
      return true;
    });
  }
  const fixture = provider(Array.from({ length: 10 }, () => json({ files: [], nextPageToken: 'more-results' })));
  await assert.rejects(fixture.drive.getFolderFileIds('folder', [uploadId]), { status: 502 });
  assert.equal(fixture.calls.length, 10);
});

test('folder permission and server failures propagate safely instead of returning an empty set', async () => {
  for (const status of [403, 429, 503]) {
    const fixture = provider([json({ error: { message: 'PRIVATE_PROVIDER_BODY', errors: [{ reason: 'insufficientPermissions' }] } }, status)]);
    await assert.rejects(fixture.drive.getFolderFileIds('folder', [uploadId]), (error) => {
      assert.equal(error.status, status);
      assert.equal(error.diagnostics.operation, 'list_files');
      assert.doesNotMatch(JSON.stringify(error), /PRIVATE_PROVIDER_BODY/);
      return true;
    });
  }
});

test('real gallery provider and service hide an untrashed file removed from the folder and reject cached bytes', async () => {
  let inFolder = true;
  let renders = 0;
  const photo = { id: uploadId, fileId: 'file-1', mimeType: 'image/jpeg', size: 123, createdAt: new Date('2026-11-12T06:00:00Z') };
  const drive = createDriveGalleryProvider({
    auth: { async getAccessToken() { return { token: 'server-secret-token' }; } },
    fetchImpl: async (value) => {
      const url = new URL(value);
      if (url.pathname === '/drive/v3/files') return json({ files: inFolder ? [{ id: photo.fileId }] : [] });
      if (url.pathname === '/drive/v3/files/file-1') return json(file({ mimeType: photo.mimeType, size: '123', appProperties: { uploadId }, trashed: false }));
      if (url.hostname === 'lh3.googleusercontent.com') { renders += 1; return image(); }
      throw new Error('Unexpected provider destination');
    },
  });
  const service = createGalleryService({
    drive, folderId: 'wedding-folder', uploadCode: 'guests', tokenSecret: 'a-test-secret-with-more-than-32-characters',
    repository: {
      async seedCompletedUploads() {},
      async list() { return { photos: [photo], nextCursor: null }; },
      async get(id) { return id === photo.id ? photo : null; },
    },
  });
  await service.image(uploadId, {}, 'guests');
  assert.equal(renders, 1);
  inFolder = false;
  assert.equal((await drive.getMetadata(photo.fileId)).trashed, false);
  assert.deepEqual(await service.list({}, 'guests'), { ok: true, photos: [], nextCursor: null });
  await assert.rejects(service.image(uploadId, {}, 'guests'), { status: 404 });
  assert.equal(renders, 1);
  inFolder = true;
  assert.equal((await service.list({}, 'guests')).photos.length, 1);
  await service.image(uploadId, {}, 'guests');
  assert.equal(renders, 2);
});

test('grid thumbnails and previews use best-effort resized Google links without following redirects', async () => {
  const fixture = provider([image(), image()]);
  assert.equal((await fixture.drive.thumbnail(file(), { variant: 'thumbnail' })).contentType, 'image/jpeg');
  await fixture.drive.thumbnail(file(), { variant: 'preview' });
  assert.ok(fixture.calls[0].url.endsWith('=s480'));
  assert.ok(fixture.calls[1].url.endsWith('=s1600'));
  for (const call of fixture.calls) {
    assert.equal(call.redirect, 'manual');
    assert.equal(call.headers.Authorization, 'Bearer server-secret-token');
    assert.ok(call.signal instanceof AbortSignal);
  }
});

test('a failed resize falls back to the original link, while query strings remain unchanged', async () => {
  const fixture = provider([json({ error: { errors: [{ reason: 'forbidden' }] } }, 403), image(), image()]);
  await fixture.drive.thumbnail(file(), { variant: 'preview' });
  assert.equal(fixture.calls[1].url, thumbUrl);
  const signed = `${thumbUrl}?signed=private`;
  await fixture.drive.thumbnail(file({ thumbnailLink: signed }), { variant: 'preview' });
  assert.equal(fixture.calls[2].url, signed);
});

test('unsafe thumbnail links are rejected before token access or any network request', async () => {
  const fixture = provider();
  for (const thumbnailLink of [
    'http://lh3.googleusercontent.com/file=s220',
    'https://evil.example/file=s220',
    'https://lh3.googleusercontent.com.evil.example/file=s220',
    'https://user:password@lh3.googleusercontent.com/file=s220',
    'https://lh3.googleusercontent.com/file=s220#fragment',
    'https://unexpected.googleusercontent.com/file=s220',
  ]) await assert.rejects(fixture.drive.thumbnail(file({ thumbnailLink, mimeType: 'image/jpeg', size: '10' })), { status: 503 });
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.tokens(), 0);
});

test('redirects never forward OAuth tokens to another host', async () => {
  const fixture = provider([
    new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } }),
    new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } }),
  ]);
  await assert.rejects(fixture.drive.thumbnail(file()), { status: 503 });
  assert.equal(fixture.calls.length, 2);
  assert.ok(fixture.calls.every((call) => new URL(call.url).hostname === 'lh3.googleusercontent.com'));
});

test('content-length and streaming bodies are capped at8MiB without accepting SVG or HTML', async () => {
  const over = 8 * 1024 * 1024 + 1;
  let cancelled = false;
  const streaming = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(over)); },
    cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'image/jpeg' } });
  for (const response of [
    image(Buffer.from('small'), 'image/jpeg', { 'content-length': String(over) }),
    streaming, image(Buffer.from('svg'), 'image/svg+xml'), image(Buffer.from('html'), 'text/html'),
  ]) {
    const fixture = provider([response]);
    await assert.rejects(fixture.drive.thumbnail(file({ thumbnailLink: thumbUrl.replace('s220', 's480') })), { status: 503 });
  }
  assert.equal(cancelled, true);
});

test('small JPEG/PNG without thumbnails may use bounded alt=media; large or HEIC originals are never fetched', async () => {
  const fixture = provider([image(Buffer.from('png'), 'image/png; charset=binary')]);
  const result = await fixture.drive.thumbnail(file({ thumbnailLink: undefined, mimeType: 'image/png', size: '3' }));
  assert.equal(result.contentType, 'image/png');
  assert.equal(fixture.calls[0].url, 'https://www.googleapis.com/drive/v3/files/file-1?alt=media&supportsAllDrives=true');
  for (const metadata of [file({ thumbnailLink: undefined }), file({ thumbnailLink: undefined, mimeType: 'image/jpeg', size: '8388609' })]) {
    await assert.rejects(fixture.drive.thumbnail(metadata), { status: 503, retryable: true });
  }
  assert.equal(fixture.calls.length, 1);
});

test('the grid skips a2MiB original fallback while the larger preview can fetch it', async () => {
  const fixture = provider([image()]);
  const metadata = file({ thumbnailLink: undefined, mimeType: 'image/jpeg', size: String(2 * 1024 * 1024) });
  await assert.rejects(fixture.drive.thumbnail(metadata, { variant: 'thumbnail' }), { status: 503, retryable: true });
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.tokens(), 0);
  assert.equal((await fixture.drive.thumbnail(metadata, { variant: 'preview' })).contentType, 'image/jpeg');
  assert.equal(fixture.calls.length, 1);
  assert.ok(fixture.calls[0].url.includes('alt=media'));
});

test('OAuth and provider error details are reduced to safe messages and enum diagnostics', async () => {
  const fixture = provider([], { auth: { async getAccessToken() {
    throw Object.assign(new Error('refresh_token=PRIVATE_TOKEN'), { response: { status: 400, data: { error: 'invalid_grant', error_description: 'PRIVATE_TOKEN' } } });
  } } });
  await assert.rejects(fixture.drive.getMetadata('file-1'), (error) => {
    assert.equal(error.diagnostics.reason, 'invalid_grant');
    assert.doesNotMatch(error.message, /PRIVATE_TOKEN|refresh_token=/);
    return true;
  });
});

test('owner OAuth refresh waits are bounded', async () => {
  const fixture = provider([], { timeoutMs: 5, auth: { getAccessToken: () => new Promise(() => {}) } });
  await assert.rejects(fixture.drive.getMetadata('file-1'), { status: 503 });
  assert.equal(fixture.calls.length, 0);
});
