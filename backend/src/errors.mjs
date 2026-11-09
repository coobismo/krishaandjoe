export class ApiError extends Error {
  constructor(status, message, { retryable = false, retryAfter } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.retryable = retryable;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

export class DriveError extends Error {
  constructor(status, message = 'Google Drive request failed.') {
    super(message);
    this.name = 'DriveError';
    this.status = status;
  }
}
