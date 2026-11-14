const MAX_GUEST_NAME_LENGTH = 100;

// This is an optional public credit, never a source of file metadata. Bound
// malformed legacy values and keep complete Unicode characters when shortening.
export function normalizeGuestName(value) {
  if (typeof value !== 'string' || value.length > 4096 || !value.isWellFormed()) return undefined;
  const clean = value.normalize('NFC').replace(/\s+/gu, ' ')
    .replace(/[\p{Cc}\p{Cf}]/gu, (character) => /[\u200c\u200d]/u.test(character) ? character : '')
    .trim();
  if (!/[\p{L}\p{N}\p{P}\p{S}]/u.test(clean)) return undefined;
  let name = '';
  for (const character of clean) {
    if (name.length + character.length > MAX_GUEST_NAME_LENGTH) break;
    name += character;
  }
  return name.trim() || undefined;
}

// Only recover the exact description format written by the uploader. Other
// Drive descriptions may contain private notes and must never become credits.
export function guestNameFromUploadDescription(description) {
  if (typeof description !== 'string' || description.length > 130) return undefined;
  const match = /^Shared by ([^\p{Cc}\p{Zl}\p{Zp}]{1,120})$/u.exec(description);
  if (!match || match[0] !== description || match[1].length > 120) return undefined;
  return normalizeGuestName(match[1]);
}
