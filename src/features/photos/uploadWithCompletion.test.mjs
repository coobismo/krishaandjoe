import assert from 'node:assert/strict';
import test from 'node:test';
import { uploadWithCompletion } from './uploadWithCompletion.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

test('one confirmed file notifies once after saving, never during progress or before its receipt', async (t) => {
  const transport = deferred();
  const receipt = { ok: true, uploadId: 'single-file' };
  const events = [];
  const progress = (bytes) => events.push(`progress:${bytes}`);
  const onSaved = t.mock.fn(() => events.push('saved'));
  const onComplete = t.mock.fn(() => {
    assert.equal(events.at(-1), 'saved');
    events.push('complete');
  });
  const upload = t.mock.fn(() => transport.promise);
  const pending = uploadWithCompletion(upload, { isActive: () => true, onSaved, onComplete });

  for (const bytes of [0, 1024, 4096]) progress(bytes);
  await Promise.resolve();
  assert.equal(onSaved.mock.callCount(), 0);
  assert.equal(onComplete.mock.callCount(), 0);

  transport.resolve(receipt);
  assert.equal(await pending, receipt);
  assert.equal(upload.mock.callCount(), 1);
  assert.equal(onSaved.mock.callCount(), 1);
  assert.equal(onComplete.mock.callCount(), 1);
  assert.deepEqual(events, ['progress:0', 'progress:1024', 'progress:4096', 'saved', 'complete']);
});

test('failed transports never report a saved file or trigger a gallery update', async (t) => {
  const failure = new Error('Upload could not be confirmed');
  const onSaved = t.mock.fn();
  const onComplete = t.mock.fn();
  for (const upload of [
    () => Promise.reject(failure),
    () => { throw failure; },
  ]) {
    await assert.rejects(uploadWithCompletion(upload, { isActive: () => true, onSaved, onComplete }), (error) => error === failure);
  }
  assert.equal(onSaved.mock.callCount(), 0);
  assert.equal(onComplete.mock.callCount(), 0);
});

test('unmounting before confirmation suppresses both UI callbacks while preserving the receipt', async (t) => {
  const transport = deferred();
  const receipt = { ok: true, uploadId: 'finished-after-unmount' };
  let active = true;
  const onSaved = t.mock.fn();
  const onComplete = t.mock.fn();
  const pending = uploadWithCompletion(() => transport.promise, {
    isActive: () => active, onSaved, onComplete,
  });
  active = false;
  transport.resolve(receipt);
  assert.equal(await pending, receipt);
  assert.equal(onSaved.mock.callCount(), 0);
  assert.equal(onComplete.mock.callCount(), 0);
});

test('synchronous and asynchronous gallery failures cannot reject receipts or stop following uploads', async () => {
  for (const onComplete of [
    () => { throw new Error('Gallery consumer failed'); },
    () => Promise.reject(new Error('Gallery request failed')),
  ]) {
    const saved = [];
    const receipts = [{ ok: true, uploadId: 'first' }, { ok: true, uploadId: 'second' }];
    for (const receipt of receipts) {
      const result = await uploadWithCompletion(async () => receipt, {
        isActive: () => true,
        onSaved: () => saved.push(receipt.uploadId),
        onComplete,
      });
      assert.equal(result, receipt);
    }
    assert.deepEqual(saved, ['first', 'second']);
    // Let any rejected consumer promise settle; an unhandled rejection would
    // fail this test rather than silently escaping the upload boundary.
    await new Promise((resolve) => setImmediate(resolve));
  }
});

test('an unfinished gallery refresh does not delay the saved receipt or the next upload', { timeout: 1000 }, async () => {
  const gallery = deferred();
  const events = [];
  const options = {
    isActive: () => true,
    onSaved: () => events.push('saved'),
    onComplete: () => { events.push('gallery'); return gallery.promise; },
  };
  const first = { ok: true, uploadId: 'first' };
  const second = { ok: true, uploadId: 'second' };
  assert.equal(await uploadWithCompletion(async () => first, options), first);
  assert.equal(await uploadWithCompletion(async () => second, options), second);
  assert.deepEqual(events, ['saved', 'gallery', 'saved', 'gallery']);
  gallery.resolve();
});
