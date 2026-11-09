import { safeDiagnostic } from './diagnostics.mjs';

export class ApiError extends Error {
  constructor(status, message, { retryable = false, retryAfter, diagnostics } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.retryable = retryable;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
    if (diagnostics !== undefined) this.diagnostics = safeDiagnostic({ diagnostics });
  }
}

export class DriveError extends Error {
  constructor(status, diagnostics = {}) {
    super('Google Drive request failed.');
    this.name = 'DriveError';
    this.status = status;
    this.diagnostics = safeDiagnostic({ diagnostics: { upstream: 'drive', upstreamStatus: status, ...diagnostics } });
  }
}
