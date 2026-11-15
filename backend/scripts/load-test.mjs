import { hiddenPrompts } from './cloud-helpers.mjs';
import {
  createFetchObserver, createLoadTestPhoto, LoadTestError, parseLoadTestArgs,
  planLoadTest, readLoadTestPhoto, runUploadLoadTest,
} from './load-test-helpers.mjs';

const mib = (bytes) => (bytes / 1024 / 1024).toFixed(1);
const seconds = (milliseconds) => milliseconds === null ? 'n/a' : `${(milliseconds / 1000).toFixed(1)} s`;

async function main() {
  const options = parseLoadTestArgs(process.argv.slice(2));
  const source = options.filePath ? await readLoadTestPhoto(options.filePath, options) : null;
  const plan = planLoadTest({ ...options, ...(source ? { fileBytes: source.fileBytes } : {}) });
  console.log(`Planned: ${plan.clients} guest ${plan.clients === 1 ? 'queue' : 'queues'} × ${plan.filesPerClient} ${plan.filesPerClient === 1 ? 'file' : 'files'} = ${plan.totalFiles} ${source ? 'JPEG test copies' : 'generated BMP files'}, ${mib(plan.totalBytes)} MiB total (${plan.fileBytes} bytes per file).`);
  console.log('Load-test photos appear in the gallery with the updated backend. Redeploy the backend before testing gallery behavior.');
  console.log('A real run writes these files into the backend’s configured Drive folder. Use a dedicated test deployment and folder.');
  if (options.dryRun) {
    console.log('Dry run complete: no password prompt, network requests, or files created.');
    return;
  }

  let prompts;
  let uploadCode;
  try {
    prompts = hiddenPrompts();
    uploadCode = await prompts.ask('Guest upload password');
  } catch (error) {
    const safeMessages = new Set([
      'Run this helper in an interactive terminal to enter credentials privately.',
      'Input cancelled. Run the command again when you are ready.',
    ]);
    throw new LoadTestError(safeMessages.has(error?.message) ? error.message : 'Could not read the guest password privately. Run this helper again in an interactive terminal.');
  } finally { prompts?.close(); }
  if (!uploadCode) throw new LoadTestError('A guest upload password is required.');

  const photo = source?.photo ?? createLoadTestPhoto(options.megabytes);
  console.log('Starting uploader-protocol test. Browser UI, CORS and gallery traffic are not included.');
  const nativeFetch = globalThis.fetch;
  const observer = createFetchObserver(nativeFetch);
  let result;
  try {
    globalThis.fetch = observer.fetch;
    result = await runUploadLoadTest({
      ...options, photo, uploadCode,
      reportProgress(progress) {
        console.log(`${seconds(progress.elapsedMs)}: ${progress.confirmedFiles}/${progress.totalFiles} confirmed, ${progress.failedFiles} failed, ${progress.activeGuests} active guest queues; ${mib(progress.acknowledgedBytes)}/${mib(progress.totalBytes)} MiB acknowledged.`);
      },
    });
  } finally { globalThis.fetch = nativeFetch; }

  console.log(`Confirmed files: ${result.confirmedFiles}/${result.totalFiles}. Failed files: ${result.failedFiles}. Successful guest queues: ${result.successfulGuests}/${result.totalGuests}.`);
  console.log(`Elapsed: ${seconds(result.elapsedMs)}. Confirmed-file throughput: ${mib(result.throughputBytesPerSecond)} MiB/s.`);
  console.log(`Successful-file times: p50 ${seconds(result.fileDurationsMs.p50)}, p95 ${seconds(result.fileDurationsMs.p95)}, max ${seconds(result.fileDurationsMs.max)}.`);
  console.log(`Guest queue p95 (all queues): ${seconds(result.guestQueueP95Ms)}.`);
  console.log(`Final file failures by category: ${JSON.stringify(result.failureCounts)}.`);
  console.log(`HTTP request observations: ${JSON.stringify(observer.getSnapshot())}.`);
  console.log(`Review Cloud Run, Drive quota and Firestore metrics; remove generated load-test-*.${source ? 'jpg' : 'bmp'} files from the test folder when finished.`);
  if (result.failedFiles) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof LoadTestError ? error.message : 'The load test could not finish. Check Node.js 22 or newer and the test configuration. No private error details were printed.');
  process.exitCode = 1;
});
