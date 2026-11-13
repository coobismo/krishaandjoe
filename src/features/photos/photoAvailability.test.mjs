import assert from 'node:assert/strict';
import test from 'node:test';
import { isPhotoAreaVisible } from './photoAvailability.mjs';

test('homepage memories link appears at midnight on the wedding day in Manila', () => {
  assert.equal(isPhotoAreaVisible({ now: Date.parse('2026-11-20T15:59:59.999Z') }), false);
  assert.equal(isPhotoAreaVisible({ now: Date.parse('2026-11-20T16:00:00Z') }), true);
  assert.equal(isPhotoAreaVisible({ now: Date.parse('2026-11-21T06:00:00Z') }), true);
});

test('query parameters do not reveal the homepage link before the wedding', () => {
  const now = Date.parse('2026-11-10T00:00:00Z');
  assert.equal(isPhotoAreaVisible({ now, search: '?preview=memories' }), false);
  assert.equal(isPhotoAreaVisible({ now, search: '?preview=false' }), false);
  assert.equal(isPhotoAreaVisible({ now, search: '?preview=gallery' }), false);
  assert.equal(isPhotoAreaVisible({ now }), false);
});
