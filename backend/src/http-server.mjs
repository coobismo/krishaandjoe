import { createServer } from 'node:http';
import { ApiError } from './errors.mjs';
import { safeDiagnostic } from './diagnostics.mjs';

const MAX_JSON_BYTES = 32 * 1024;
const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
const CORS_METHODS = 'GET, POST, PUT, OPTIONS';
const CORS_HEADERS = 'Content-Type, Content-Range, X-Upload-Code, X-Upload-Token';
const ALLOWED_HEADERS = new Set(CORS_HEADERS.toLowerCase().split(', '));
const GALLERY_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);

function apiError(status, message, retryable = false) {
  return new ApiError(status, message, { retryable });
}

function sendJson(response, status, value) {
  if (response.writableEnded || response.destroyed) return;
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

function contentType(request) {
  return (request.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
}

function parseRange(value) {
  const match = typeof value === 'string' && /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value);
  if (!match) throw apiError(400, 'A valid Content-Range header is required.');
  const [start, end, total] = match.slice(1).map(Number);
  if (![start, end, total].every(Number.isSafeInteger)
      || total <= 0 || start < 0 || end < start || end >= total
      || end - start + 1 > MAX_CHUNK_BYTES) {
    throw apiError(400, 'The upload byte range is invalid.');
  }
  return { start, end, total };
}

function readBody(request, limit) {
  const declaredLength = request.headers['content-length'];
  if (declaredLength !== undefined) {
    const count = Number(declaredLength);
    if (!Number.isSafeInteger(count) || count < 0) {
      request.resume();
      return Promise.reject(apiError(400, 'The request length is invalid.'));
    }
    if (count > limit) {
      request.resume();
      return Promise.reject(apiError(413, 'This upload request is too large.'));
    }
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    let settled = false;

    function cleanup() {
      request.removeListener('data', onData);
      request.removeListener('end', onEnd);
      request.removeListener('aborted', onAborted);
      request.removeListener('error', onError);
      request.setTimeout(0);
    }

    function fail(error) {
      if (settled) return;
      settled = true;
      cleanup();
      // Discard the remaining bytes without holding them in memory so the
      // browser can receive the JSON error on this connection.
      request.resume();
      reject(error);
    }

    function onData(chunk) {
      received += chunk.length;
      if (received > limit) {
        fail(apiError(413, 'This upload request is too large.'));
        return;
      }
      chunks.push(chunk);
    }

    function onEnd() {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, received));
    }

    function onAborted() { fail(apiError(400, 'The upload request was interrupted.', true)); }
    function onError() { fail(apiError(400, 'The upload request could not be read.', true)); }

    request.on('data', onData);
    request.once('end', onEnd);
    request.once('aborted', onAborted);
    request.once('error', onError);
    request.setTimeout(45_000, () => fail(apiError(408, 'The upload request timed out.', true)));
  });
}

function applyCors(request, response, allowedOrigins) {
  response.setHeader('Vary', 'Origin');
  const origin = request.headers.origin;
  if (origin !== undefined) {
    if (typeof origin !== 'string' || !allowedOrigins.has(origin)) {
      throw apiError(403, 'This website is not allowed to use this uploader.');
    }
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Access-Control-Expose-Headers', 'Retry-After');
  }
}

function preflight(request, response) {
  const method = request.headers['access-control-request-method'];
  if (method && !['GET', 'POST', 'PUT', 'OPTIONS'].includes(method)) {
    throw apiError(405, 'This upload method is not supported.');
  }
  const requestedHeaders = request.headers['access-control-request-headers'];
  if (requestedHeaders && requestedHeaders.split(',').some((header) => !ALLOWED_HEADERS.has(header.trim().toLowerCase()))) {
    throw apiError(400, 'This request uses unsupported headers.');
  }
  response.writeHead(204, {
    'Access-Control-Allow-Methods': CORS_METHODS,
    'Access-Control-Allow-Headers': CORS_HEADERS,
    'Access-Control-Max-Age': '600',
    'Content-Length': '0',
  });
  response.end();
}

export function createUploadServer({ service, gallery, allowedOrigins, logger = console }) {
  const origins = new Set(allowedOrigins);
  const server = createServer(async (request, response) => {
    // An aborted stream can emit its error after readBody has already rejected.
    request.on('error', () => {});
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');

    try {
      applyCors(request, response, origins);
      const url = new URL(request.url, 'http://uploader.invalid');
      const uploadMatch = /^\/v1\/uploads\/([^/]+)$/.exec(url.pathname);
      const collectionPath = url.pathname === '/v1/uploads';
      const galleryPath = Boolean(gallery) && url.pathname === '/v1/gallery';
      const galleryImageMatch = gallery && /^\/v1\/gallery\/([^/]+)\/image$/.exec(url.pathname);
      // /health is suitable for the public Cloud Run URL. Keep the original
      // /healthz alias for local checks and expose readiness at the base URL.
      const healthPath = ['/', '/health', '/healthz'].includes(url.pathname);
      if (!collectionPath && !uploadMatch && !healthPath && !galleryPath && !galleryImageMatch) {
        throw apiError(404, 'This upload endpoint was not found.');
      }

      if (request.method === 'OPTIONS') {
        preflight(request, response);
        return;
      }

      if (healthPath && request.method === 'GET') {
        sendJson(response, 200, { ok: true });
        return;
      }

      if (galleryPath && request.method === 'GET') {
        if ([...url.searchParams.keys()].some((key) => key !== 'cursor') || url.searchParams.getAll('cursor').length > 1) {
          throw apiError(400, 'The album page request is invalid.');
        }
        const result = await gallery.list({ cursor: url.searchParams.get('cursor') ?? undefined }, request.headers['x-upload-code']);
        sendJson(response, 200, result);
        return;
      }

      if (galleryImageMatch && request.method === 'GET') {
        if ([...url.searchParams.keys()].some((key) => key !== 'variant') || url.searchParams.getAll('variant').length > 1) {
          throw apiError(400, 'The photo preview request is invalid.');
        }
        const photo = await gallery.image(galleryImageMatch[1], { variant: url.searchParams.get('variant') ?? 'thumbnail' }, request.headers['x-upload-code']);
        if (!photo || !Buffer.isBuffer(photo.bytes) || !photo.bytes.length || photo.bytes.length > 8 * 1024 * 1024
            || !GALLERY_IMAGE_TYPES.has(photo.contentType)) {
          throw apiError(503, 'This photo preview is temporarily unavailable.', true);
        }
        if (response.destroyed || response.writableEnded) return;
        response.writeHead(200, {
          'Content-Type': photo.contentType,
          'Content-Length': photo.bytes.length,
          'Content-Disposition': 'inline',
          'Cache-Control': 'private, max-age=300',
          'Vary': 'Origin, X-Upload-Code',
        });
        response.end(photo.bytes);
        return;
      }

      if (collectionPath && request.method === 'POST') {
        if (contentType(request) !== 'application/json') {
          throw apiError(415, 'Use application/json to begin an upload.');
        }
        const body = await readBody(request, MAX_JSON_BYTES);
        let payload;
        try { payload = JSON.parse(body.toString('utf8')); }
        catch { throw apiError(400, 'The upload request is not valid JSON.'); }
        const result = await service.initialize(payload, request.headers['x-upload-code']);
        sendJson(response, 200, result);
        return;
      }

      if (uploadMatch && request.method === 'GET') {
        const result = await service.status(uploadMatch[1], request.headers['x-upload-token']);
        sendJson(response, 200, result);
        return;
      }

      if (uploadMatch && request.method === 'PUT') {
        if (contentType(request) !== 'application/octet-stream') {
          throw apiError(415, 'Use application/octet-stream to send file bytes.');
        }
        const range = parseRange(request.headers['content-range']);
        const bytes = await readBody(request, MAX_CHUNK_BYTES);
        if (bytes.length !== range.end - range.start + 1) {
          throw apiError(400, 'The file bytes do not match the Content-Range header.');
        }
        const result = await service.putChunk(uploadMatch[1], request.headers['x-upload-token'], range, bytes);
        sendJson(response, 200, result);
        return;
      }

      response.setHeader('Allow', healthPath || galleryPath || galleryImageMatch ? 'GET, OPTIONS' : collectionPath ? 'POST, OPTIONS' : 'GET, PUT, OPTIONS');
      throw apiError(405, 'This upload method is not supported.');
    } catch (error) {
      const status = error instanceof ApiError && Number.isInteger(error.status)
        ? error.status : 500;
      const retryable = error instanceof ApiError ? Boolean(error.retryable) : true;
      const message = error instanceof ApiError ? error.message : 'The upload service is temporarily unavailable. Please try again.';
      if (status === 429 || status === 503) {
        response.setHeader('Retry-After', String(Math.max(1, Number(error.retryAfter) || 2)));
      }
      if (status >= 500) {
        const diagnostic = safeDiagnostic(error);
        const hasDiagnostic = error?.diagnostics !== undefined || diagnostic.upstream !== 'unknown';
        logger.error?.(JSON.stringify({
          event: 'upload_request_failed', status,
          ...(hasDiagnostic ? { diagnostics: diagnostic } : {}),
        }));
      }
      sendJson(response, status, { ok: false, error: message, generic: status >= 500, retryable });
    }
  });

  server.requestTimeout = 120_000;
  server.headersTimeout = 20_000;
  server.keepAliveTimeout = 5_000;
  server.on('clientError', (_error, socket) => {
    if (!socket.writable) return;
    const body = JSON.stringify({ ok: false, error: 'The HTTP request is invalid.', generic: false, retryable: false });
    socket.end('HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body);
  });
  return server;
}
