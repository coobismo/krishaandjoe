import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const helpersUrl = new URL('../scripts/cloud-helpers.mjs', import.meta.url).href;

function fakeCli(t, source) {
  const directory = mkdtempSync(join(tmpdir(), 'wedding-cli-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  if (source !== undefined) {
    const executable = join(directory, 'gcloud');
    writeFileSync(executable, `#!/bin/sh\n${source}\n`, { mode: 0o700 });
    chmodSync(executable, 0o700);
  }
  return directory;
}

function runHelper(directory, invocation) {
  const source = `
    import { gcloud, gcloudWithProgress, checkGcloudSignIn } from ${JSON.stringify(helpersUrl)};
    try { ${invocation} }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  `;
  const started = Date.now();
  // PATH contains only this fixture directory: no real Google CLI or account
  // can be used, even on a developer machine where gcloud is installed.
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...process.env, PATH: directory }, encoding: 'utf8', timeout: 2500,
  });
  assert.equal(result.error, undefined, `Helper did not terminate normally: ${result.error?.message}`);
  assert.equal(result.signal, null);
  return { ...result, elapsedMs: Date.now() - started };
}

test('missing CLI gives installation guidance for both synchronous and asynchronous commands', (t) => {
  const directory = fakeCli(t);
  for (const invocation of [
    "gcloud(['--version'], { quiet: true, timeoutMs: 100 });",
    "await gcloudWithProgress(['services', 'enable'], { timeoutMs: 100, progressMs: 10 });",
  ]) {
    const result = runHelper(directory, invocation);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Google Cloud CLI \(gcloud\) was not found/);
    assert.match(result.stderr, /gcloud auth login/);
    assert.ok(result.elapsedMs < 2000, 'A failed spawn must clean up its progress interval and deadline');
  }
});

test('synchronous credential command timeout is bounded and suppresses private subprocess output', (t) => {
  const secretMarker = 'PRIVATE_FIXTURE_SECRET_MUST_STAY_HIDDEN';
  const directory = fakeCli(t, `
    printf '%s' '${secretMarker}' >&2
    printf '%s' '${secretMarker}'
    if [ "$1" = 'fixture-fail' ]; then exit 7; fi
    exec /bin/sleep 60
  `);
  const rejected = runHelper(directory, `gcloud(['fixture-fail'], { input: 'dummy-private-input' });`);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /operation failed/);
  assert.ok(!`${rejected.stdout}${rejected.stderr}`.includes(secretMarker));
  const result = runHelper(directory, `
    gcloud(['secrets', 'versions', 'add', 'test-secret'], {
      input: 'dummy-private-input', quiet: true, timeoutMs: 150,
    });
  `);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /operation timed out \(secrets versions\)/);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(secretMarker));
  assert.ok(!`${result.stdout}${result.stderr}`.includes('dummy-private-input'));
  assert.ok(result.elapsedMs < 2000);
});

test('asynchronous API enablement prints progress, terminates on timeout, and cleans up timers', (t) => {
  const directory = fakeCli(t, 'exec /bin/sleep 60');
  const result = runHelper(directory, `
    await gcloudWithProgress(['services', 'enable'], {
      label: 'Still enabling fixture APIs', progressMs: 20, timeoutMs: 150,
    });
  `);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Still enabling fixture APIs \(\d+ seconds\)/);
  assert.match(result.stderr, /operation timed out \(services enable\)/);
  assert.ok(result.elapsedMs < 2000, 'Progress and timeout handles must not keep the process alive');
});

test('successful asynchronous commands finish without leaving a heartbeat or timeout running', (t) => {
  const directory = fakeCli(t, 'exit 0');
  const result = runHelper(directory, `
    await gcloudWithProgress(['services', 'enable'], {
      label: 'Fixture API operation', progressMs: 10, timeoutMs: 1000,
    });
    console.log('Fixture command completed');
  `);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Fixture command completed/);
  assert.equal(result.stderr, '');
  assert.ok(result.elapsedMs < 900, 'A completed command must clear the one-second timeout immediately');
});

test('a CLI without an active account stops before setup and explains how to sign in', (t) => {
  const directory = fakeCli(t, `
    if [ "$1" = '--version' ]; then printf '%s' 'Google Cloud SDK fixture'
    elif [ "$1" != 'auth' ] || [ "$2" != 'list' ]; then exit 2
    fi
  `);
  const result = runHelper(directory, 'checkGcloudSignIn();');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No active Google Cloud sign-in/);
  assert.match(result.stderr, /gcloud auth login/);
  assert.equal(result.stdout, '');
});
