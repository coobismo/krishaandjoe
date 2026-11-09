import { OAuth2Client } from 'google-auth-library';
import { argumentsFor, gcloud, secretValue } from './cloud-helpers.mjs';
import { googleErrorReason, safeDiagnostic } from '../src/diagnostics.mjs';
import { createDriveProvider } from '../src/drive-provider.mjs';
import { ALLOWED_MIME_TYPES } from '../src/upload-service.mjs';

class DiagnosticFailure extends Error {}

function hintFor(diagnostic) {
  const { reason, upstreamStatus } = diagnostic;
  if (['invalid_grant', 'invalid_token'].includes(reason)) return 'Drive authorization has expired or been revoked. Run authorize-drive.mjs, then redeploy to use the new refresh-token version.';
  if (['invalid_client', 'unauthorized_client'].includes(reason)) return 'Check that the OAuth client ID, client secret and refresh token belong to the same OAuth client.';
  if (['accessNotConfigured', 'SERVICE_DISABLED', 'serviceDisabled'].includes(reason)) return 'Enable the Google Drive API in the OAuth client project.';
  if (reason === 'storageQuotaExceeded') return 'The authorized Google account has no available Drive storage.';
  if (upstreamStatus === 404) return 'The destination folder is not visible to the authorized Google account. Check DRIVE_FOLDER_ID and folder access.';
  if (upstreamStatus === 401) return 'The deployed owner authorization is not valid. Reauthorize the same OAuth client and redeploy.';
  if (upstreamStatus === 403) return 'Check the authorized account’s folder permissions, Drive API access and organization restrictions.';
  return 'Check the safe operation/reason above; no raw provider error or credential has been printed.';
}

function checkFailed(stage, error) {
  const diagnostic = safeDiagnostic(error);
  console.error(`FAIL: ${stage}`);
  console.error(JSON.stringify(diagnostic));
  console.error(hintFor(diagnostic));
  throw new DiagnosticFailure('Diagnostic stopped at the failed check.');
}

try {
  const args = argumentsFor('node backend/scripts/diagnose-drive.mjs --project YOUR_PROJECT_ID');
  const { project } = args;
  const requestedUploadId = args['upload-id'];
  if (requestedUploadId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedUploadId)) {
    throw new DiagnosticFailure('Provide the upload UUID from the failed /v1/uploads/ request.');
  }
  const region = args.region || 'asia-southeast1';
  const service = args.service || 'wedding-photo-uploads';
  console.log(`Checking the deployed uploader in ${project}/${region}. No files will be uploaded.`);

  const deployed = JSON.parse(gcloud(['run', 'services', 'describe', service, '--project', project,
    '--region', region, '--format=json'], { quiet: true }));
  const traffic = (deployed.status?.traffic || []).filter((target) => target.percent > 0);
  if (traffic.length > 1 && !args.revision) {
    throw new DiagnosticFailure('This service serves multiple revisions. Rerun with --revision REVISION_NAME for the revision handling the failed upload.');
  }
  const revisionName = args.revision || traffic[0]?.revisionName || deployed.status?.latestReadyRevisionName;
  if (typeof revisionName !== 'string' || !/^[a-z][a-z0-9-]+$/.test(revisionName)) {
    throw new DiagnosticFailure('FAIL: The service has no identifiable serving revision.');
  }
  const revision = JSON.parse(gcloud(['run', 'revisions', 'describe', revisionName, '--project', project,
    '--region', region, '--format=json'], { quiet: true }));
  const variables = new Map((revision.spec?.containers?.[0]?.env || []).map((variable) => [variable.name, variable]));
  const folderId = variables.get('DRIVE_FOLDER_ID')?.value;
  if (typeof folderId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(folderId)) {
    throw new DiagnosticFailure('FAIL: The deployed service has no valid DRIVE_FOLDER_ID.');
  }
  console.log(`Deployed revision: ${revisionName}`);
  console.log('OK: Destination folder ID is configured.');

  function deployedSecret(variableName) {
    const variable = variables.get(variableName);
    if (variable?.value) return variable.value;
    const ref = variable?.valueFrom?.secretKeyRef;
    if (!ref || !/^[A-Za-z0-9_-]+$/.test(ref.name) || !/^(latest|[0-9]+)$/.test(ref.key)) {
      throw new DiagnosticFailure(`FAIL: ${variableName} has no supported deployed Secret Manager reference.`);
    }
    console.log(`Reading ${variableName} from its deployed secret version ${ref.key} (value hidden).`);
    if (ref.key === 'latest') {
      console.log('NOTE: This reference uses latest; running instances may retain the version resolved when they started.');
    }
    return secretValue(project, ref.name, ref.key);
  }

  const oauth = new OAuth2Client({
    clientId: deployedSecret('GOOGLE_CLIENT_ID'),
    clientSecret: deployedSecret('GOOGLE_CLIENT_SECRET'),
    transporterOptions: { timeout: 25000, retryConfig: { retry: 0 } },
  });
  oauth.setCredentials({ refresh_token: deployedSecret('GOOGLE_REFRESH_TOKEN') });
  let accessToken;
  try {
    accessToken = (await oauth.getAccessToken()).token;
    if (!accessToken) throw new Error('Missing token');
  } catch (error) { checkFailed('Refresh the deployed Drive owner authorization', error); }
  console.log('OK: Deployed Drive owner authorization can refresh.');

  const fields = 'id,mimeType,capabilities(canAddChildren)';
  let folder;
  try {
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?${new URLSearchParams({ fields, supportsAllDrives: 'true' })}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      redirect: 'error',
      signal: AbortSignal.timeout(25000),
    });
    const body = await response.json();
    if (!response.ok) {
      // Only allowlisted diagnostic fields reach output, never Google's body.
      checkFailed('Read destination folder', {
        diagnostics: {
          upstream: 'drive', operation: 'get_file', upstreamStatus: response.status,
          reason: googleErrorReason(body),
        },
      });
    }
    folder = body;
  } catch (error) {
    if (error instanceof DiagnosticFailure) throw error;
    checkFailed('Read destination folder', error);
  }
  if (folder.mimeType !== 'application/vnd.google-apps.folder') {
    throw new DiagnosticFailure('FAIL: DRIVE_FOLDER_ID identifies a file, rather than a folder.');
  }
  if (folder.capabilities?.canAddChildren !== true) {
    throw new DiagnosticFailure('FAIL: The authorized Google account cannot add files to this folder. Authorize the folder owner or an account with Editor access, then redeploy.');
  }
  console.log('OK: The authorized account can add files to the destination folder.');

  const drive = createDriveProvider({ auth: oauth });
  try {
    await drive.generateFileId();
  } catch (error) { checkFailed('Generate a Drive upload ID', error); }
  console.log('OK: Google Drive accepts file-ID requests. No file was created.');
  if (requestedUploadId) {
    console.log('Inspecting the failed upload record; filenames, file IDs and session URLs remain hidden.');
    const cloudToken = gcloud(['auth', 'print-access-token', '--project', project, '--quiet'], { quiet: true }).trim();
    const database = variables.get('FIRESTORE_DATABASE_ID')?.value || '(default)';
    const firestoreProject = variables.get('GOOGLE_CLOUD_PROJECT')?.value || project;
    const documentUrl = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(firestoreProject)}/databases/${encodeURIComponent(database)}/documents/weddingPhotoUploads/${requestedUploadId.toLowerCase()}`;
    const storedResponse = await fetch(documentUrl, {
      headers: { Authorization: `Bearer ${cloudToken}` }, redirect: 'error', signal: AbortSignal.timeout(25000),
    });
    if (!storedResponse.ok) {
      throw new DiagnosticFailure(`Could not read the stored upload (HTTP ${storedResponse.status}). Check the upload ID, database and your gcloud account's Firestore read permission.`);
    }
    const { fields = {} } = await storedResponse.json();
    const fileId = fields.fileId?.stringValue;
    const expectedSize = Number(fields.size?.integerValue);
    const expectedMimeType = fields.mimeType?.stringValue;
    const expectedUploadId = fields.uploadId?.stringValue;
    const targetFolderId = fields.targetFolderId?.stringValue || folder.id || folderId;
    const sessionUrl = fields.sessionUrl?.stringValue;
    if (!fileId || !Number.isSafeInteger(expectedSize) || expectedSize <= 0) {
      throw new DiagnosticFailure('The stored upload has no valid Drive file checkpoint yet.');
    }
    let storedFile;
    try { storedFile = await drive.getFile(fileId); }
    catch (error) { checkFailed('Read the failed transfer’s Drive metadata', error); }
    if (!storedFile) {
      console.log('The Drive file is not yet visible; final metadata cannot be compared.');
    } else {
      const reportedSize = Number(storedFile.size);
      const safeMime = (value) => ALLOWED_MIME_TYPES.has(value) || value === 'application/octet-stream' ? value : 'other';
      const checks = {
        idMatches: storedFile.id === fileId,
        sizeMatches: String(storedFile.size) === String(expectedSize),
        mimeMatches: storedFile.mimeType === expectedMimeType,
        parentMatches: storedFile.parents?.includes(targetFolderId) === true,
        uploadIdMatches: storedFile.appProperties?.uploadId === expectedUploadId,
        notTrashed: storedFile.trashed !== true,
      };
      console.log(JSON.stringify({
        metadataChecks: checks,
        expectedBytes: expectedSize,
        reportedBytes: Number.isSafeInteger(reportedSize) && reportedSize >= 0 ? reportedSize : null,
        expectedMimeType: safeMime(expectedMimeType),
        reportedMimeType: safeMime(storedFile.mimeType),
        configuredFolderMatchesCanonical: folderId === folder.id,
        configuredParentMatches: storedFile.parents?.includes(folderId) === true,
        parentMetadataPresent: Array.isArray(storedFile.parents),
      }, null, 2));
    }
    if (sessionUrl) {
      try {
        const progress = await drive.querySession(sessionUrl, expectedSize);
        console.log(JSON.stringify({ driveSessionStatus: progress.status, confirmedBytes: progress.uploadedBytes }));
      } catch (error) { checkFailed('Read the failed transfer’s Google upload status', error); }
    }
    console.log('Transfer inspection finished. Only comparison flags, byte counts and supported MIME labels were printed.');
  } else {
    console.log('Read-only Drive checks passed. If uploading still fails, redeploy the updated backend, retry once, and inspect the safe upload_request_failed log for its operation and reason.');
  }
} catch (error) {
  if (error instanceof DiagnosticFailure || error?.message?.startsWith('Google Cloud operation') || error?.message?.startsWith('Google Cloud CLI')) {
    console.error(error.message);
  } else {
    // Unexpected exceptions may include OAuth HTTP request details.
    console.error('Could not complete the diagnostic. Check gcloud sign-in, project/service selection and permission to read the deployed secret versions. No credentials were printed.');
  }
  process.exitCode = 1;
}
