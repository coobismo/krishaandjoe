export const PHOTO_RELEASE_AT = '2026-11-21T00:00:00+08:00';

export function isPhotoAreaVisible({ now = Date.now(), search = '', releaseAt = PHOTO_RELEASE_AT } = {}) {
  if (new URLSearchParams(search).get('preview') === 'memories') return true;
  const launch = Date.parse(releaseAt);
  return Number.isFinite(launch) && now >= launch;
}
