export const PHOTO_RELEASE_AT = '2026-11-21T00:00:00+08:00';

// The homepage link stays scheduled; the dedicated memories page is available
// directly at any time behind the guest password.
export function isPhotoAreaVisible({ now = Date.now(), releaseAt = PHOTO_RELEASE_AT } = {}) {
  const launch = Date.parse(releaseAt);
  return Number.isFinite(launch) && now >= launch;
}
