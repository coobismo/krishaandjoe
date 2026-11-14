export const GALLERY_REFRESH_MS = 30_000;
export const initialGalleryState = () => ({ photos: [], nextCursor: null, isLoading: false, isLoadingMore: false, error: '' });

const fingerprint = (page) => JSON.stringify([page.photos.map((photo) => photo.id), page.nextCursor]);
const sorted = (photos) => [...photos].sort((a, b) => (
  Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id)
));
const merged = (old, fresh) => sorted([...new Map([...old, ...fresh].map((photo) => [photo.id, photo])).values()]);

// One cancellable request and one completion-scheduled timer. The older-page
// cursor stays independent of gaps created by bursts of new photos at the top.
export function createGuestGalleryController({
  getPage, onChange = () => {}, intervalMs = GALLERY_REFRESH_MS,
  setTimer = setTimeout, clearTimer = clearTimeout, foreground = true, paused = false,
}) {
  let state = initialGalleryState();
  let active = null;
  let timer = null;
  let disposed = false;
  let authBlocked = false;
  let pendingCheck = false;
  let failures = 0;
  let tailCursor = null;
  let gaps = [];
  let head = null;
  let removalVersion = 0;
  const removals = new Map();
  const allowed = () => !disposed && foreground && !paused && !authBlocked;
  const cursor = () => gaps[0] || tailCursor;
  const publish = (update) => {
    if (disposed) return;
    state = { ...state, ...update };
    onChange(state);
  };
  function clearSchedule() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }
  function schedule() {
    clearSchedule();
    if (!allowed() || active) return;
    timer = setTimer(() => { timer = null; check(); }, intervalMs * Math.min(2 ** failures, 4));
  }
  function cancelActive() {
    active?.controller.abort();
    active = null;
  }
  function apply(page, operation) {
    const photos = page.photos.filter((photo) => (removals.get(photo.id) || 0) <= operation.removalVersion);
    if (operation.kind === 'refresh' || !head || (operation.kind === 'head' && page.nextCursor === null)) {
      tailCursor = page.nextCursor;
      gaps = [];
      head = { ...page, fingerprint: fingerprint(page) };
      publish({ photos: sorted(photos), nextCursor: cursor(), error: '' });
      return;
    }
    if (operation.kind === 'head') {
      let retained = state.photos;
      // An unchanged cursor identifies the same scanned index window; a
      // missing photo there is a verified removal, rather than an older page.
      if (head?.nextCursor === page.nextCursor) {
        const freshIds = new Set(page.photos.map((photo) => photo.id));
        const missing = new Set(head.photos.filter((photo) => !freshIds.has(photo.id)).map((photo) => photo.id));
        retained = retained.filter((photo) => !missing.has(photo.id));
      }
      const nextFingerprint = fingerprint(page);
      const existingIds = new Set(state.photos.map((photo) => photo.id));
      if (head && head.fingerprint !== nextFingerprint && head.nextCursor !== page.nextCursor
        && !photos.some((photo) => existingIds.has(photo.id))
        && page.nextCursor !== tailCursor && !gaps.includes(page.nextCursor)) gaps.unshift(page.nextCursor);
      head = { ...page, fingerprint: nextFingerprint };
      publish({ photos: merged(retained, photos), nextCursor: cursor(), error: '' });
      return;
    }
    if (page.nextCursor === null) { gaps = []; tailCursor = null; }
    else if (operation.gap) {
      if (page.photos.some((photo) => operation.existingIds.has(photo.id))) gaps.shift();
      else {
        gaps[0] = page.nextCursor;
        gaps = [...new Set(gaps)];
      }
    } else tailCursor = page.nextCursor;
    publish({ photos: merged(state.photos, photos), nextCursor: cursor(), error: '' });
  }
  async function run(kind) {
    if (disposed) return;
    clearSchedule();
    const operation = {
      kind, controller: new AbortController(), removalVersion,
      cursor: kind === 'more' ? cursor() : undefined,
      gap: kind === 'more' && gaps.length > 0,
      existingIds: new Set(state.photos.map((photo) => photo.id)),
    };
    active = operation;
    if (kind === 'refresh') publish({ isLoading: true, isLoadingMore: false, error: '' });
    if (kind === 'more') publish({ isLoadingMore: true, error: '' });
    try {
      const page = await getPage({ cursor: operation.cursor, signal: operation.controller.signal });
      if (disposed || active !== operation || operation.controller.signal.aborted) return;
      failures = 0;
      apply(page, operation);
    } catch (failure) {
      if (disposed || active !== operation || operation.controller.signal.aborted) return;
      const unauthorized = failure.status === 401 || failure.status === 403 || failure.code === 'unauthorized';
      if (unauthorized) authBlocked = true;
      if (kind === 'head') failures = Math.min(failures + 1, 2);
      if (kind !== 'head' || unauthorized) publish({ error: failure.message || 'We could not load the gallery. Please try again.' });
    } finally {
      if (!disposed && active === operation) {
        active = null;
        if (kind !== 'head') publish({ isLoading: false, isLoadingMore: false });
        if (pendingCheck && allowed()) { pendingCheck = false; check(); }
        else schedule();
      }
    }
  }
  function check() {
    if (!allowed()) return;
    if (active) { pendingCheck = true; return; }
    pendingCheck = false;
    return run('head');
  }
  return {
    getSnapshot: () => state,
    refresh({ preservePhotos = false } = {}) {
      if (disposed) return;
      authBlocked = false;
      failures = 0;
      if (preservePhotos) return check();
      cancelActive();
      pendingCheck = false;
      return run('refresh');
    },
    loadMore() {
      if (disposed || !cursor() || (active && active.kind !== 'head')) return;
      // Explicit pagination takes priority over a background head check.
      cancelActive();
      pendingCheck = false;
      return run('more');
    },
    check,
    removePhoto(id) {
      if (disposed) return;
      removals.set(id, ++removalVersion);
      publish({ photos: state.photos.filter((photo) => photo.id !== id) });
    },
    setForeground(value) {
      if (disposed || foreground === value) return false;
      foreground = value;
      clearSchedule();
      if (!value) {
        pendingCheck = false;
        if (active?.kind === 'head') cancelActive();
      } else check();
      return true;
    },
    setPaused(value) {
      if (disposed || paused === value) return;
      paused = value;
      clearSchedule();
      if (value) {
        pendingCheck = false;
        if (active?.kind === 'head') cancelActive();
      } else check();
    },
    dispose() {
      disposed = true;
      clearSchedule();
      cancelActive();
      removals.clear();
    },
  };
}
