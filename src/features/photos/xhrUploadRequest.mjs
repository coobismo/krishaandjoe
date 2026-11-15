const networkFailure = () => new TypeError('The upload request could not be completed.');
const aborted = () => new DOMException('The upload request was aborted.', 'AbortError');

// Upload progress measures bytes sent to our backend, not bytes saved in Drive.
// Only the completed HTTP response can supply a receipt for verification.
export function xhrUploadRequest(url, { method = 'PUT', headers = {}, body, signal, onUploadProgress } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(aborted()); return; }
    let xhr;
    let settled = false;
    const bodyBytes = Number.isSafeInteger(body?.size) ? body.size : body?.byteLength;

    function cleanup() {
      signal?.removeEventListener('abort', onAbort);
      if (!xhr) return;
      xhr.onload = xhr.onerror = xhr.onabort = xhr.ontimeout = null;
      xhr.upload.onprogress = xhr.upload.onload = null;
    }

    function finish(callback, value) {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    }

    function onAbort() {
      if (settled) return;
      finish(reject, aborted());
      try { xhr.abort(); } catch { /* The request may already be closed. */ }
    }

    function report(loaded) {
      if (settled || !Number.isSafeInteger(loaded) || loaded < 0) return;
      const bytes = Number.isSafeInteger(bodyBytes) ? Math.min(bodyBytes, loaded) : loaded;
      try { onUploadProgress?.(bytes); } catch { /* Reporting cannot interrupt a real upload. */ }
    }

    try {
      const expectedUrl = new URL(url).href;
      xhr = new XMLHttpRequest();
      // Register upload listeners before open/send for consistent browser support.
      xhr.upload.onprogress = (event) => report(event.loaded);
      xhr.upload.onload = (event) => report(Number.isSafeInteger(bodyBytes) ? bodyBytes : event.loaded);
      xhr.onload = () => {
        if (settled) return;
        try {
          if (!Number.isInteger(xhr.status) || xhr.status < 200 || xhr.status > 599
              || new URL(xhr.responseURL).href !== expectedUrl) {
            finish(reject, networkFailure());
            return;
          }
          // Read immutable response values before removing the event handlers.
          const status = xhr.status;
          const text = xhr.responseText;
          const retryAfter = xhr.getResponseHeader('Retry-After');
          finish(resolve, {
            ok: status >= 200 && status < 300,
            status,
            type: 'basic',
            headers: { get: (name) => typeof name === 'string' && name.toLowerCase() === 'retry-after' ? retryAfter : null },
            json: async () => JSON.parse(text),
          });
        } catch { finish(reject, networkFailure()); }
      };
      xhr.onerror = xhr.ontimeout = () => finish(reject, networkFailure());
      xhr.onabort = () => finish(reject, aborted());
      xhr.open(method, expectedUrl, true);
      xhr.withCredentials = false;
      for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) { onAbort(); return; }
      xhr.send(body);
    } catch {
      finish(reject, networkFailure());
    }
  });
}
