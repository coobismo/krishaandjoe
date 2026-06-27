# Krisha & Joe Wedding Website

A minimalist ivory-and-blue wedding website boilerplate for Krisha and Joe's wedding on November 21, 2026.

## Features

- Responsive React + Vite starter project
- Hero section with countdown
- Our Story section
- Subtle cat section for Cookie, Biscuit, and S'mores
- Wedding details section
- RSVP form wired for Google Sheets via Google Apps Script
- FAQ / must-knows section

## How to run locally

```bash
npm install
npm run dev
```

Then open the local URL shown in your terminal.

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

## Suggested next edits

- Add final ceremony and reception venue details
- Add real engagement/prenup photos
- Add an RSVP deadline
- Add a password-protected page if needed
- Replace placeholder text with your final invitation wording
