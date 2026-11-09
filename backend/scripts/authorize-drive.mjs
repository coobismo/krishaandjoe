import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { argumentsFor, secretValue, saveSecret } from './cloud-helpers.mjs';

try {
  const { project } = argumentsFor('node backend/scripts/authorize-drive.mjs --project YOUR_PROJECT_ID');
  const redirectUri = 'http://127.0.0.1:8765/oauth2callback';
  const oauth = new OAuth2Client(
    secretValue(project, 'wedding-drive-client-id'),
    secretValue(project, 'wedding-drive-client-secret'),
    redirectUri,
  );
  const state = randomBytes(32).toString('hex');
  const { codeVerifier, codeChallenge } = await oauth.generateCodeVerifierAsync();
  let finish;
  let fail;
  let accepting = true;
  const completed = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Type', 'text/plain;charset=utf-8');
    const url = new URL(request.url, redirectUri);
    if (request.method !== 'GET' || url.pathname !== '/oauth2callback') {
      response.writeHead(404).end('Not found.');
      return;
    }
    if (!accepting || url.searchParams.get('state') !== state) {
      response.writeHead(400).end('This authorization request is invalid.');
      return;
    }
    accepting = false;
    if (!url.searchParams.get('code') || url.searchParams.has('error')) {
      response.writeHead(400).end('Authorization was not completed. You can close this tab and try again.');
      fail(new Error('Google authorization was not completed.'));
      return;
    }
    try {
      const { tokens } = await oauth.getToken({ code: url.searchParams.get('code'), codeVerifier });
      if (!tokens.refresh_token) throw new Error('No offline authorization was returned.');
      saveSecret(project, 'wedding-drive-refresh-token', tokens.refresh_token);
      response.end('Google Drive is connected. You can close this tab and return to your terminal.');
      finish();
    } catch {
      response.writeHead(500).end('Could not finish authorization. Return to your terminal and try again.');
      fail(new Error('Could not store Google Drive authorization. Check the OAuth client, redirect URI and Secret Manager permissions.'));
    }
  });
  const timeout = setTimeout(() => fail(new Error('Authorization timed out. Run the helper again.')), 10 * 60_000);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(8765, '127.0.0.1', resolve);
    });
    const url = oauth.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: ['https://www.googleapis.com/auth/drive'],
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    console.log('Open this URL in a browser on this computer and sign in as the Drive folder owner:');
    console.log(url);
    await completed;
    console.log('Drive authorization saved directly to Secret Manager. Ready to deploy.');
  } finally {
    clearTimeout(timeout);
    server.close();
    server.closeAllConnections();
  }
} catch {
  console.error('Drive authorization did not complete. Check gcloud sign-in, OAuth client settings, Secret Manager permissions and that port 8765 is available. No tokens were printed.');
  process.exitCode = 1;
}
