// Keep the lease longer than one OAuth refresh plus the slowest Drive call.
// The client allows 180 seconds per request, including final verification.
export const DRIVE_REQUEST_TIMEOUT_MS = 25_000;
export const DRIVE_CHUNK_TIMEOUT_MS = 60_000;
export const UPLOAD_LEASE_MS = 120_000;
export const UPLOAD_LEASE_RENEW_BEFORE_MS = DRIVE_REQUEST_TIMEOUT_MS + DRIVE_CHUNK_TIMEOUT_MS + 15_000;
