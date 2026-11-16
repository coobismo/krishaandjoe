const RETRY_DELAYS_MS = [3000, 8000, 15_000, 30_000, 60_000];
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);

function transient(failure) {
  if (failure?.name === 'AbortError' || [401, 403, 404].includes(failure?.status)
      || failure?.code === 'unauthorized') return false;
  return TRANSIENT_STATUSES.has(failure?.status)
    || (failure?.name === 'GalleryError' && ['network', 'timeout'].includes(failure.code));
}

function notify(callback, value) {
  try {
    // UI callbacks cannot turn a successful fetch into a failed preview or
    // prevent retries after a temporary Drive processing error.
    const result = callback?.(value);
    result?.catch?.(() => {});
  } catch { /* Callback failures do not affect the request lifecycle. */ }
}

// A pending video thumbnail may take longer than one gallery polling cycle.
// Keep checking while the page is active, without retrying unavailable photos
// or continuing requests in a hidden/offline page.
export function createGalleryPreviewLoader({
  load, onLoad, onError, onLoading, retryTransient = false, foreground = true,
  setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout,
}) {
  if (typeof load !== 'function') throw new TypeError('A preview loader is required.');
  let started = false;
  let disposed = false;
  let ready = false;
  let terminal = false;
  let failures = 0;
  let generation = 0;
  let active = null;
  let timer = null;

  const allowed = () => started && !disposed && foreground && !ready && !terminal;
  const current = (operation) => !disposed && active === operation
    && generation === operation.generation && !operation.controller.signal.aborted;

  function clearSchedule() {
    if (timer !== null) clearTimeoutFn(timer);
    timer = null;
  }

  function cancelActive() {
    generation += 1;
    const operation = active;
    active = null;
    operation?.controller.abort();
  }

  function schedule() {
    clearSchedule();
    if (!allowed() || active) return;
    const delay = RETRY_DELAYS_MS[Math.min(failures - 1, RETRY_DELAYS_MS.length - 1)];
    timer = setTimeoutFn(() => {
      timer = null;
      run();
    }, delay);
  }

  function run() {
    if (!allowed() || active) return active?.promise;
    clearSchedule();
    const operation = { controller: new AbortController(), generation: ++generation };
    active = operation;
    notify(onLoading);
    // A callback may synchronously hide or dispose its component.
    if (!current(operation)) return;
    operation.promise = (async () => {
      try {
        const blob = await load({ signal: operation.controller.signal });
        if (!current(operation)) return;
        active = null;
        ready = true;
        failures = 0;
        clearSchedule();
        notify(onLoad, blob);
      } catch (failure) {
        if (!current(operation)) return;
        active = null;
        terminal = !(retryTransient && transient(failure));
        if (!terminal) failures += 1;
        notify(onError, failure);
        // An explicit retry/pause/dispose from onError takes precedence.
        if (generation === operation.generation) schedule();
      }
    })();
    return operation.promise;
  }

  return {
    start() {
      if (disposed || started) return active?.promise;
      started = true;
      return run();
    },
    setForeground(value) {
      if (disposed || foreground === Boolean(value)) return;
      foreground = Boolean(value);
      clearSchedule();
      if (!foreground) cancelActive();
      else return run();
    },
    retry() {
      if (disposed || active) return active?.promise;
      started = true;
      ready = false;
      terminal = false;
      failures = 0;
      clearSchedule();
      return run();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearSchedule();
      cancelActive();
    },
  };
}
