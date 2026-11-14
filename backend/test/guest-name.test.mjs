import assert from 'node:assert/strict';
import test from 'node:test';
import { guestNameFromUploadDescription, normalizeGuestName } from '../src/guest-name.mjs';

test('guest credits clean controls and whitespace while preserving Unicode names', () => {
  assert.equal(normalizeGuestName('  Jose\u0301\n\t dela\u0000 Cruz\u202e  '), 'José dela Cruz');
  assert.equal(normalizeGuestName('李 📷 👩‍👩‍👧‍👦'), '李 📷 👩‍👩‍👧‍👦');
  assert.equal(normalizeGuestName('A'.repeat(120)), 'A'.repeat(100));
  assert.equal(normalizeGuestName('A'.repeat(98) + '📷' + 'B'), 'A'.repeat(98) + '📷');
  assert.equal(normalizeGuestName('A'.repeat(99) + '📷'), 'A'.repeat(99));
  for (const value of [undefined, null, 42, {}, '', '\n\t\u200b\u200d', '\ud800', 'A'.repeat(4097)]) {
    assert.equal(normalizeGuestName(value), undefined);
  }
});

test('legacy descriptions recover only the exact bounded uploader credit format', () => {
  assert.equal(guestNameFromUploadDescription('Shared by  José   Cruz  '), 'José Cruz');
  assert.equal(guestNameFromUploadDescription('Shared by ' + 'J'.repeat(120)), 'J'.repeat(100));
  for (const description of [
    undefined, null, {}, 'Private Drive note', ' shared by Jo', 'Shared by ',
    'Shared by Jo\n', 'Shared by Jo\nPrivate note', 'Shared by Jo\tCruz',
    'Shared by Jo\u2028Cruz', 'Shared by Jo\u0000Cruz', 'Shared by ' + 'J'.repeat(121),
    'Shared by ' + '📷'.repeat(61),
  ]) assert.equal(guestNameFromUploadDescription(description), undefined);
});
