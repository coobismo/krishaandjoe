import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isUploadEndpoint, uploadPhoto } from '../../src/features/photos/uploadPhoto.mjs';
import { hiddenPrompts } from './cloud-helpers.mjs';

// Generate a real uncompressed BMP, shared across the concurrent test Files.
// No guest content is read and no Google credentials are needed on the client.
function testPhoto(megabytes) {
  const width = 1024;
  const rowBytes = width * 3;
  const height = Math.max(1, Math.floor((megabytes * 1024 * 1024 - 54) / rowBytes));
  const pixels = rowBytes * height;
  const bytes = Buffer.alloc(54 + pixels);
  bytes.write('BM');
  bytes.writeUInt32LE(bytes.length, 2);
  bytes.writeUInt32LE(54, 10);
  bytes.writeUInt32LE(40, 14);
  bytes.writeInt32LE(width, 18);
  bytes.writeInt32LE(height, 22);
  bytes.writeUInt16LE(1, 26);
  bytes.writeUInt16LE(24, 28);
  bytes.writeUInt32LE(pixels, 34);
  return new Blob([bytes], { type: 'image/bmp' });
}

try {
  const args = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index += 2) options[args[index]] = args[index + 1];
  const endpoint = options['--endpoint'];
  const clients = Number(options['--clients'] || 10);
  const megabytes = Number(options['--megabytes'] || 8);
  if (!isUploadEndpoint(endpoint, 'cloud-run') || !Number.isInteger(clients) || clients < 1 || clients > 100
      || !Number.isInteger(megabytes) || megabytes < 1 || megabytes > 32) {
    throw new Error('Usage: node backend/scripts/load-test.mjs --endpoint https://YOUR_SERVICE.run.app --clients 10 --megabytes 8');
  }
  const photo = testPhoto(megabytes);
  console.log(`This test creates ${clients} generated BMP files in the backend's configured Drive folder (${(clients * photo.size / 1024 / 1024).toFixed(1)} MB total). Use a dedicated test folder.`);
  const prompts = hiddenPrompts();
  let uploadCode;
  try { uploadCode = await prompts.ask('Guest upload password'); }
  finally { prompts.close(); }
  if (!uploadCode) throw new Error('A guest upload password is required.');

  const started = performance.now();
  const results = await Promise.all(Array.from({ length: clients }, async () => {
    const uploadId = randomUUID();
    const file = new File([photo], `load-test-${uploadId}.bmp`, { type: 'image/bmp' });
    const start = performance.now();
    try {
      await uploadPhoto(endpoint, { uploadId, file, guestName: 'Upload capacity test' }, { provider: 'cloud-run', uploadCode });
      return { ok: true, duration: performance.now() - start };
    } catch {
      return { ok: false, duration: performance.now() - start };
    }
  }));
  const successful = results.filter((result) => result.ok).map((result) => result.duration).sort((left, right) => left - right);
  const elapsed = (performance.now() - started) / 1000;
  console.log(`Confirmed uploads: ${successful.length}/${clients}. Total elapsed: ${elapsed.toFixed(1)} seconds.`);
  if (successful.length) {
    const p95 = successful[Math.max(0, Math.ceil(successful.length * 0.95) - 1)] / 1000;
    console.log(`95th percentile completion time for successful files: ${p95.toFixed(1)} seconds.`);
  }
  console.log('Inspect Cloud Run and Drive quota metrics, then remove the load-test files from the test folder when finished.');
  if (successful.length !== clients) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
