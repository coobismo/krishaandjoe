import assert from 'node:assert/strict';
import test from 'node:test';
import { GalleryError } from './galleryClient.mjs';
import { createGalleryPreviewLoader } from './galleryPreviewLoader.mjs';

const flush = async () => { for (let index = 0; index < 6; index += 1) await Promise.resolve(); };
const failure = (status) => new GalleryError('Preview unavailable.', 'unavailable', status);
const poster = () => new Blob(['preview'], { type: 'image/jpeg' });

function setup(t, options = {}) {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  const delays = [];
  const calls = [];
  const loaded = [];
  const errors = [];
  const loading = [];
  const loader = createGalleryPreviewLoader({
    load: (request) => new Promise((resolve, reject) => calls.push({ ...request, resolve, reject })),
    onLoad: (blob) => loaded.push(blob),
    onError: (error) => errors.push(error),
    onLoading: () => loading.push(true),
    retryTransient: true,
    setTimeoutFn(callback, delay) {
      const id = ++nextId;
      delays.push(delay);
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeoutFn: (id) => timers.delete(id),
    ...options,
  });
  t.after(() => loader.dispose());
  async function tick(duration) {
    const end = now + duration;
    while (true) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at;
      timers.delete(due[0]);
      due[1].callback();
      await flush();
    }
    now = end;
  }
  return { loader, timers, delays, calls, loaded, errors, loading, tick };
}

test('pending video previews keep retrying beyond four attempts, cap the delay, and stop once ready', async (t) => {
  const { loader, calls, errors, loading, loaded, timers, delays, tick } = setup(t);
  loader.start();
  for (const delay of [3000, 8000, 15_000, 30_000, 60_000, 60_000, 60_000]) {
    const before = calls.length;
    calls.at(-1).reject(failure(503));
    await flush();
    assert.equal(timers.size, 1);
    await tick(delay - 1);
    assert.equal(calls.length, before);
    await tick(1);
    assert.equal(calls.length, before + 1);
  }
  assert.deepEqual(delays, [3000, 8000, 15_000, 30_000, 60_000, 60_000, 60_000]);
  const blob = poster();
  calls.at(-1).resolve(blob);
  await flush();
  assert.deepEqual(loaded, [blob]);
  assert.equal(errors.length, 7);
  assert.equal(loading.length, 8);
  assert.equal(timers.size, 0);
  loader.start();
  loader.setForeground(false);
  loader.setForeground(true);
  await tick(120_000);
  assert.equal(calls.length, 8, 'A ready poster is retained on resume');
});

test('start and explicit retries coalesce while a request is active', async (t) => {
  const { loader, calls, timers, tick } = setup(t);
  const initial = loader.start();
  assert.equal(loader.start(), initial);
  assert.equal(loader.retry(), initial);
  assert.equal(calls.length, 1);
  await tick(300_000);
  assert.equal(calls.length, 1, 'Slow requests must not overlap scheduled requests');
  calls[0].reject(failure(503));
  await initial;
  assert.equal(timers.size, 1);
  const manual = loader.retry();
  assert.equal(calls.length, 2);
  assert.equal(timers.size, 0);
  assert.equal(loader.retry(), manual);
  calls[1].resolve(poster());
  await manual;
  await tick(300_000);
  assert.equal(calls.length, 2);
});

test('hidden or offline previews cancel timers and active work, then resume immediately and ignore old responses', async (t) => {
  const { loader, calls, loaded, errors, timers, tick } = setup(t, { foreground: false });
  loader.start();
  assert.equal(calls.length, 0);
  loader.setForeground(true);
  assert.equal(calls.length, 1);
  loader.setForeground(false);
  assert.equal(calls[0].signal.aborted, true);
  await tick(120_000);
  assert.equal(calls.length, 1);
  loader.setForeground(true);
  assert.equal(calls.length, 2);
  calls[0].resolve(poster());
  await flush();
  assert.equal(loaded.length, 0);
  assert.equal(errors.length, 0);
  calls[1].reject(failure(503));
  await flush();
  assert.equal(timers.size, 1);
  loader.setForeground(false);
  assert.equal(timers.size, 0);
  await tick(120_000);
  assert.equal(calls.length, 2);
  loader.setForeground(true);
  assert.equal(calls.length, 3, 'Returning online does not wait through the old delay');
  const blob = poster();
  calls[2].resolve(blob);
  await flush();
  assert.deepEqual(loaded, [blob]);
});

test('authorization, deletion, abort and permanent failures stop until an explicit retry', async (t) => {
  for (const error of [failure(401), failure(403), failure(404), failure(400), new DOMException('Cancelled.', 'AbortError')]) {
    const { loader, calls, errors, timers, tick } = setup(t);
    const initial = loader.start();
    calls[0].reject(error);
    await initial;
    assert.deepEqual(errors, [error]);
    assert.equal(timers.size, 0);
    loader.setForeground(false);
    loader.setForeground(true);
    await tick(300_000);
    assert.equal(calls.length, 1);
    const manual = loader.retry();
    assert.equal(calls.length, 2);
    calls[1].resolve(poster());
    await manual;
    loader.dispose();
  }
});

test('video network/timeouts and temporary HTTP failures retry, while image failures remain manual', async (t) => {
  for (const error of [failure(429), failure(500), failure(502), failure(504),
    new GalleryError('Network interrupted.', 'network'), new GalleryError('Deadline exceeded.', 'timeout')]) {
    const { loader, calls, timers, tick } = setup(t);
    const initial = loader.start();
    calls[0].reject(error);
    await initial;
    assert.equal(timers.size, 1);
    await tick(3000);
    assert.equal(calls.length, 2);
    loader.dispose();
  }
  for (const error of [failure(503), new GalleryError('Network interrupted.', 'network')]) {
    const { loader, calls, timers, tick } = setup(t, { retryTransient: false });
    const initial = loader.start();
    calls[0].reject(error);
    await initial;
    assert.equal(timers.size, 0);
    loader.setForeground(false);
    loader.setForeground(true);
    await tick(300_000);
    assert.equal(calls.length, 1);
    const manual = loader.retry();
    calls[1].resolve(poster());
    await manual;
    loader.dispose();
  }
});

test('dispose aborts requests, clears retries, and suppresses late results and future calls', async (t) => {
  const { loader, calls, loaded, errors, timers, tick } = setup(t);
  loader.start();
  loader.dispose();
  assert.equal(calls[0].signal.aborted, true);
  calls[0].resolve(poster());
  await flush();
  assert.equal(loaded.length, 0);
  assert.equal(errors.length, 0);
  loader.start();
  loader.retry();
  loader.setForeground(true);
  await tick(120_000);
  assert.equal(calls.length, 1);
  assert.equal(timers.size, 0);

  const pending = setup(t);
  pending.loader.start();
  pending.calls[0].reject(failure(503));
  await flush();
  assert.equal(pending.timers.size, 1);
  pending.loader.dispose();
  assert.equal(pending.timers.size, 0);
  await pending.tick(120_000);
  assert.equal(pending.calls.length, 1);
});

test('callback exceptions cannot turn successful loads into errors or disable automatic recovery', async (t) => {
  const calls = [];
  const events = [];
  const { loader, timers, tick } = setup(t, {
    load: (request) => new Promise((resolve, reject) => calls.push({ ...request, resolve, reject })),
    onLoading() { events.push('loading'); throw new Error('UI callback failed.'); },
    onError() { events.push('error'); throw new Error('UI callback failed.'); },
    onLoad() { events.push('load'); throw new Error('UI callback failed.'); },
  });
  const initial = loader.start();
  calls[0].reject(failure(503));
  await initial;
  assert.equal(timers.size, 1);
  await tick(3000);
  calls[1].resolve(poster());
  await flush();
  assert.deepEqual(events, ['loading', 'error', 'loading', 'load']);
  assert.equal(timers.size, 0);
});

test('synchronous load failures follow retry policy and errors from unrelated code remain terminal', async (t) => {
  let attempts = 0;
  const { loader, errors, timers, tick } = setup(t, {
    load() { attempts += 1; throw attempts === 1 ? failure(503) : new Error('Unexpected programming error.'); },
  });
  await loader.start();
  assert.equal(timers.size, 1);
  await tick(3000);
  assert.equal(attempts, 2);
  assert.equal(errors.length, 2);
  assert.equal(timers.size, 0);
});
