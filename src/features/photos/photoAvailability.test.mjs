import assert from 'node:assert/strict';
import test from 'node:test';
import { isPhotoAreaVisible } from './photoAvailability.mjs';

test('photo area opens at midnight on the wedding day in Manila', () => {
  assert.equal(isPhotoAreaVisible({ now: Date.parse('2026-11-20T15:59:59.999Z') }), false);
  assert.equal(isPhotoAreaVisible({ now: Date.parse('2026-11-20T16:00:00Z') }), true);
  assert.equal(isPhotoAreaVisible({ now: Date.parse('2026-11-21T06:00:00Z') }), true);
});

test('only the explicit memories preview enables testing before launch', () => {
  const now = Date.parse('2026-11-10T00:00:00Z');
  assert.equal(isPhotoAreaVisible({ now, search: '?preview=memories' }), true);
  assert.equal(isPhotoAreaVisible({ now, search: '?preview=false' }), false);
  assert.equal(isPhotoAreaVisible({ now, search: '?preview=gallery' }), false);
  assert.equal(isPhotoAreaVisible({ now }), false);
});
