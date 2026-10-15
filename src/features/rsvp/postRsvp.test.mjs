import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { postRsvp } from './postRsvp.mjs';

async function serve(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('posts JSON as plain text and follows the response redirect without reposting', { timeout: 5000 }, async (t) => {
  const controller = new AbortController();
  const nativeFetch = globalThis.fetch;
  t.after(() => controller.abort());
  t.mock.method(globalThis, 'fetch', (endpoint, options) => {
    // Browsers reject cross-origin no-cors requests unless redirects are followed.
    assert.equal(options.mode, 'no-cors');
    assert.equal(options.redirect ?? 'follow', 'follow');
    return nativeFetch(endpoint, { ...options, signal: controller.signal });
  });

  const requests = [];
  let confirmRedirect;
  const redirected = new Promise((resolve) => { confirmRedirect = resolve; });
  const responseOrigin = await serve(t, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ method: request.method, path: request.url, body: Buffer.concat(chunks).toString() });
    response.end('accepted');
    confirmRedirect();
  });
  const submitOrigin = await serve(t, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      method: request.method,
      path: request.url,
      contentType: request.headers['content-type'],
      body: Buffer.concat(chunks).toString(),
    });
    response.writeHead(302, { Location: `${responseOrigin}/receipt` });
    response.end();
  });
  const entry = { name: 'Test Guest', attendance: 'yes', guests: '1' };
  const completed = postRsvp(`${submitOrigin}/submit`, entry);

  try {
    // Node cannot model browser opaque responses and may leave this fetch pending.
    // Verify the real redirected request arrived, then cancel the pending response.
    await Promise.race([redirected, completed.then(() => redirected)]);
    assert.deepEqual(requests, [
      { method: 'POST', path: '/submit', contentType: 'text/plain;charset=utf-8', body: JSON.stringify(entry) },
      { method: 'GET', path: '/receipt', body: '' },
    ]);
  } finally {
    controller.abort();
    await completed.catch(() => {});
  }
});

test('propagates network failure so the form can show its retry message', { timeout: 5000 }, async (t) => {
  const origin = await serve(t, (request) => request.socket.destroy());

  await assert.rejects(postRsvp(origin, { name: 'Test Guest' }), { name: 'TypeError' });
});
