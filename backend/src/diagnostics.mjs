const UPSTREAMS = new Set(['drive', 'oauth', 'firestore', 'unknown']);
const OPERATIONS = new Set([
  'generate_file_id', 'get_file', 'create_session', 'query_session', 'put_chunk',
  'refresh_token', 'verify_file', 'move_file', 'transaction', 'unknown',
]);
const GOOGLE_REASONS = new Set([
  'invalid_grant', 'invalid_client', 'unauthorized_client', 'access_denied',
  'temporarily_unavailable', 'invalid_request', 'invalid_scope', 'unsupported_grant_type',
  'insufficientFilePermissions', 'insufficientPermissions', 'storageQuotaExceeded',
  'userRateLimitExceeded', 'rateLimitExceeded', 'accessNotConfigured', 'forbidden',
  'notFound', 'dailyLimitExceeded', 'cannotAddFile', 'backendError', 'invalidParameter',
  'authError', 'appNotAuthorizedToFile', 'activeItemCreationLimitExceeded',
  'teamDriveFileLimitExceeded', 'teamDriveMembershipRequired',
  'SERVICE_DISABLED', 'serviceDisabled',
]);
const GRPC_REASONS = new Map([
  [1, 'CANCELLED'], [2, 'UNKNOWN'], [3, 'INVALID_ARGUMENT'], [4, 'DEADLINE_EXCEEDED'],
  [5, 'NOT_FOUND'], [6, 'ALREADY_EXISTS'], [7, 'PERMISSION_DENIED'],
  [8, 'RESOURCE_EXHAUSTED'], [9, 'FAILED_PRECONDITION'], [10, 'ABORTED'],
  [11, 'OUT_OF_RANGE'], [12, 'UNIMPLEMENTED'], [13, 'INTERNAL'],
  [14, 'UNAVAILABLE'], [15, 'DATA_LOSS'], [16, 'UNAUTHENTICATED'],
]);
const REASONS = new Set([
  ...GOOGLE_REASONS, ...GRPC_REASONS.values(),
  'timeout', 'network_error', 'invalid_response', 'invalid_session_url', 'metadata_mismatch', 'unknown',
]);

export function googleErrorReason(body) {
  const error = body?.error;
  if (typeof error === 'string' && GOOGLE_REASONS.has(error)) return error;
  if (Array.isArray(error?.errors)) {
    const known = error.errors.find((entry) => GOOGLE_REASONS.has(entry?.reason));
    if (known) return known.reason;
  }
  if (Array.isArray(error?.details)) {
    const known = error.details.find((entry) => GOOGLE_REASONS.has(entry?.reason));
    if (known) return known.reason;
  }
  return 'unknown';
}

// Never include an exception's message, stack, URL, request, headers, or body.
// Whitelisting every field also makes explicitly supplied diagnostics safe.
export function safeDiagnostic(error) {
  let source = error?.diagnostics;
  if (!source || typeof source !== 'object') {
    const oauthReason = googleErrorReason(error?.response?.data);
    if (oauthReason !== 'unknown' && typeof error?.response?.data?.error === 'string') {
      source = { upstream: 'oauth', operation: 'refresh_token', reason: oauthReason, upstreamStatus: error.response.status };
    } else if (GRPC_REASONS.has(error?.code)) {
      source = { upstream: 'firestore', operation: 'transaction', reason: GRPC_REASONS.get(error.code), upstreamStatus: error.code };
    } else if ([...GRPC_REASONS.values()].includes(error?.code)) {
      source = { upstream: 'firestore', operation: 'transaction', reason: error.code };
    } else source = {};
  }
  const diagnostic = {
    upstream: UPSTREAMS.has(source.upstream) ? source.upstream : 'unknown',
    operation: OPERATIONS.has(source.operation) ? source.operation : 'unknown',
    reason: REASONS.has(source.reason) ? source.reason : 'unknown',
  };
  const status = source.upstreamStatus;
  if (Number.isInteger(status) && ((status >= 100 && status <= 599)
    || (diagnostic.upstream === 'firestore' && status >= 1 && status <= 16))) diagnostic.upstreamStatus = status;
  return diagnostic;
}
