import { randomBytes } from 'node:crypto';
import { argumentsFor, checkGcloudSignIn, gcloud, gcloudWithProgress, hiddenPrompts, saveSecret } from './cloud-helpers.mjs';

try {
  const { project } = argumentsFor('node backend/scripts/setup-secrets.mjs --project YOUR_PROJECT_ID');
  console.log(`Setting up upload credentials for ${project}.`);
  if (!process.stdin.isTTY) throw new Error('Run this command in an interactive terminal to enter credentials privately.');
  console.log('Step 1/3: Checking Google Cloud CLI and sign-in…');
  checkGcloudSignIn();
  console.log('Step 2/3: Enabling Secret Manager and Drive APIs. The first run can take a few minutes.');
  await gcloudWithProgress(['services', 'enable', 'secretmanager.googleapis.com', 'drive.googleapis.com', '--project', project, '--quiet'], {
    label: 'Still enabling Google APIs',
  });
  console.log('Step 3/3: Enter your OAuth credentials. Typed values are hidden; press Enter after each value.');
  const prompts = hiddenPrompts();
  try {
    const clientId = await prompts.ask('OAuth web client ID');
    const clientSecret = await prompts.ask('OAuth web client secret');
    const uploadCode = await prompts.ask('Guest password (same as VITE_SITE_PASSWORD)');
    if (!clientId.endsWith('.apps.googleusercontent.com') || !clientSecret || !uploadCode) {
      throw new Error('Enter a valid OAuth client ID, client secret and guest password.');
    }
    console.log('Saving OAuth client ID to Secret Manager…');
    saveSecret(project, 'wedding-drive-client-id', clientId);
    console.log('Saving OAuth client secret…');
    saveSecret(project, 'wedding-drive-client-secret', clientSecret);
    console.log('Saving guest upload password…');
    saveSecret(project, 'wedding-upload-code', uploadCode);
    // Preserve this key across redeployments and setup reruns so active upload
    // capabilities stay valid. Only generate it for the first installation.
    console.log('Checking the upload signing key…');
    const existing = gcloud(['secrets', 'list', '--project', project, '--format=value(name)'], { quiet: true });
    if (!existing.split(/\s+/).some((item) => item === 'wedding-upload-token-secret' || item.endsWith('/wedding-upload-token-secret'))) {
      console.log('Creating the upload signing key…');
      saveSecret(project, 'wedding-upload-token-secret', randomBytes(48).toString('hex'));
    }
    console.log('Credentials stored in Secret Manager. Next, run authorize-drive.mjs.');
  } finally {
    prompts.close();
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
