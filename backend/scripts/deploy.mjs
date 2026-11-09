import { fileURLToPath } from 'node:url';
import { argumentsFor, gcloud } from './cloud-helpers.mjs';

try {
  const args = argumentsFor('node backend/scripts/deploy.mjs --project YOUR_PROJECT_ID --origin https://YOUR_WEBSITE_HOST');
  const { project } = args;
  const region = args.region || 'asia-southeast1';
  const folderId = args.folder || '1x_-4yfn1Ar9q1xXvcf0rFoVpGKEzTi_k';
  const origin = new URL(args.origin || '');
  if (origin.protocol !== 'https:' || origin.origin !== args.origin || !/^[a-z]+-[a-z]+[0-9]+$/.test(region)
      || !/^[A-Za-z0-9_-]+$/.test(folderId)) {
    throw new Error('Use an HTTPS website origin without a trailing slash or path, a valid region, and a Drive folder ID.');
  }
  const service = 'wedding-photo-uploads';
  const runtimeEmail = `wedding-upload-runtime@${project}.iam.gserviceaccount.com`;
  const buildEmail = `wedding-upload-build@${project}.iam.gserviceaccount.com`;
  const secretBindings = {
    GOOGLE_CLIENT_ID: 'wedding-drive-client-id',
    GOOGLE_CLIENT_SECRET: 'wedding-drive-client-secret',
    GOOGLE_REFRESH_TOKEN: 'wedding-drive-refresh-token',
    UPLOAD_CODE: 'wedding-upload-code',
    UPLOAD_TOKEN_SECRET: 'wedding-upload-token-secret',
  };

  gcloud(['services', 'enable', 'run.googleapis.com', 'cloudbuild.googleapis.com',
    'artifactregistry.googleapis.com', 'firestore.googleapis.com', 'secretmanager.googleapis.com',
    'drive.googleapis.com', '--project', project, '--quiet']);

  // Validate secret versions without reading their contents.
  for (const name of Object.values(secretBindings)) {
    const version = gcloud(['secrets', 'versions', 'list', name, '--project', project,
      '--filter=state=ENABLED', '--limit=1', '--format=value(name)'], { quiet: true }).trim();
    if (!version) throw new Error(`Missing enabled secret ${name}. Run the credential and authorization helpers first.`);
  }

  const accounts = gcloud(['iam', 'service-accounts', 'list', '--project', project, '--format=value(email)'], { quiet: true }).split(/\s+/);
  for (const [id, email] of [['wedding-upload-runtime', runtimeEmail], ['wedding-upload-build', buildEmail]]) {
    if (!accounts.includes(email)) {
      gcloud(['iam', 'service-accounts', 'create', id, '--project', project, '--quiet']);
    }
  }
  for (const [email, role] of [[runtimeEmail, 'roles/datastore.user'], [buildEmail, 'roles/run.builder']]) {
    gcloud(['projects', 'add-iam-policy-binding', project, `--member=serviceAccount:${email}`, `--role=${role}`, '--quiet']);
  }

  const versions = [];
  for (const [variable, name] of Object.entries(secretBindings)) {
    gcloud(['secrets', 'add-iam-policy-binding', name, '--project', project,
      `--member=serviceAccount:${runtimeEmail}`, '--role=roles/secretmanager.secretAccessor', '--quiet']);
    const version = gcloud(['secrets', 'versions', 'list', name, '--project', project,
      '--filter=state=ENABLED', '--sort-by=~createTime', '--limit=1', '--format=value(name)'], { quiet: true }).trim().split('/').pop();
    versions.push(`${variable}=${name}:${version}`);
  }

  const databases = gcloud(['firestore', 'databases', 'list', '--project', project, '--format=value(name)'], { quiet: true });
  if (!databases.split(/\s+/).some((name) => name.endsWith('/(default)') || name === '(default)')) {
    gcloud(['firestore', 'databases', 'create', '--database=(default)', '--type=firestore-native',
      `--location=${region}`, '--project', project, '--quiet']);
  }
  gcloud(['firestore', 'fields', 'ttls', 'update', 'expiresAt', '--collection-group=weddingPhotoUploads',
    '--database=(default)', '--enable-ttl', '--async', '--project', project, '--quiet']);

  gcloud(['run', 'deploy', service, '--source', fileURLToPath(new URL('..', import.meta.url)),
    '--project', project, '--region', region, '--service-account', runtimeEmail,
    `--build-service-account=projects/${project}/serviceAccounts/${buildEmail}`,
    '--allow-unauthenticated', '--concurrency=20', '--max-instances=5', '--min-instances=0',
    '--memory=512Mi', '--cpu=1', '--timeout=300',
    '--set-env-vars', `^|^GOOGLE_CLOUD_PROJECT=${project}|DRIVE_FOLDER_ID=${folderId}|ALLOWED_ORIGINS=${origin.origin}`,
    '--set-secrets', versions.join(','), '--quiet'], { timeoutMs: 20 * 60_000 });

  const url = gcloud(['run', 'services', 'describe', service, '--project', project, '--region', region,
    '--format=value(status.url)'], { quiet: true }).trim();
  console.log(`Backend deployed: ${url}`);
  console.log('Set VITE_PHOTO_UPLOAD_PROVIDER=cloud-run and VITE_PHOTO_UPLOAD_ENDPOINT to that URL, then rebuild the wedding website.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
