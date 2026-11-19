# Krisha & Joe Wedding Website

A minimalist ivory-and-blue wedding website boilerplate for Krisha and Joe's wedding on November 21, 2026.

## Features

- Responsive React + Vite starter project
- Hero section with countdown
- Our Story section
- Subtle cat section for Cookie, Biscuit and Smores
- Wedding details section
- Memories navigation and hero buttons appear when the wedding countdown ends; RSVP is closed
- FAQ / must-knows section
- Dedicated `/memories` page with guest photo/video uploads to Google Drive
- Guest photo gallery with larger previews on the memories page

## How to run locally

```bash
npm install
npm run dev
```

Then open the local URL shown in your terminal.

## Website access

The homepage and `/memories` open directly. Guests do not enter a password.
The old site-unlock value is removed from browser storage when either page opens.

The uploader and gallery send their API access code automatically. Configure
`VITE_PHOTO_UPLOAD_CODE` to match the backend's existing `UPLOAD_CODE`; this
value is part of the static website bundle, rather than a guest sign-in.
For existing installations, the former `VITE_SITE_PASSWORD` setting remains a
build-time fallback for that API code. The GitHub Pages workflow prefers the
new secret and falls back to the existing secret, so the current uploader keeps
working without a credential migration. Publish the rebuilt website to remove
the password screen.

## Project structure

- `src/data/wedding.js` stores wedding copy, RSVP settings, venue links, palettes, FAQs and image paths.
- `src/sections/` contains one React component per page section.
- `src/components/` contains shared UI pieces such as dropdowns, direction pickers and gratitude lists.
- `src/features/rsvp/` retains the former RSVP integration for reference; the homepage no longer loads it.
- `src/features/photos/` owns file validation, upload receipts, retries and upload queue state.
- `src/pages/MemoriesPage.jsx` contains the dedicated guest memories page.
- `memories/index.html` and `vite.config.js` provide a real static `/memories/` entry for GitHub Pages.
- `src/hooks/` contains reusable React hooks.

## Archived RSVP Google Sheet setup

RSVP is closed. The homepage no longer renders the form or links to it. The
integration below is retained for reference; existing responses are preserved.

The RSVP form posts to a Google Apps Script Web App, then keeps a browser `localStorage` backup.
The included Apps Script targets this spreadsheet:

1. Open the Google Sheet, then go to `Extensions` > `Apps Script`.
2. Paste the contents of `google-apps-script/rsvp-web-app.gs` into the Apps Script editor.
3. Click `Deploy` > `New deployment`.
4. Choose `Web app`.
5. Set `Execute as` to `Me`.
6. Set `Who has access` to `Anyone`.
7. Copy the Web App URL.
8. Create `.env.local` from `.env.example` and set:

```bash
VITE_RSVP_ENDPOINT=https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec
```

Restart `npm run dev` after changing `.env.local`.

For an existing Apps Script deployment, paste the updated script, then choose
`Deploy` > `Manage deployments` > edit > `New version` > `Deploy` to keep the same URL.
The script caches header checks for six hours and limits its lock to sheet writes.
Header edits in the sheet are rechecked when the cache expires.

The browser follows the Apps Script redirect to its response. Cross-origin
`no-cors` requests require `redirect: 'follow'`; using `'manual'` makes the browser
reject the request before sending it. The response is unreadable with `no-cors`,
so this transport cannot verify that the sheet accepted a response. Test the
deployed flow by submitting an RSVP and checking the sheet. Google startup and
network latency can still take a few seconds.

Run `npm test` to check the RSVP POST and redirect flow against local test servers.

## Guest photo uploads to Google Drive

The uploader and guest gallery are available now at
**https://krishaandjoe.ph/memories** (with or without a trailing slash).
No preview mode or special query parameter is needed. Old preview bookmarks
redirect to the clean memories route; an upload bookmark opens the upload dialog.

The gallery is the main view. A compact **Add a memory** button opens the upload
form in a dialog. Closing the dialog keeps selected files and active uploads in
the page, with upload activity shown on the button. Each confirmed file updates
the gallery automatically.

The optional **Your name** field credits the guest sharing each memory. Gallery
cards and the viewer show **Shared by [Name]**; leaving it blank keeps the
caption **Shared with love**. The upload form explains that the name appears
with the photos in the gallery. Existing photos can recover their original
credit from a saved upload record or the uploader-generated Drive description
when that information is still available.

At **November 21, 2026, 2:00 PM in Asia/Manila**, the homepage countdown disappears
and **Memories** appears in both the navigation and the hero, linking to the
dedicated gallery page. The hero keeps **View Details** and shows no replacement
countdown message. Both Memories links remain hidden before that time; direct
visits to `/memories` still work at any time.

The Vite build emits both `dist/index.html` and `dist/memories/index.html`, so
direct visits work on GitHub Pages without a router fallback or another hosting
service. Deploy the complete `dist` directory through the existing workflow.

### Guest gallery

The gallery shows completed photo and video uploads, newest first, with larger
previews, keyboard navigation, pagination and automatic updates. Videos have a
thumbnail and play badge in the grid. Opening one shows its poster and a Play
button; playback uses native controls and streams from the private backend
instead of downloading the entire video into browser memory. Closing the viewer
or moving to another memory stops playback. Photos and videos keep their aspect
ratio within the browser viewport, including short and narrow windows.

The video viewer reuses its loaded gallery thumbnail immediately. If that image
is still loading, it requests the same thumbnail variant so the backend can share
the pending request or cached result. The open video uses native automatic
buffering instead of stopping after its metadata; playback starts after pressing
Play. Its source, element and native controls stay in place while buffering and
resuming. Only the open video is preloaded, and closing it cancels the stream.
The thumbnail stays visible until playback begins, and both layers use the same
bounds to avoid a blank flash or size jump while buffering.
The custom buffering overlay appears only before the first playback, after a
continuous half-second wait with insufficient data. Once playback begins, later
buffering is left to the native player; a delayed screen-reader status still
announces longer waits. Playback, readiness, pause and end events clear the status,
so brief startup or seeking events do not flash an extra loading icon.

The gallery checks for new memories
about every 30 seconds while the page is visible and online, preserving photos
already loaded. Automatic checks pause while a photo is open and resume when
it closes. Each successfully confirmed file triggers an immediate gallery
update, including the first file in a batch.

Deleting a photo in Drive, moving it to Trash, or removing it from the wedding
folder excludes it from new gallery requests. Reload the page to fully
resync the displayed album after managing files in Drive. Restoring the same
file to the wedding folder makes it eligible to appear again.

Gallery requests use the existing guest code. The backend serves private image
previews without changing Drive sharing or exposing owner OAuth credentials.
Newly uploaded HEIC and TIFF photos rely on Drive's preview generation; a retry
is available while a preview is being prepared. Video thumbnails also depend on
Drive processing. Pending video previews retry automatically in both the grid
and the viewer until ready, with delays capped at one minute. Retries pause
while the page is hidden or offline and stop after success, authentication
failure, or file removal. Playback remains available when a thumbnail is not ready.
Video codec support depends on the guest's browser; unsupported videos show a
helpful message. Originals are preserved and are not transcoded.

Deploy the updated backend first, then deploy the website through its existing
GitHub Pages workflow. No additional environment variable or OAuth permission
is needed. See [backend gallery details](backend/README.md#guest-photo-gallery).

The recommended backend for 50–100 simultaneous guests is now the **Cloud Run
resumable uploader**. It supports files up to 500 MB, independent transfers
across guests, confirmed byte progress and retries without restarting the file.
The destination remains the same wedding Drive folder.

In the browser, the progress bar follows bytes sent to the upload backend,
including movement within a chunk. Preparation shows a static empty track and
a status label, without the browser's flashing indeterminate bar;
after sending, the status changes to “Saving to our album…” while the backend
finishes. Displayed progress stays below 100% until the completed file has been
verified. Connection recovery resets provisional progress to the confirmed
offset before retrying. The Node load-test runner continues reporting only
acknowledged bytes. Publish the rebuilt website to activate the progress UI.

Follow the complete [Google Cloud setup guide](backend/README.md): create a
billing-enabled project, authorize the Drive owner using the included helpers,
deploy the backend, and set its URL as `VITE_PHOTO_UPLOAD_ENDPOINT`. The website
uses `VITE_PHOTO_UPLOAD_PROVIDER=cloud-run`. Cloud infrastructure and live Google
authorization must be configured before uploads become available. Capacity
must be verified with a live load test after deployment.

### Legacy Apps Script option

The simpler Apps Script backend remains available by explicitly setting
`VITE_PHOTO_UPLOAD_PROVIDER=apps-script`. Its limits and setup follow below;
these are not the Cloud Run limits.

The **Memories** navigation link opens the dedicated gallery page. **Add a memory**
opens the upload dialog.
Guests can select or drop up to 20 photos and short videos, with a 20 MB limit
per file. Common camera formats, including HEIC/HEIF and MOV, are supported;
the originals are uploaded without compression. Files are sent one at a time
to limit memory use on phones. An optional guest name is saved in the file’s
Drive description.

### Connect the wedding folder

1. Sign in at [Google Apps Script](https://script.google.com/) with an account
   that can create files in [the wedding album folder](https://drive.google.com/drive/folders/1x_-4yfn1Ar9q1xXvcf0rFoVpGKEzTi_k).
2. Create a **new, separate project** and replace its default code with
   [`google-apps-script/photo-upload-web-app.gs`](google-apps-script/photo-upload-web-app.gs).
   Keep the existing RSVP project separate: both scripts define `doPost`.
3. Open **Project Settings → Script properties → Add script property**:

   | Property | Value |
   | --- | --- |
   | `UPLOAD_FOLDER_ID` | `1x_-4yfn1Ar9q1xXvcf0rFoVpGKEzTi_k` |

4. Choose **Deploy → New deployment → Web app**, set **Execute as: Me** and
   **Who has access: Anyone**, then authorize Drive access and deploy.
   Google Workspace policies may restrict the anonymous access option.
5. Copy the deployment URL ending in `/exec` and add it to `.env.local`:

   ```bash
   VITE_PHOTO_UPLOAD_PROVIDER=apps-script
   VITE_PHOTO_UPLOAD_ENDPOINT=https://script.google.com/macros/s/YOUR_UPLOAD_DEPLOYMENT_ID/exec
   ```

   Restart the local dev server after changing this value. The Drive folder
   URL itself is not an upload endpoint.
6. For GitHub Pages, add a repository Actions secret named
   `VITE_PHOTO_UPLOAD_ENDPOINT` with that same URL, then rebuild/redeploy the
   website. The existing workflow passes it into Vite.

The site shows a “Photo sharing is opening soon” message until a valid endpoint
is configured. The folder link alone does not activate uploads. Anyone with the
endpoint can submit supported files, using the script owner’s storage and quota.
There is no need to grant guests editor access to the Drive folder. Files inherit
the folder’s existing sharing settings; the script never makes them public or
returns album listings.

### Verify the deployed connection

Open the website in a signed-out/private browser window, choose a
small photo and upload it. Check both the “Saved to our album” status and the
actual file in the destination Drive folder. Repeat on a phone with a HEIC photo
or short MOV clip if those are expected from guests.

Uploads require a readable JSON receipt from Apps Script before displaying
success. Requests use `text/plain` and follow the Google response redirect;
they deliberately do not use `no-cors`, which would hide whether Drive accepted
the file. A sign-in response, deployment/access error, blocked CORS response or
network failure leaves the file retryable. Correct the deployment settings if
uploads cannot be confirmed; do not replace receipt checks with opaque success.

Retries from the same selection reuse the upload ID, and the script checks for
the existing file before writing a duplicate. Keep the tab open until uploads
finish; refreshing or removing/reselecting a file creates a new upload ID.
“Pause after this file” leaves remaining selections ready to resume in the tab.
Files are not saved in browser storage. Drive filenames have an upload-ID prefix
to support retries.

After changing the script, deploy a **New version** of its existing deployment
to retain the endpoint URL. Google’s [web app deployment guide](https://developers.google.com/apps-script/guides/web)
and [Content Service guide](https://developers.google.com/apps-script/guides/content)
describe the deployment settings and response redirects.

`npm test` covers upload validation, confirmed receipts, failures/timeouts and
backend duplicate handling using mocks, plus the existing RSVP transport tests.
The Drive authorization and browser-to-Google connection require the live check
above after deploying the Apps Script.

## Suggested next edits

- Add final ceremony and reception venue details
- Add real engagement/prenup photos
- Replace placeholder text with your final invitation wording
