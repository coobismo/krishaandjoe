import assert from 'node:assert/strict';
import test from 'node:test';
import { uploadProgress } from './uploadProgress.mjs';

const entry = (changes = {}) => ({
  file: { size: 1000 }, status: 'uploading', phase: 'uploading', uploadedBytes: 200, ...changes,
});

test('display follows sent bytes while keeping confirmed server bytes separate', () => {
  const source = entry({ sentBytes: 635 });
  assert.deepEqual(uploadProgress(source), { percent: 63, indeterminate: false, label: 'Uploading 63%' });
  assert.equal(source.uploadedBytes, 200);
  assert.equal(uploadProgress(entry()).percent, 20, 'Fetch fallback uses the server offset');
  assert.equal(uploadProgress(entry({ uploadedBytes: 600, sentBytes: 200 })).percent, 60);
});

test('preparing is indeterminate and saving, checking and retrying have explicit status labels', () => {
  for (const [phase, label] of [
    ['preparing', 'Preparing upload…'], ['saving', 'Saving to our album…'],
    ['confirming', 'Checking your upload…'], ['retrying', 'Reconnecting…'],
  ]) {
    const progress = uploadProgress(entry({ phase, sentBytes: 750 }));
    assert.equal(progress.label, label);
    assert.equal(progress.indeterminate, phase === 'preparing');
  }
});

test('sending every byte never displays 100 percent before a verified success', () => {
  for (const phase of ['uploading', 'saving', 'confirming', 'retrying']) {
    assert.equal(uploadProgress(entry({ phase, uploadedBytes: 1000, sentBytes: 1000 })).percent, 99);
  }
  assert.deepEqual(uploadProgress(entry({ status: 'success' })), {
    percent: 100, indeterminate: false, label: 'Saved to our album',
  });
});

test('retry and expired-session offsets replace provisional sending progress without a stale high-water mark', () => {
  assert.equal(uploadProgress(entry({ uploadedBytes: 200, sentBytes: 900 })).percent, 90);
  assert.equal(uploadProgress(entry({ uploadedBytes: 200, sentBytes: 200, phase: 'retrying' })).percent, 20);
  assert.equal(uploadProgress(entry({ uploadedBytes: 0, sentBytes: 0 })).percent, 0);
});

test('invalid byte values remain bounded and non-uploading or Apps Script statuses stay readable', () => {
  for (const value of [-1, NaN, Infinity, 2.5, '500', null]) {
    assert.equal(uploadProgress(entry({ uploadedBytes: value, sentBytes: value })).percent, 0);
  }
  assert.equal(uploadProgress(entry({ sentBytes: 2000 })).percent, 99);
  assert.equal(uploadProgress(entry({ status: 'error', phase: 'confirming' })).label, 'Please try again');
  assert.equal(uploadProgress(entry({ status: 'ready', phase: 'saving' })).label, 'Ready to share');
  assert.deepEqual(uploadProgress(entry({ phase: 'preparing' }), 'apps-script'), {
    percent: 20, indeterminate: false, label: 'Uploading…',
  });
});
