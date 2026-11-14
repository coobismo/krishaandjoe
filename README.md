# Krisha & Joe Wedding Website

A minimalist ivory-and-blue wedding website boilerplate for Krisha and Joe's wedding on November 21, 2026.

## Features

- Responsive React + Vite starter project
- Hero section with countdown
- Our Story section
- Subtle cat section for Cookie, Biscuit and Smores
- Wedding details section
- RSVP form wired for Google Sheets via Google Apps Script
- FAQ / must-knows section
- Dedicated `/memories` page with guest photo/video uploads to Google Drive
- Guest photo gallery with larger previews on the memories page

## How to run locally

```bash
npm install
npm run dev
```

Then open the local URL shown in your terminal.

## Password gate

The site asks guests for a password before showing any wedding details. Set `VITE_SITE_PASSWORD` anywhere you set `VITE_RSVP_ENDPOINT`.

For local development, add it to `.env.local`:

```bash
VITE_SITE_PASSWORD=your-password-here
```

For GitHub Pages, add a repository or environment secret named `VITE_SITE_PASSWORD`. The deploy workflow passes it into the build the same way it passes `VITE_RSVP_ENDPOINT`.

If `VITE_SITE_PASSWORD` is not set, the gate stays locked. This is a client-side guest gate for casual privacy on a static site. Use hosting-level authentication if you need stronger protection.

## Project structure

- `src/data/wedding.js` stores wedding copy, RSVP settings, venue links, palettes, FAQs and image paths.
- `src/sections/` contains one React component per page section.
- `src/components/` contains shared UI pieces such as dropdowns, direction pickers and gratitude lists.
- `src/features/rsvp/useRsvpForm.js` owns RSVP form state, submission and local backup behavior.
- `src/features/photos/` owns file validation, upload receipts, retries and upload queue state.
- `src/pages/MemoriesPage.jsx` contains the dedicated guest memories page.
- `memories/index.html` and `vite.config.js` provide a real static `/memories/` entry for GitHub Pages.
- `src/hooks/` contains reusable React hooks.

## RSVP Google Sheet setup

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
**https://krishaandjoe.ph/memories** (with or without a trailing slash), behind
the usual guest password. An existing guest unlock carries between pages.
No preview mode or special query parameter is needed. Old preview bookmarks
redirect to the clean memories route; an upload bookmark opens the upload dialog.

The gallery is the main view. A compact **Add a memory** button opens the upload
form in a dialog. Closing the dialog keeps selected files and active uploads in
the page, with upload activity shown on the button. Each confirmed file updates
the gallery automatically.

The optional **Your name** field credits the guest sharing each photo. Gallery
cards and the photo viewer show **Shared by [Name]**; leaving it blank keeps the
caption **Shared with love**. The upload form explains that the name appears
with the photos in the gallery. Existing photos can recover their original
credit from a saved upload record or the uploader-generated Drive description
when that information is still available.

The homepage no longer mounts either feature. Its single **Memories** navigation
link stays hidden until **November 21, 2026, at 12:00 AM in Asia/Manila**; that
navigation schedule is configured in `src/features/photos/photoAvailability.mjs`.

The Vite build emits both `dist/index.html` and `dist/memories/index.html`, so
direct visits work on GitHub Pages without a router fallback or another hosting
service. Deploy the complete `dist` directory through the existing workflow.

### Guest gallery

The gallery shows completed photo uploads, newest first, with larger previews,
keyboard navigation, pagination and automatic updates. It checks for new photos
about every 30 seconds while the page is visible and online, preserving photos
already loaded. Automatic checks pause while a photo is open and resume when
it closes. Each successfully confirmed file triggers an immediate gallery
update, including the first file in a batch. Videos remain
in Drive and are excluded from this photo gallery.

Deleting a photo in Drive, moving it to Trash, or removing it from the wedding
folder excludes it from new gallery requests. Reload the page to fully
resync the displayed album after managing files in Drive. Restoring the same
file to the wedding folder makes it eligible to appear again.

Gallery requests use the existing guest code. The backend serves private image
previews without changing Drive sharing or exposing owner OAuth credentials.
Newly uploaded HEIC and TIFF photos rely on Drive's preview generation; a retry
is available while a preview is being prepared.

Deploy the updated backend first, then deploy the website through its existing
GitHub Pages workflow. No additional environment variable or OAuth permission
is needed. See [backend gallery details](backend/README.md#guest-photo-gallery).

The recommended backend for 50–100 simultaneous guests is now the **Cloud Run
resumable uploader**. It supports files up to 500 MB, independent transfers
across guests, confirmed byte progress and retries without restarting the file.
The destination remains the same wedding Drive folder.

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

The **Memories** navigation link opens the dedicated page’s matching “Share your memories” section.
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
is configured. The folder link alone does not activate uploads. The client-side
password gate does not secure the public upload endpoint; anyone with the
endpoint can submit supported files, using the script owner’s storage and quota.
There is no need to grant guests editor access to the Drive folder. Files inherit
the folder’s existing sharing settings; the script never makes them public or
returns album listings.

### Verify the deployed connection

Open the website in a signed-out/private browser window, unlock it, choose a
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
- Add an RSVP deadline
- Add a password-protected page if needed
- Replace placeholder text with your final invitation wording
