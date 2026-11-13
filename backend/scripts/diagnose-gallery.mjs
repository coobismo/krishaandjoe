import { OAuth2Client } from 'google-auth-library';
import { argumentsFor, gcloud, secretValue } from './cloud-helpers.mjs';
import { createDriveGalleryProvider } from '../src/drive-gallery-provider.mjs';
import { safeDiagnostic } from '../src/diagnostics.mjs';
import { diagnoseGallery, driveFileIdFromInput, GalleryDiagnosticFailure } from './gallery-diagnostic-helpers.mjs';

try {
  const args = argumentsFor('node backend/scripts/diagnose-gallery.mjs --project YOUR_PROJECT_ID [--photo-id UPLOAD_UUID] [--drive-file DRIVE_LINK_OR_ID]');
  const project = args.project;
  const region = args.region || 'asia-southeast1';
  const service = args.service || 'wedding-photo-uploads';
  const requestedFileId = driveFileIdFromInput(args['drive-file']);
  if (!/^[a-z]+-[a-z]+[0-9]+$/.test(region) || !/^[a-z][a-z0-9-]{0,62}$/.test(service)) {
    throw new GalleryDiagnosticFailure('Provide a valid Cloud Run region and service name.');
  }
  console.log('Checking gallery visibility without changing Drive or Firestore. Private values will remain hidden.');
  const deployed = JSON.parse(gcloud(['run', 'services', 'describe', service, '--project', project, '--region', region, '--format=json'], { quiet: true }));
  const traffic = (deployed.status?.traffic || []).filter((entry) => entry.percent > 0);
  if (traffic.length > 1 && !args.revision) throw new GalleryDiagnosticFailure('The service serves multiple revisions. Rerun with --revision for the revision handling the gallery request.');
  const revisionName = args.revision || traffic[0]?.revisionName || deployed.status?.latestReadyRevisionName;
  if (typeof revisionName !== 'string' || !/^[a-z][a-z0-9-]{0,62}$/.test(revisionName)) {
    throw new GalleryDiagnosticFailure('The serving revision could not be identified.');
  }
  const target = traffic.find((entry) => entry.revisionName === revisionName && entry.url);
  if (args.revision && traffic.length && !target && !(traffic.length === 1 && traffic[0].revisionName === revisionName)) {
    throw new GalleryDiagnosticFailure('The requested revision has no distinct serving URL. Select the revision receiving all traffic.');
  }
  const serviceUrl = target?.url || deployed.status?.url;
  const revision = JSON.parse(gcloud(['run', 'revisions', 'describe', revisionName, '--project', project, '--region', region, '--format=json'], { quiet: true }));
  const variables = new Map((revision.spec?.containers?.[0]?.env || []).map((variable) => [variable.name, variable]));
  function deployedSecret(name) {
    const variable = variables.get(name);
    if (typeof variable?.value === 'string' && variable.value) return variable.value;
    const ref = variable?.valueFrom?.secretKeyRef;
    if (!ref || !/^[A-Za-z0-9_-]+$/.test(ref.name) || !/^[0-9]+$/.test(ref.key)) {
      throw new GalleryDiagnosticFailure('The diagnostic requires deployed secrets pinned to numeric versions. Redeploy with the provided deployment helper.');
    }
    return secretValue(project, ref.name, ref.key);
  }
  console.log(`Serving revision: ${revisionName}`);
  const oauth = new OAuth2Client({
    clientId: deployedSecret('GOOGLE_CLIENT_ID'), clientSecret: deployedSecret('GOOGLE_CLIENT_SECRET'),
    transporterOptions: { timeout: 25000, retryConfig: { retry: 0 } },
  });
  oauth.setCredentials({ refresh_token: deployedSecret('GOOGLE_REFRESH_TOKEN') });
  try {
    const result = await oauth.getAccessToken();
    if (!result.token) throw new Error('No owner authorization');
  } catch (error) {
    console.error(JSON.stringify({ ownerAuthorization: safeDiagnostic(error) }));
    throw new GalleryDiagnosticFailure('The deployed owner authorization could not refresh. No private provider details were printed.');
  }
  const report = await diagnoseGallery({
    serviceUrl, uploadCode: deployedSecret('UPLOAD_CODE'),
    cloudToken: gcloud(['auth', 'print-access-token', '--project', project, '--quiet'], { quiet: true }).trim(),
    firestoreProject: variables.get('GOOGLE_CLOUD_PROJECT')?.value || project,
    databaseId: variables.get('FIRESTORE_DATABASE_ID')?.value || '(default)',
    folderId: variables.get('DRIVE_FOLDER_ID')?.value || undefined,
    drive: createDriveGalleryProvider({ auth: oauth }), photoId: args['photo-id'], requestedFileId,
  });
  console.log(JSON.stringify(report, null, 2));
  console.log('Read-only comparison complete. Photo positions follow the recent index order; no private IDs or image contents were printed.');
  if (!report.galleryApi.responseValid || !report.galleryIndex.responseValid) process.exitCode = 1;
} catch (error) {
  if (error instanceof GalleryDiagnosticFailure || error?.message?.startsWith('Google Cloud operation') || error?.message?.startsWith('Google Cloud CLI')) {
    console.error(error.message);
  } else console.error('The gallery diagnostic could not finish. Check gcloud sign-in and permission to read the service, deployed secret versions and gallery index. No credentials were printed.');
  process.exitCode = 1;
}
