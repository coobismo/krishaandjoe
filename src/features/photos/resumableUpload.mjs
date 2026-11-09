const CHUNK_ALIGNMENT = 256 * 1024;
const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
const UNCONFIRMED = 'We could not confirm this upload. Please try again; retrying the same file here will not create a duplicate.';

class RequestError extends Error {
  constructor(message = UNCONFIRMED, { status = 0, retryable = true, retryAfterMs = 0 } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

function responseMessage(status) {
  if (status === 401 || status === 403) return 'Your guest upload code was not accepted. Please refresh the site and try again.';
  if (status === 410) return 'This upload has expired. Please remove the file, select it again, and retry.';
  if (status === 413) return 'This file is too large to upload. Please choose a smaller photo or video.';
  if (status === 400 || status === 415 || status === 422) return 'This photo or video could not be accepted. Please choose another file.';
  return UNCONFIRMED;
}

function retryAfter(response) {
  const value = response.headers?.get?.('Retry-After');
  if (!value) return 0;
  const seconds = Number(value);
  const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(milliseconds) ? Math.min(30_000, Math.max(0, milliseconds)) : 0;
}

// Each request has its own deadline; a large upload can take as long as needed.
async function request(url, options, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new RequestError());
    }, timeoutMs);
  });
  const send = async () => {
    const response = await fetch(url, {
      ...options, mode: 'cors', redirect: 'error', credentials: 'omit', signal: controller.signal,
    });
    const retryAfterMs = retryAfter(response);
    let receipt;
    try {
      receipt = await response.json();
    } catch {
      throw new RequestError(responseMessage(response.status), {
        status: response.status,
        retryable: response.ok || [408, 409, 425, 429, 500, 502, 503, 504].includes(response.status),
        retryAfterMs,
      });
    }
    if (!response.ok || receipt?.ok !== true || response.type === 'opaque') {
      // Use local messages: service errors must never echo access codes or tokens.
      throw new RequestError(responseMessage(response.status), {
        status: response.status,
        retryable: receipt?.retryable === true || [408, 409, 425, 429, 500, 502, 503, 504].includes(response.status),
        retryAfterMs,
      });
    }
    return receipt;
  };
  try {
    return await Promise.race([send(), deadline]);
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError();
  } finally {
    clearTimeout(timer);
  }
}

function validateReceipt(receipt, uploadId, size, needsToken = false) {
  if (receipt?.ok !== true || receipt.uploadId !== uploadId
    || !['uploading', 'complete'].includes(receipt.status)
    || !Number.isSafeInteger(receipt.uploadedBytes) || receipt.uploadedBytes < 0 || receipt.uploadedBytes > size
    || !Number.isSafeInteger(receipt.chunkBytes) || receipt.chunkBytes <= 0
    || receipt.chunkBytes > MAX_CHUNK_BYTES || receipt.chunkBytes % CHUNK_ALIGNMENT !== 0
    || (receipt.status === 'complete' && receipt.uploadedBytes !== size)
    || (needsToken && (typeof receipt.token !== 'string' || !receipt.token || receipt.token.length > 4096 || /[\r\n]/.test(receipt.token)))) {
    throw new RequestError();
  }
  return receipt;
}

export async function uploadResumablePhoto(endpoint, { file, uploadId, guestName, mimeType }, options) {
  const { uploadCode, onProgress, timeoutMs = 120_000, retryBaseMs = 500 } = options;
  const maxRetries = Math.max(0, Math.min(3, Number.isInteger(options.maxRetries) ? options.maxRetries : 3));
  if (typeof uploadCode !== 'string' || !uploadCode.trim() || /[\r\n]/.test(uploadCode)) {
    throw new RequestError('Photo uploads are not connected yet. Please try again later.', { retryable: false });
  }
  if (typeof file.slice !== 'function') {
    throw new RequestError('We could not read this file. Please select it again.', { retryable: false });
  }
  const waitBeforeRetry = async (attempt, error) => {
    const jitter = 0.75 + Math.random() * 0.5;
    const backoff = Math.min(30_000, Math.max(0, retryBaseMs) * 2 ** attempt * jitter);
    const delay = Math.max(error?.retryAfterMs || 0, backoff);
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  };
  const withRetry = async (operation) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (!(error instanceof RequestError) || !error.retryable || attempt >= maxRetries) throw error;
        await waitBeforeRetry(attempt, error);
      }
    }
  };
  const progress = (receipt, phase = receipt.status === 'complete' ? 'confirming' : 'uploading') => {
    if (typeof onProgress !== 'function') return;
    try {
      onProgress({ uploadedBytes: receipt.uploadedBytes, totalBytes: file.size, phase });
    } catch {
      // A UI callback must never turn a confirmed upload into a retried request.
    }
  };

  const uploadUrl = `${endpoint}/v1/uploads`;
  let receipt = await withRetry(async () => validateReceipt(await request(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Upload-Code': uploadCode },
    body: JSON.stringify({ uploadId, name: file.name, mimeType, size: file.size, guestName }),
  }, timeoutMs), uploadId, file.size, true));
  // The capability token exists only for this call. Manual retries reinitialize
  // the same upload ID to recover the durable server session and current offset.
  const token = receipt.token;
  const fileUrl = `${uploadUrl}/${encodeURIComponent(uploadId)}`;
  const probe = () => withRetry(async () => validateReceipt(await request(fileUrl, {
    method: 'GET', headers: { 'X-Upload-Token': token },
  }, timeoutMs), uploadId, file.size));
  progress(receipt);
  let stalledAttempts = 0;
  let sessionResets = 0;

  while (receipt.status !== 'complete') {
    if (receipt.uploadedBytes === file.size) {
      if (stalledAttempts >= maxRetries) throw new RequestError();
      progress(receipt, 'confirming');
      await waitBeforeRetry(stalledAttempts, null);
      stalledAttempts += 1;
      receipt = await probe();
      progress(receipt);
      continue;
    }

    const start = receipt.uploadedBytes;
    const endExclusive = Math.min(start + receipt.chunkBytes, file.size);
    try {
      const acknowledged = validateReceipt(await request(fileUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Upload-Token': token,
          'Content-Range': `bytes ${start}-${endExclusive - 1}/${file.size}`,
        },
        body: file.slice(start, endExclusive),
      }, timeoutMs), uploadId, file.size);
      if (acknowledged.uploadedBytes <= start || acknowledged.uploadedBytes > endExclusive) throw new RequestError();
      receipt = acknowledged;
      stalledAttempts = 0;
      progress(receipt);
    } catch (error) {
      // A failed response does not mean Drive rejected the bytes. Always probe
      // before any resend, including when the final chunk's receipt was lost.
      progress(receipt, endExclusive === file.size ? 'confirming' : 'uploading');
      const recovered = await probe();
      progress(recovered);
      if (recovered.status === 'complete') return { ok: true, uploadId };
      if (!(error instanceof RequestError) || !error.retryable) throw error;
      if (recovered.uploadedBytes < start) {
        sessionResets += 1;
        if (sessionResets > maxRetries) throw error;
      }
      if (recovered.uploadedBytes > start) {
        stalledAttempts = 0;
        if (error.retryAfterMs) await waitBeforeRetry(0, error);
      }
      else {
        if (stalledAttempts >= maxRetries) throw error;
        await waitBeforeRetry(stalledAttempts, error);
        stalledAttempts += 1;
      }
      receipt = recovered;
    }
  }
  return { ok: true, uploadId };
}
