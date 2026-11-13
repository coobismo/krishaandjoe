import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { DriveError } from '../src/errors.mjs';
import { diagnoseGallery, driveFileIdFromInput } from '../scripts/gallery-diagnostic-helpers.mjs';

const project = 'wedding-test-project';
const prefix = `projects/${project}/databases/(default)/documents/weddingPhotoGallery/`;
const serviceUrl = 'https://wedding-photo-uploads-test.run.app';
const code = 'PRIVATE_GUEST_CODE';
const cloudToken = 'PRIVATE_CLOUD_TOKEN';
const makePhoto = () => ({ id: randomUUID(), fileId: `private-drive-${randomUUID()}`, size: 1234, mimeType: 'image/jpeg' });
const document = (photo, extra = {}) => ({ name: prefix + photo.id, fields: {
  id: { stringValue: photo.id }, fileId: { stringValue: photo.fileId },
  mimeType: { stringValue: photo.mimeType }, size: { integerValue: String(photo.size) },
  createdAt: { timestampValue: '2026-11-12T08:00:00Z' }, ...extra,
} });
const metadata = (photo, extra = {}) => ({ id: photo.fileId, size: String(photo.size), mimeType: photo.mimeType,
  appProperties: { uploadId: photo.id }, trashed: false, thumbnailLink: 'https://private.example/SECRET_LINK', ...extra });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fixture(photos = [makePhoto()]) {
  const calls = [];
  const driveCalls = [];
  const responses = [json({ ok: true, photos: photos.map(({ id }) => ({ id })), nextCursor: null }), json(photos.map((photo) => ({ document: document(photo) })))];
  const options = {
    serviceUrl, uploadCode: code, cloudToken, firestoreProject: project,
    fetchImpl: async (url, request) => { calls.push({ url, ...request }); return responses.shift(); },
    drive: { async getMetadata(fileId) {
      driveCalls.push(fileId);
      const photo = photos.find((item) => item.fileId === fileId);
      return photo ? metadata(photo) : null;
    } },
  };
  return { photos, responses, calls, driveCalls, options };
}

test('recent diagnostic uses only bounded read queries and projects a credential-free report', async () => {
  const testCase = fixture([makePhoto(), makePhoto()]);
  const result = await diagnoseGallery(testCase.options);
  assert.equal(result.galleryApi.httpStatus, 200);
  assert.equal(result.galleryApi.photoCount, 2);
  assert.equal(result.galleryIndex.recordCount, 2);
  assert.ok(result.photos.every((row) => row.indexValid && row.driveFound && row.idMatches && row.mimeMatches && row.sizeMatches && row.uploadIdMatches && row.listedByApi));
  assert.deepEqual(result.photos.map((row) => row.position), [1, 2]);
  assert.equal(testCase.calls[0].url, `${serviceUrl}/v1/gallery`);
  assert.deepEqual(testCase.calls[0].headers, { 'X-Upload-Code': code });
  assert.equal(testCase.calls[1].method, 'POST');
  assert.ok(testCase.calls[1].url.endsWith('/documents:runQuery'));
  assert.deepEqual(testCase.calls[1].headers, { Authorization: `Bearer ${cloudToken}`, 'Content-Type': 'application/json' });
  const query = JSON.parse(testCase.calls[1].body).structuredQuery;
  assert.equal(query.limit, 18);
  assert.deepEqual(query.orderBy.map((entry) => [entry.field.fieldPath, entry.direction]), [['createdAt', 'DESCENDING'], ['__name__', 'DESCENDING']]);
  assert.deepEqual(query.select.fields.map((entry) => entry.fieldPath), ['id', 'fileId', 'mimeType', 'size', 'createdAt']);
  assert.ok(testCase.calls.every((call) => call.redirect === 'error' && call.cache === 'no-store'));
  const output = JSON.stringify(result);
  for (const photo of testCase.photos) {
    assert.equal(output.includes(photo.id), false);
    assert.equal(output.includes(photo.fileId), false);
  }
  assert.doesNotMatch(output, /PRIVATE_|SECRET_LINK|https:|thumbnailLink|sessionUrl|parent|email/i);
});

test('safe comparisons distinguish a listed trashed file, missing file, and metadata mismatch', async () => {
  const testCase = fixture([makePhoto(), makePhoto(), makePhoto()]);
  testCase.options.drive.getMetadata = async (fileId) => {
    const index = testCase.photos.findIndex((photo) => photo.fileId === fileId);
    if (index === 1) return null;
    return metadata(testCase.photos[index], index === 0 ? { trashed: true } : { size: '999' });
  };
  const result = await diagnoseGallery(testCase.options);
  assert.equal(result.photos[0].trashed, true);
  assert.equal(result.photos[0].listedByApi, true);
  assert.equal(result.photos[1].driveFound, false);
  assert.equal(result.photos[2].sizeMatches, false);
  assert.equal(result.photos[2].idMatches, true);
});

test('one folder query distinguishes an untrashed listed photo outside the album from one still inside', async () => {
  const testCase = fixture([makePhoto(), makePhoto()]);
  const folderId = 'PRIVATE_CONFIGURED_FOLDER';
  const folderCalls = [];
  testCase.options.drive.getFolderFileIds = async (folder, uploadIds) => {
    folderCalls.push({ folder, uploadIds });
    return new Set([testCase.photos[1].fileId]);
  };
  const result = await diagnoseGallery({ ...testCase.options, folderId });
  assert.deepEqual(folderCalls, [{ folder: folderId, uploadIds: testCase.photos.map((photo) => photo.id) }]);
  assert.deepEqual(result.galleryFolder, { configured: true, checked: true });
  assert.deepEqual(result.photos.map((row) => row.presentInGalleryFolder), [false, true]);
  assert.ok(result.photos.every((row) => row.trashed === false && row.listedByApi && row.idMatches));
  const output = JSON.stringify(result);
  assert.ok(!output.includes(folderId));
  assert.ok(testCase.photos.every((photo) => !output.includes(photo.fileId) && !output.includes(photo.id)));
});

test('membership errors report unknown presence with safe diagnostics rather than declaring every photo absent', async () => {
  const testCase = fixture();
  testCase.options.drive.getFolderFileIds = async () => {
    const error = new DriveError(403, { operation: 'list_files', reason: 'insufficientPermissions' });
    error.privateProviderBody = 'PRIVATE_PROVIDER_BODY';
    throw error;
  };
  const result = await diagnoseGallery({ ...testCase.options, folderId: 'PRIVATE_FOLDER_ID' });
  assert.equal(result.photos[0].presentInGalleryFolder, null);
  assert.equal(result.photos[0].driveFound, true);
  assert.deepEqual(result.galleryFolder, {
    configured: true, checked: false,
    diagnostics: { upstream: 'drive', operation: 'list_files', reason: 'insufficientPermissions', upstreamStatus: 403 },
  });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
});

test('specific photo diagnostics read its durable gallery document, not its expiring upload session', async () => {
  const testCase = fixture();
  const photo = testCase.photos[0];
  testCase.responses[1] = json(document(photo));
  const result = await diagnoseGallery({ ...testCase.options, photoId: photo.id });
  assert.equal(result.galleryIndex.recordCount, 1);
  assert.ok(testCase.calls[1].url.endsWith(`/weddingPhotoGallery/${photo.id}`));
  assert.equal(testCase.calls[1].method, undefined);
  assert.ok(testCase.calls.every((call) => !call.url.includes('weddingPhotoUploads')));
});

test('requested original comparison distinguishes a different deleted file from indexed live copies', async () => {
  const testCase = fixture();
  const requestedFileId = 'private-original-file';
  const getMetadata = testCase.options.drive.getMetadata;
  testCase.options.drive.getMetadata = async (fileId) => fileId === requestedFileId
    ? { id: requestedFileId, trashed: true, thumbnailLink: 'PRIVATE_LINK' } : getMetadata(fileId);
  const result = await diagnoseGallery({ ...testCase.options, requestedFileId });
  assert.equal(result.requestedFile.indexedInSample, false);
  assert.equal(result.requestedFile.listedByApi, false);
  assert.equal(result.requestedFile.driveFound, true);
  assert.equal(result.requestedFile.trashed, true);
  assert.equal(result.requestedFile.idMatches, true);
  assert.equal(JSON.stringify(result).includes(requestedFileId), false);
});

test('Drive links are parsed locally and arbitrary hosts, credentials and folder links are rejected', () => {
  const id = 'a-valid-drive-file-id';
  assert.equal(driveFileIdFromInput(id), id);
  assert.equal(driveFileIdFromInput(`https://drive.google.com/file/d/${id}/view?usp=sharing`), id);
  assert.equal(driveFileIdFromInput(`https://drive.google.com/open?id=${id}`), id);
  for (const input of [
    'https://evil.example/file/d/a-valid-drive-file-id/view',
    'http://drive.google.com/file/d/a-valid-drive-file-id/view',
    'https://user:password@drive.google.com/file/d/a-valid-drive-file-id/view',
    `https://drive.google.com/drive/folders/${id}`,
    `https://drive.google.com/open?id=${id}&id=another-id`,
    'short',
  ]) assert.throws(() => driveFileIdFromInput(input), (error) => !error.message.includes(input));
});

test('provider failures emit only allowlisted diagnostics and invalid rows never access Drive', async () => {
  const testCase = fixture([makePhoto(), makePhoto()]);
  testCase.responses[1] = json([
    { document: document(testCase.photos[0]) },
    { document: document(testCase.photos[1], { fileId: { stringValue: 'https://evil.example' } }) },
  ]);
  testCase.options.drive.getMetadata = async (fileId) => {
    testCase.driveCalls.push(fileId);
    throw new DriveError(403, { operation: 'get_file', reason: 'insufficientPermissions' });
  };
  const result = await diagnoseGallery(testCase.options);
  assert.equal(result.photos[0].driveFound, null);
  assert.equal(result.photos[0].diagnostics.reason, 'insufficientPermissions');
  assert.equal(result.photos[1].indexValid, false);
  assert.equal(testCase.driveCalls.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /evil\.example|PRIVATE_/);
});

test('HTTP failures and excessive query responses do not expose provider bodies or exceed the sample bound', async () => {
  const testCase = fixture();
  testCase.responses[0] = json({ error: 'PRIVATE_PROVIDER_BODY' }, 503);
  testCase.responses[1] = json(Array.from({ length: 19 }, () => ({ document: document(testCase.photos[0]) })));
  const result = await diagnoseGallery(testCase.options);
  assert.equal(result.galleryApi.responseValid, false);
  assert.equal(result.galleryApi.httpStatus, 503);
  assert.equal(result.galleryIndex.responseValid, false);
  assert.equal(result.photos.length, 0);
  assert.equal(testCase.driveCalls.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROVIDER_BODY/);
});
