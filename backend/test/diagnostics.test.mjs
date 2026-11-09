import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { safeDiagnostic } from '../src/diagnostics.mjs';
import { ApiError, DriveError } from '../src/errors.mjs';
import { createDriveProvider } from '../src/drive-provider.mjs';
import { createUploadServer } from '../src/http-server.mjs';

const secret = 'PRIVATE_TOKEN_FOLDER_AND_SESSION_URL_MUST_NEVER_APPEAR';
const json = (body, status) => new Response(JSON.stringify(body), { status });

test('diagnostics whitelist every field and discard unknown reasons and arbitrary context', () => {
  const error = new ApiError(503, 'Please try again.', { diagnostics: {
    upstream: 'drive', operation: 'create_session', reason: 'insufficientFilePermissions',
    upstreamStatus: 403, folderId: secret, message: secret, token: secret,
  } });
  assert.deepEqual(safeDiagnostic(error), {
    upstream: 'drive', operation: 'create_session', reason: 'insufficientFilePermissions', upstreamStatus: 403,
  });
  const untrusted = safeDiagnostic({ diagnostics: {
    upstream: secret, operation: secret, reason: secret, upstreamStatus: secret,
  }, message: secret, stack: secret });
  assert.deepEqual(untrusted, { upstream: 'unknown', operation: 'unknown', reason: 'unknown' });
  assert.doesNotMatch(JSON.stringify([error, untrusted]), new RegExp(secret));
});

test('Drive failures retain safe operation/reason and distinguish quota mapping from original HTTP status', async () => {
  for (const [reason, expectedStatus] of [['insufficientFilePermissions', 403], ['userRateLimitExceeded', 429]]) {
    const drive = createDriveProvider({
      auth: { getAccessToken: async () => ({ token: secret }) },
      fetchImpl: async () => json({ error: {
        message: secret, errors: [{ reason, message: secret, location: secret }],
      } }, 403),
    });
    await assert.rejects(drive.createSession({ fileId: 'file-1', folderId: 'folder-1' }), (error) => {
      assert.equal(error.status, expectedStatus);
      assert.deepEqual(safeDiagnostic(error), {
        upstream: 'drive', operation: 'create_session', reason, upstreamStatus: 403,
      });
      assert.ok(!JSON.stringify(error).includes(secret));
      assert.ok(!error.message.includes(secret));
      return true;
    });
  }
});

test('OAuth refresh failures identify invalid_grant without preserving provider descriptions or credentials', async () => {
  const authError = Object.assign(new Error(secret), {
    response: { status: 400, data: { error: 'invalid_grant', error_description: secret }, headers: { authorization: secret } },
    config: { url: secret, data: secret },
  });
  const drive = createDriveProvider({ auth: { getAccessToken: async () => { throw authError; } } });
  await assert.rejects(drive.generateFileId(), (error) => {
    assert.equal(error.status, 503);
    assert.deepEqual(safeDiagnostic(error), {
      upstream: 'oauth', operation: 'refresh_token', reason: 'invalid_grant', upstreamStatus: 400,
    });
    assert.ok(!JSON.stringify(error).includes(secret));
    assert.equal(error.message, 'Google Drive request failed.');
    return true;
  });
});

test('unknown provider errors remain unknown while Firestore gRPC failures use known enums only', async () => {
  const drive = createDriveProvider({
    auth: { getAccessToken: async () => ({ token: secret }) },
    fetchImpl: async () => json({ error: { errors: [{ reason: secret }], message: secret } }, 500),
  });
  await assert.rejects(drive.generateFileId(), (error) => {
    assert.deepEqual(safeDiagnostic(error), {
      upstream: 'drive', operation: 'generate_file_id', reason: 'unknown', upstreamStatus: 500,
    });
    return true;
  });
  assert.deepEqual(safeDiagnostic({ code: 7, details: secret, message: secret }), {
    upstream: 'firestore', operation: 'transaction', reason: 'PERMISSION_DENIED', upstreamStatus: 7,
  });
  assert.deepEqual(safeDiagnostic(new Error(secret)), {
    upstream: 'unknown', operation: 'unknown', reason: 'unknown',
  });
});

test('Google ErrorInfo API-disabled reason is retained while arbitrary details stay private', async () => {
  const drive = createDriveProvider({
    auth: { getAccessToken: async () => ({ token: secret }) },
    fetchImpl: async () => json({ error: {
      message: secret,
      details: [{ reason: secret, metadata: { consumer: secret } }, {
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED',
        metadata: { activationUrl: secret, consumer: secret, service: secret },
      }],
    } }, 403),
  });
  await assert.rejects(drive.generateFileId(), (error) => {
    assert.deepEqual(safeDiagnostic(error), {
      upstream: 'drive', operation: 'generate_file_id', reason: 'SERVICE_DISABLED', upstreamStatus: 403,
    });
    assert.ok(!JSON.stringify(error).includes(secret));
    return true;
  });
});

test('HTTP logs private diagnostics as JSON while keeping the public failure schema unchanged', async (t) => {
  const cause = new DriveError(403, { operation: 'create_session', reason: 'storageQuotaExceeded' });
  const logs = [];
  const server = createUploadServer({
    service: { async status() {
      throw new ApiError(503, 'We could not confirm this upload. Please try again.', {
        retryable: true, retryAfter: 2,
        diagnostics: { ...safeDiagnostic(cause), uploadId: secret, sessionUrl: secret },
      });
    } },
    allowedOrigins: [], logger: { error: (entry) => logs.push(entry) },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/uploads/example`);
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.deepEqual(body, {
    ok: false, error: 'We could not confirm this upload. Please try again.', generic: true, retryable: true,
  });
  assert.equal(typeof logs[0], 'string');
  assert.deepEqual(JSON.parse(logs[0]), {
    event: 'upload_request_failed', status: 503,
    diagnostics: { upstream: 'drive', operation: 'create_session', reason: 'storageQuotaExceeded', upstreamStatus: 403 },
  });
  assert.ok(!JSON.stringify([body, logs]).includes(secret));
  assert.ok(!Object.hasOwn(body, 'diagnostics'));
});
