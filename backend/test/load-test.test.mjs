import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  createFetchObserver, createLoadTestPhoto, parseLoadTestArgs, planLoadTest, readLoadTestPhoto, runUploadLoadTest,
} from '../scripts/load-test-helpers.mjs';

const endpoint = 'https://uploader-test.run.app';
const uploadCode = 'PRIVATE_TEST_GUEST_CODE';
const flush = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve(); };
const uuidSequence = () => {
  let sequence = 0;
  return () => `00000000-0000-4000-8000-${(++sequence).toString(16).padStart(12, '0')}`;
};
const inertTimer = { setIntervalFn: () => 1, clearIntervalFn: () => {} };
const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xd9]);

test('strict argument parsing rejects unknown, missing, duplicate and out-of-range values', () => {
  assert.deepEqual(parseLoadTestArgs(['--endpoint', endpoint]), {
    endpoint, clients: 10, megabytes: 8, filesPerClient: 1, dryRun: false,
  });
  assert.deepEqual(parseLoadTestArgs(['--endpoint', endpoint, '--clients', '100', '--megabytes', '32', '--files-per-client', '20', '--dry-run']), {
    endpoint, clients: 100, megabytes: 32, filesPerClient: 20, dryRun: true,
  });
  assert.deepEqual(parseLoadTestArgs(['--endpoint', endpoint, '--file', '/local/private photo.JPG', '--clients', '50']), {
    endpoint, clients: 50, filePath: '/local/private photo.JPG', filesPerClient: 1, dryRun: false,
  });
  const bad = [
    [], ['--endpoint'], ['--endpoint', endpoint, '--clients'],
    ['--endpoint', endpoint, '--unknown', '1'], ['--endpoint', endpoint, '--clients100'],
    ['--endpoint', endpoint, '--clients', '2', '--clients', '3'],
    ['--endpoint', endpoint, '--dry-run', '--dry-run'], ['--endpoint', endpoint, '--dry-run', 'false'],
    ['--endpoint', 'http://remote.example'], ['--endpoint', 'https://user:PRIVATE@uploader-test.run.app'],
    ...['0', '-1', '101', '1.5', '01', '1e2'].map((value) => ['--endpoint', endpoint, '--clients', value]),
    ['--endpoint', endpoint, '--megabytes', '33'], ['--endpoint', endpoint, '--files-per-client', '21'],
    ['--endpoint', endpoint, '--file'], ['--endpoint', endpoint, '--file', 'one.jpg', '--file', 'two.jpg'],
    ['--endpoint', endpoint, '--file', 'photo.jpg', '--megabytes', '8'],
  ];
  for (const args of bad) assert.throws(() => parseLoadTestArgs(args), (error) => {
    assert.match(error.message, /^Usage:/);
    assert.ok(!error.message.includes('PRIVATE'));
    return true;
  });
});

test('local JPEG bytes and MIME are preserved and planning uses their exact size', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'wedding-load-test-jpeg-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'private photo.JPEG');
  writeFileSync(path, jpegBytes);
  const source = await readLoadTestPhoto(path);
  assert.equal(source.fileBytes, jpegBytes.length);
  assert.equal(source.photo.type, 'image/jpeg');
  assert.deepEqual(Buffer.from(await source.photo.arrayBuffer()), jpegBytes);
  assert.deepEqual(readFileSync(path), jpegBytes, 'Reading the source must leave it unchanged');
  assert.deepEqual(await readLoadTestPhoto(path, { dryRun: true }), { fileBytes: jpegBytes.length });
  const plan = planLoadTest({ clients: 100, filesPerClient: 3, fileBytes: source.fileBytes });
  assert.equal(plan.totalFiles, 300);
  assert.equal(plan.totalBytes, 300 * jpegBytes.length);

  const seen = [];
  const result = await runUploadLoadTest({
    endpoint, clients: 2, filesPerClient: 2, photo: source.photo, uploadCode, uuid: uuidSequence(), ...inertTimer,
    async upload(_url, { file, uploadId }) {
      assert.equal(file.type, 'image/jpeg');
      assert.equal(file.name, `load-test-${uploadId}.jpg`);
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), jpegBytes);
      seen.push(file.name);
      return { ok: true, uploadId };
    },
  });
  assert.equal(result.confirmedFiles, 4);
  assert.equal(new Set(seen).size, 4);
  assert.equal(result.totalBytes, 4 * jpegBytes.length);
});

test('local JPEG validation rejects inaccessible, empty, oversized, non-file and misleading inputs privately', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'wedding-load-test-jpeg-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const files = {
    'empty.jpg': Buffer.alloc(0), 'not-jpeg.jpg': Buffer.from('private non-JPEG contents'),
    'photo.png': jpegBytes, 'too-large.jpg': jpegBytes,
  };
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(directory, name), contents);
  truncateSync(join(directory, 'too-large.jpg'), 32 * 1024 * 1024 + 1);
  mkdirSync(join(directory, 'directory.jpg'));
  for (const name of [...Object.keys(files), 'directory.jpg', 'PRIVATE_MISSING.jpg']) {
    for (const dryRun of [false, true]) {
      await assert.rejects(readLoadTestPhoto(join(directory, name), { dryRun }), (error) => {
        assert.doesNotMatch(error.message, /PRIVATE|wedding-load-test-jpeg-|ENOENT|private non-JPEG/);
        return true;
      });
    }
  }
});

test('planning computes bounded volumes without allocation and the generated photo is a valid aligned BMP', async () => {
  const defaults = planLoadTest(parseLoadTestArgs(['--endpoint', endpoint]));
  assert.equal(defaults.totalFiles, 10);
  assert.equal(defaults.totalBytes, defaults.fileBytes * 10);
  assert.ok(defaults.fileBytes <= 8 * 1024 * 1024);
  const maximum = planLoadTest({ clients: 100, filesPerClient: 20, megabytes: 32 });
  assert.equal(maximum.totalFiles, 2000);
  assert.ok(maximum.fileBytes <= 32 * 1024 * 1024);
  assert.equal(maximum.totalBytes, maximum.fileBytes * 2000);
  const photo = createLoadTestPhoto(1);
  const header = Buffer.from(await photo.slice(0, 54).arrayBuffer());
  assert.equal(photo.type, 'image/bmp');
  assert.ok(photo.size <= 1024 * 1024 && photo.size > 1024 * 1023);
  assert.equal(header.subarray(0, 2).toString(), 'BM');
  assert.equal(header.readUInt32LE(2), photo.size);
  assert.equal(header.readUInt32LE(10), 54);
  assert.equal(header.readUInt32LE(14), 40);
  assert.equal(header.readInt32LE(18), 1024);
  assert.equal(header.readUInt16LE(26), 1);
  assert.equal(header.readUInt16LE(28), 24);
  assert.equal(header.readUInt32LE(34), header.readInt32LE(22) * 1024 * 3);
  assert.equal(header.readUInt32LE(34) + 54, photo.size);
});

test('100 guests run concurrently while each three-file queue waits for its preceding file', async () => {
  const requests = [];
  let active = 0;
  let peak = 0;
  let clock = 0;
  const photo = new Blob(['generated-photo'], { type: 'image/bmp' });
  const running = runUploadLoadTest({
    endpoint, clients: 100, filesPerClient: 3, photo, uploadCode, uuid: uuidSequence(), now: () => clock,
    ...inertTimer,
    upload(url, entry, options) {
      assert.equal(url, endpoint);
      assert.equal(options.provider, 'cloud-run');
      assert.equal(options.uploadCode, uploadCode);
      assert.equal(entry.file.name, `load-test-${entry.uploadId}.bmp`);
      assert.equal(entry.file.size, photo.size);
      active += 1;
      peak = Math.max(peak, active);
      return new Promise((resolve) => requests.push({
        entry, settled: false,
        finish() { this.settled = true; options.onProgress({ uploadedBytes: photo.size }); resolve({ ok: true, uploadId: entry.uploadId }); },
      })).finally(() => { active -= 1; clock += 2; });
    },
  });
  assert.equal(requests.length, 100);
  requests[0].finish();
  await flush();
  assert.equal(requests.length, 101, 'Only the released guest can begin its second file');
  requests[100].finish();
  await flush();
  assert.equal(requests.length, 102, 'Its third file also waits for the preceding receipt');
  requests[101].finish();
  await flush();
  assert.equal(requests.length, 102, 'That guest has exactly three files');
  while (requests.length < 300 || requests.some((request) => !request.settled)) {
    const pending = requests.filter((request) => !request.settled);
    assert.ok(pending.length > 0);
    pending.forEach((request) => request.finish());
    await flush();
  }
  const result = await running;
  assert.equal(peak, 100);
  assert.equal(active, 0);
  assert.equal(new Set(requests.map((request) => request.entry.uploadId)).size, 300);
  assert.equal(result.confirmedFiles, 300);
  assert.equal(result.failedFiles, 0);
  assert.equal(result.successfulGuests, 100);
  assert.equal(result.totalGuests, 100);
  assert.equal(result.acknowledgedBytes, result.totalBytes);
  assert.equal(result.totalBytes, 300 * photo.size);
  assert.equal(result.throughputBytesPerSecond, result.confirmedFiles * photo.size / (result.elapsedMs / 1000));
  assert.ok(result.fileDurationsMs.p95 >= result.fileDurationsMs.p50);
  assert.ok(result.fileDurationsMs.max >= result.fileDurationsMs.p95);
});

test('failed and unconfirmed files are categorized safely and do not prevent later files in the queues', async () => {
  let count = 0;
  const secret = `${uploadCode} https://private.example/private-file-id`;
  const failures = [
    Object.assign(new Error(secret), { status: 401 }), Object.assign(new Error(secret), { status: 429 }),
    Object.assign(new Error(secret), { status: 503 }), new TypeError(secret),
  ];
  const result = await runUploadLoadTest({
    endpoint, clients: 2, filesPerClient: 3, photo: new Blob(['test']), uploadCode,
    uuid: uuidSequence(), ...inertTimer,
    async upload(_url, { uploadId }) {
      const index = count++;
      if (index < 4) throw failures[index];
      return index === 4 ? { ok: true, uploadId: secret } : { ok: true, uploadId };
    },
  });
  assert.equal(count, 6);
  assert.equal(result.confirmedFiles, 1);
  assert.equal(result.failedFiles, 5);
  assert.equal(result.successfulGuests, 0);
  assert.deepEqual(result.failureCounts, { authorization: 1, rateLimit: 1, server: 1, networkOrTimeout: 1, other: 1 });
  assert.ok(!JSON.stringify(result).includes(uploadCode));
  assert.doesNotMatch(JSON.stringify(result), /private\.example|private-file-id|uploadId|guestName/);
  assert.ok(result.guestQueueP95Ms !== null, 'Failed guest queues remain in the queue duration sample');
});

test('acknowledged progress follows resets, ignores invalid byte counts, and cannot break uploads or leak interval callbacks', async () => {
  let tick;
  let finish;
  let progress;
  let clock = 0;
  const reports = [];
  const cleared = [];
  const running = runUploadLoadTest({
    endpoint, clients: 1, filesPerClient: 1, photo: new Blob(['0123456789']), uploadCode,
    uuid: uuidSequence(), now: () => clock,
    setIntervalFn(callback, interval) { assert.equal(interval, 5000); tick = callback; return 42; },
    clearIntervalFn: (timer) => cleared.push(timer),
    reportProgress(report) { reports.push(report); throw new Error('A display failure must not interrupt the upload'); },
    upload(_url, { uploadId }, options) {
      progress = options.onProgress;
      return new Promise((resolve) => { finish = () => resolve({ ok: true, uploadId }); });
    },
  });
  progress({ uploadedBytes: 8 }); tick();
  assert.equal(reports.at(-1).acknowledgedBytes, 8);
  progress({ uploadedBytes: 3 }); tick();
  assert.equal(reports.at(-1).acknowledgedBytes, 3);
  for (const uploadedBytes of [-1, 11, 1.5, NaN]) progress({ uploadedBytes });
  tick();
  assert.equal(reports.at(-1).acknowledgedBytes, 3);
  assert.equal(reports.at(-1).activeFiles, 1);
  assert.equal(reports.at(-1).activeGuests, 1);
  clock = 2000;
  finish();
  const result = await running;
  assert.equal(result.confirmedFiles, 1);
  assert.equal(result.acknowledgedBytes, 10);
  assert.equal(result.throughputBytesPerSecond, 5);
  assert.deepEqual(cleared, [42]);
  const previousReports = reports.length;
  tick();
  assert.equal(reports.length, previousReports, 'A stale interval callback must not report after completion');
});

test('fetch observations contain only copied status counts and network-failure totals', async () => {
  let count = 0;
  const observer = createFetchObserver(async () => {
    count += 1;
    if (count === 3) throw new TypeError(uploadCode);
    return { status: count === 1 ? 200 : 503, privateBody: uploadCode };
  });
  await observer.fetch('https://private.example/file', { headers: { Authorization: uploadCode } });
  await observer.fetch(endpoint);
  await assert.rejects(observer.fetch(endpoint), TypeError);
  assert.deepEqual(observer.getSnapshot(), { statuses: { 200: 1, 503: 1 }, networkFailures: 1 });
  const snapshot = observer.getSnapshot();
  snapshot.statuses[200] = 999;
  assert.equal(observer.getSnapshot().statuses[200], 1);
  assert.doesNotMatch(JSON.stringify(observer.getSnapshot()), /PRIVATE_|https:|headers|privateBody/);
});

function cli(t, args, files = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'wedding-load-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(directory, name), contents);
  const guard = 'data:text/javascript,' + encodeURIComponent('globalThis.fetch = async () => { console.error("UNEXPECTED_NETWORK_CALL"); throw new Error("Network is forbidden in this test"); };');
  const result = spawnSync(process.execPath, ['--import', guard, fileURLToPath(new URL('../scripts/load-test.mjs', import.meta.url)), ...args], {
    cwd: directory, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.error, undefined);
  assert.deepEqual(readdirSync(directory).sort(), Object.keys(files).sort());
  for (const [name, contents] of Object.entries(files)) assert.deepEqual(readFileSync(join(directory, name)), contents);
  assert.ok(!`${result.stdout}${result.stderr}`.includes('UNEXPECTED_NETWORK_CALL'));
  return result;
}

test('CLI dry run calculates a 100-guest queue plan without prompting, networking or writing generated files', (t) => {
  const result = cli(t, ['--endpoint', endpoint, '--clients', '100', '--files-per-client', '3', '--megabytes', '8', '--dry-run']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /100 guest queues.*3 files.*300 generated BMP files/);
  assert.match(result.stdout, /Dry run complete/);
  assert.doesNotMatch(result.stdout, /Guest upload password:/);
  assert.equal(result.stderr, '');
});

test('CLI invalid flags fail before any password prompt or test plan', (t) => {
  const result = cli(t, ['--endpoint', endpoint, '--clients100']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^Usage:/);
  assert.equal(result.stdout, '');
});

test('CLI JPEG dry run uses exact source bytes without prompting, networking, copying or printing its private name', (t) => {
  const result = cli(t, ['--endpoint', endpoint, '--clients', '100', '--file', 'PRIVATE photo.JPG', '--files-per-client', '3', '--dry-run'], {
    'PRIVATE photo.JPG': jpegBytes,
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /300 JPEG test copies/);
  assert.match(result.stdout, new RegExp(`${jpegBytes.length} bytes per file`));
  assert.match(result.stdout, /Redeploy the backend/);
  assert.match(result.stdout, /Dry run complete/);
  assert.doesNotMatch(result.stdout, /Guest upload password:|PRIVATE/);
  assert.equal(result.stderr, '');
});

test('CLI rejects a bad JPEG before printing a plan or asking for the password', (t) => {
  const result = cli(t, ['--endpoint', endpoint, '--file', 'PRIVATE.jpg'], { 'PRIVATE.jpg': Buffer.from('not a JPEG') });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not have a JPEG header/);
  assert.doesNotMatch(result.stderr, /PRIVATE|ENOENT/);
  assert.equal(result.stdout, '');
});
