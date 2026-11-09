import { execFileSync, spawn } from 'node:child_process';
import { Writable } from 'node:stream';
import { createInterface } from 'node:readline/promises';

export function argumentsFor(command) {
  const values = {};
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    if (!/^--[a-z-]+$/.test(args[index]) || !args[index + 1] || args[index + 1].startsWith('--')) {
      throw new Error(`Usage: ${command}`);
    }
    values[args[index].slice(2)] = args[index + 1];
  }
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(values.project || '')) {
    throw new Error(`Provide a Google Cloud project ID. Usage: ${command}`);
  }
  return values;
}

function commandFailure(args, error, timedOut = false) {
  if (error?.code === 'ENOENT') {
    return new Error('Google Cloud CLI (gcloud) was not found. Install it from https://cloud.google.com/sdk/docs/install, open a new terminal, then run gcloud auth login.');
  }
  if (timedOut || error?.code === 'ETIMEDOUT') {
    return new Error(`Google Cloud operation timed out (${args[0]} ${args[1] || ''}). Check your connection and Google Cloud console before retrying; the remote operation may still finish.`);
  }
  return new Error(`Google Cloud operation failed (${args[0]} ${args[1] || ''}). Check gcloud sign-in, project permissions and billing.`);
}

export function gcloud(args, { input, quiet = false, timeoutMs = 120_000 } = {}) {
  try {
    return execFileSync('gcloud', args, {
      input,
      encoding: 'utf8',
      stdio: quiet || input !== undefined ? ['pipe', 'pipe', 'pipe'] : ['inherit', 'inherit', 'inherit'],
      maxBuffer: 4 * 1024 * 1024,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    }) || '';
  } catch (error) {
    // Do not echo subprocess output from credential-related operations.
    throw commandFailure(args, error);
  }
}

// Only use for non-secret commands. The child output is visible and a heartbeat
// keeps long Google API operations from looking like an idle terminal.
export async function gcloudWithProgress(args, { timeoutMs = 15 * 60_000, progressMs = 15_000, label = 'Waiting for Google Cloud' } = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn('gcloud', args, { stdio: 'inherit' });
    const started = Date.now();
    let timedOut = false;
    const progress = setInterval(() => console.log(`${label} (${Math.round((Date.now() - started) / 1000)} seconds)…`), progressMs);
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const cleanup = () => { clearInterval(progress); clearTimeout(timeout); };
    child.once('error', (error) => { cleanup(); reject(commandFailure(args, error)); });
    child.once('close', (code) => {
      cleanup();
      if (code === 0 && !timedOut) resolve();
      else reject(commandFailure(args, null, timedOut));
    });
  });
}

export function checkGcloudSignIn() {
  gcloud(['--version'], { quiet: true, timeoutMs: 30_000 });
  const account = gcloud(['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)'], { quiet: true, timeoutMs: 30_000 }).trim();
  if (!account) throw new Error('No active Google Cloud sign-in. Run gcloud auth login, then retry this setup command.');
}

export function secretValue(project, name) {
  return gcloud(['secrets', 'versions', 'access', 'latest', '--secret', name, '--project', project], { quiet: true }).trim();
}

export function saveSecret(project, name, value) {
  const names = gcloud(['secrets', 'list', '--project', project, '--format=value(name)'], { quiet: true }).trim().split(/\s+/);
  const exists = names.some((item) => item === name || item.endsWith(`/${name}`));
  const args = exists
    ? ['secrets', 'versions', 'add', name, '--data-file=-']
    : ['secrets', 'create', name, '--replication-policy=automatic', '--data-file=-'];
  gcloud([...args, '--project', project, '--quiet'], { input: value });
}

export function hiddenPrompts() {
  if (!process.stdin.isTTY) throw new Error('Run this helper in an interactive terminal to enter credentials privately.');
  let muted = false;
  const output = new Writable({ write(chunk, encoding, callback) {
    if (!muted) process.stdout.write(chunk, encoding);
    callback();
  } });
  const reader = createInterface({ input: process.stdin, output, terminal: true });
  const cancellation = new AbortController();
  reader.on('SIGINT', () => reader.close());
  reader.once('close', () => cancellation.abort());
  return {
    async ask(label) {
      process.stdout.write(`${label}: `);
      muted = true;
      try { return (await reader.question('', { signal: cancellation.signal })).trim(); }
      catch (error) {
        if (cancellation.signal.aborted) throw new Error('Input cancelled. Run the command again when you are ready.');
        throw error;
      }
      finally { muted = false; process.stdout.write('\n'); }
    },
    close() { reader.close(); },
  };
}
