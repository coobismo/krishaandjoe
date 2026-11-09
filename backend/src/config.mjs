const required = [
  'GOOGLE_CLOUD_PROJECT', 'DRIVE_FOLDER_ID', 'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'UPLOAD_CODE',
  'UPLOAD_TOKEN_SECRET', 'ALLOWED_ORIGINS',
];

export function loadConfig(env = process.env) {
  for (const key of required) {
    if (typeof env[key] !== 'string' || !env[key].trim()) {
      throw new Error(`Missing required configuration: ${key}`);
    }
  }
  if (env.UPLOAD_TOKEN_SECRET.length < 32) {
    throw new Error('UPLOAD_TOKEN_SECRET must contain at least 32 characters.');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(env.DRIVE_FOLDER_ID)) {
    throw new Error('DRIVE_FOLDER_ID must be a folder ID, rather than a URL.');
  }
  const allowedOrigins = [...new Set(env.ALLOWED_ORIGINS.split(',').map((entry) => entry.trim()).filter(Boolean))];
  if (!allowedOrigins.length) throw new Error('ALLOWED_ORIGINS must contain an exact origin.');
  for (const origin of allowedOrigins) {
    let url;
    try { url = new URL(origin); } catch { throw new Error('ALLOWED_ORIGINS contains an invalid origin.'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.origin !== origin) {
      throw new Error('ALLOWED_ORIGINS must contain exact HTTP(S) origins, without paths or wildcards.');
    }
  }
  const port = Number(env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid port number.');
  return {
    projectId: env.GOOGLE_CLOUD_PROJECT,
    databaseId: env.FIRESTORE_DATABASE_ID || '(default)',
    folderId: env.DRIVE_FOLDER_ID,
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    refreshToken: env.GOOGLE_REFRESH_TOKEN,
    uploadCode: env.UPLOAD_CODE,
    tokenSecret: env.UPLOAD_TOKEN_SECRET,
    allowedOrigins,
    port,
  };
}
