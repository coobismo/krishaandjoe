import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const digest = (value) => createHash('sha256').update(value).digest();

export function createUploadAuth({ uploadCode, tokenSecret }) {
  const expectedCode = digest(uploadCode);
  return {
    checkCode(value) {
      return typeof value === 'string' && value.length <= 1024
        && timingSafeEqual(expectedCode, digest(value));
    },
    token(record) {
      return createHmac('sha256', tokenSecret)
        .update(`${record.uploadId}:${record.metadataDigest}:${record.expiresAt.getTime()}`)
        .digest('base64url');
    },
    checkToken(record, value) {
      return typeof value === 'string' && value.length <= 1024
        && timingSafeEqual(digest(this.token(record)), digest(value));
    },
  };
}
