import { File } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { extname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { isUploadEndpoint, uploadPhoto } from '../../src/features/photos/uploadPhoto.mjs';

const MIB = 1024 * 1024;
const MAX_TEST_PHOTO_BYTES = 32 * MIB;
const USAGE = 'Usage: node backend/scripts/load-test.mjs --endpoint https://YOUR_SERVICE.run.app [--clients 10] [--megabytes 8 | --file /path/photo.jpg] [--files-per-client 1] [--dry-run]';
export class LoadTestError extends Error {}

export function parseLoadTestArgs(args) {
  const values = new Map();
  const known = new Set(['--endpoint', '--clients', '--megabytes', '--file', '--files-per-client', '--dry-run']);
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!known.has(key) || values.has(key)) throw new LoadTestError(USAGE);
    if (key === '--dry-run') values.set(key, true);
    else {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new LoadTestError(USAGE);
      values.set(key, value);
    }
  }
  const integer = (key, fallback, maximum) => {
    const value = values.get(key) ?? String(fallback);
    if (!/^[1-9]\d*$/.test(value) || Number(value) > maximum) throw new LoadTestError(USAGE);
    return Number(value);
  };
  const endpoint = values.get('--endpoint');
  if (!isUploadEndpoint(endpoint, 'cloud-run')) throw new LoadTestError(USAGE);
  if (values.has('--file') && values.has('--megabytes')) throw new LoadTestError(USAGE);
  return {
    endpoint, clients: integer('--clients', 10, 100),
    ...(values.has('--file') ? { filePath: values.get('--file') } : { megabytes: integer('--megabytes', 8, 32) }),
    filesPerClient: integer('--files-per-client', 1, 20), dryRun: values.get('--dry-run') === true,
  };
}

export function planLoadTest({ clients, filesPerClient, megabytes, fileBytes }) {
  const rowBytes = 1024 * 3;
  if (fileBytes === undefined) {
    const height = Math.max(1, Math.floor((megabytes * MIB - 54) / rowBytes));
    fileBytes = 54 + rowBytes * height;
  }
  return { clients, filesPerClient, fileBytes, totalFiles: clients * filesPerClient, totalBytes: clients * filesPerClient * fileBytes };
}

export async function readLoadTestPhoto(filePath, { dryRun = false } = {}) {
  if (!['.jpg', '.jpeg'].includes(extname(filePath).toLowerCase())) {
    throw new LoadTestError('Choose a local .jpg or .jpeg photo with --file.');
  }
  let handle;
  try {
    handle = await open(filePath, 'r');
    const info = await handle.stat();
    if (!info.isFile() || info.size < 3 || info.size > MAX_TEST_PHOTO_BYTES) {
      throw new LoadTestError('The test photo must be a nonempty regular JPEG file no larger than 32 MiB.');
    }
    const header = Buffer.alloc(3);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const isJpeg = (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (bytesRead !== 3 || !isJpeg(header)) throw new LoadTestError('The selected file does not have a JPEG header. Choose a .jpg or .jpeg photo.');
    if (dryRun) return { fileBytes: info.size };
    // Read one bounded copy; every guest reuses its immutable Blob contents.
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    const finalInfo = await handle.stat();
    if (offset !== bytes.length || finalInfo.size !== info.size || finalInfo.mtimeMs !== info.mtimeMs || !isJpeg(bytes)) {
      throw new LoadTestError('The test photo changed while it was being read. Try again with an unchanged local copy.');
    }
    return { fileBytes: bytes.length, photo: new Blob([bytes], { type: 'image/jpeg' }) };
  } catch (error) {
    if (error instanceof LoadTestError) throw error;
    throw new LoadTestError('Could not read the test photo. Check that --file points to an accessible local .jpg or .jpeg file.');
  } finally { await handle?.close(); }
}

export function createLoadTestPhoto(megabytes) {
  const { fileBytes } = planLoadTest({ clients: 1, filesPerClient: 1, megabytes });
  const bytes = Buffer.alloc(fileBytes);
  bytes.write('BM');
  bytes.writeUInt32LE(fileBytes, 2);
  bytes.writeUInt32LE(54, 10);
  bytes.writeUInt32LE(40, 14);
  bytes.writeInt32LE(1024, 18);
  bytes.writeInt32LE((fileBytes - 54) / (1024 * 3), 22);
  bytes.writeUInt16LE(1, 26);
  bytes.writeUInt16LE(24, 28);
  bytes.writeUInt32LE(fileBytes - 54, 34);
  return new Blob([bytes], { type: 'image/bmp' });
}

const percentile = (values, fraction) => values.length ? [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)] : null;
function failureCategory(error) {
  if ([401, 403].includes(error?.status)) return 'authorization';
  if (error?.status === 429) return 'rateLimit';
  if (error?.status >= 500 && error.status <= 599) return 'server';
  if (error?.status === 0 || ['TypeError', 'AbortError', 'TimeoutError'].includes(error?.name)) return 'networkOrTimeout';
  return 'other';
}

export function createFetchObserver(fetchImpl) {
  const statuses = {};
  let networkFailures = 0;
  return {
    async fetch(...args) {
      try {
        const response = await fetchImpl(...args);
        if (Number.isInteger(response.status) && response.status >= 100 && response.status <= 599) {
          statuses[response.status] = (statuses[response.status] || 0) + 1;
        }
        return response;
      } catch (error) { networkFailures += 1; throw error; }
    },
    getSnapshot: () => ({ statuses: { ...statuses }, networkFailures }),
  };
}

export async function runUploadLoadTest({
  endpoint, clients, filesPerClient, photo, uploadCode,
  upload = uploadPhoto, uuid = randomUUID, now = () => performance.now(),
  setIntervalFn = setInterval, clearIntervalFn = clearInterval, reportProgress = () => {},
}) {
  const totalFiles = clients * filesPerClient;
  const totalBytes = totalFiles * photo.size;
  const started = now();
  const fileDurations = [];
  const queueDurations = [];
  const acknowledged = new Map();
  const failureCounts = { authorization: 0, rateLimit: 0, server: 0, networkOrTimeout: 0, other: 0 };
  let confirmedFiles = 0;
  let failedFiles = 0;
  let successfulGuests = 0;
  let activeGuests = clients;
  let activeFiles = 0;
  let running = true;
  const acknowledgedBytes = () => [...acknowledged.values()].reduce((sum, bytes) => sum + bytes, 0);
  const timer = setIntervalFn(() => {
    if (!running) return;
    try {
      reportProgress({
        elapsedMs: Math.max(0, now() - started), activeGuests, activeFiles, confirmedFiles, failedFiles,
        totalFiles, totalBytes, acknowledgedBytes: acknowledgedBytes(),
      });
    } catch { /* Reporting must never interrupt real uploads. */ }
  }, 5000);
  try {
    await Promise.all(Array.from({ length: clients }, async () => {
      const queueStarted = now();
      let queueOk = true;
      for (let index = 0; index < filesPerClient; index += 1) {
        const fileStarted = now();
        activeFiles += 1;
        try {
          const uploadId = uuid();
          const extension = photo.type === 'image/jpeg' ? 'jpg' : 'bmp';
          const file = new File([photo], `load-test-${uploadId}.${extension}`, { type: photo.type || 'image/bmp' });
          acknowledged.set(uploadId, 0);
          const receipt = await upload(endpoint, { uploadId, file, guestName: 'Upload capacity test' }, {
            provider: 'cloud-run', uploadCode,
            onProgress({ uploadedBytes }) {
              if (Number.isSafeInteger(uploadedBytes) && uploadedBytes >= 0 && uploadedBytes <= photo.size) acknowledged.set(uploadId, uploadedBytes);
            },
          });
          if (receipt?.ok !== true || receipt.uploadId !== uploadId) throw new Error('Unconfirmed upload.');
          acknowledged.set(uploadId, photo.size);
          confirmedFiles += 1;
          fileDurations.push(Math.max(0, now() - fileStarted));
        } catch (error) {
          failedFiles += 1;
          queueOk = false;
          failureCounts[failureCategory(error)] += 1;
        } finally { activeFiles -= 1; }
      }
      if (queueOk) successfulGuests += 1;
      queueDurations.push(Math.max(0, now() - queueStarted));
      activeGuests -= 1;
    }));
  } finally {
    running = false;
    clearIntervalFn(timer);
  }
  const elapsedMs = Math.max(0, now() - started);
  return {
    totalFiles, confirmedFiles, failedFiles, successfulGuests, totalGuests: clients, elapsedMs,
    acknowledgedBytes: acknowledgedBytes(), totalBytes, failureCounts,
    fileDurationsMs: { p50: percentile(fileDurations, 0.5), p95: percentile(fileDurations, 0.95), max: fileDurations.length ? Math.max(...fileDurations) : null },
    guestQueueP95Ms: percentile(queueDurations, 0.95),
    throughputBytesPerSecond: elapsedMs > 0 ? confirmedFiles * photo.size / (elapsedMs / 1000) : 0,
  };
}
