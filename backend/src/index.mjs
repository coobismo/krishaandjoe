import { Firestore } from '@google-cloud/firestore';
import { OAuth2Client } from 'google-auth-library';
import { loadConfig } from './config.mjs';
import { createDriveProvider } from './drive-provider.mjs';
import { createFirestoreRepository } from './firestore-repository.mjs';
import { createUploadService } from './upload-service.mjs';
import { createUploadServer } from './http-server.mjs';
import { createGalleryService } from './gallery-service.mjs';
import { createGalleryRepository } from './gallery-repository.mjs';
import { createDriveGalleryProvider } from './drive-gallery-provider.mjs';

const config = loadConfig();
const firestore = new Firestore({ projectId: config.projectId, databaseId: config.databaseId });
const auth = new OAuth2Client({
  clientId: config.clientId,
  clientSecret: config.clientSecret,
  transporterOptions: { timeout: 25000 },
});
auth.setCredentials({ refresh_token: config.refreshToken });
const service = createUploadService({
  repository: createFirestoreRepository(firestore),
  drive: createDriveProvider({ auth }),
  folderId: config.folderId,
  uploadCode: config.uploadCode,
  tokenSecret: config.tokenSecret,
});
const gallery = createGalleryService({
  repository: createGalleryRepository(firestore),
  drive: createDriveGalleryProvider({ auth }),
  uploadCode: config.uploadCode,
  tokenSecret: config.tokenSecret,
});
const server = createUploadServer({ service, gallery, allowedOrigins: config.allowedOrigins });
server.listen(config.port, '0.0.0.0', () => console.info('Upload service ready.'));

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
});
