const SPREADSHEET_ID = '10fyCAN4sg_NDr5q4zW5zjLiAMdTjrpai3dcO613waiw';
const SHEET_NAME = '';
const HEADERS = [
  'Submitted At',
  'Name',
  'Contact Number',
  'Attendance',
  'Guests',
  'Additional Guest Names',
  'Message',
];

function doPost(event) {
  const lock = LockService.getScriptLock();

  try {
    const payload = JSON.parse(event.postData.contents || '{}');
    const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
    const sheet = getTargetSheet(spreadsheet);

    // Open the spreadsheet before taking the lock so concurrent requests can
    // prepare independently. Only header setup and the write are serialized.
    lock.waitLock(30000);
    ensureHeaders(sheet);
    sheet.appendRow([
      payload.submittedAt ? new Date(payload.submittedAt) : new Date(),
      payload.name || '',
      payload.contactNumber || payload.phone || payload.email || '',
      formatAttendance(payload.attendance),
      payload.guests || '',
      payload.additionalGuestNames || '',
      payload.message || '',
    ]);

    SpreadsheetApp.flush();
    return toJson({ ok: true });
  } catch (error) {
    return toJson({ ok: false, message: error.message });
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
}

function doGet() {
  return toJson({ ok: true, message: 'Krisha & Joe RSVP endpoint is ready.' });
}

function getTargetSheet(spreadsheet) {
  if (SHEET_NAME) {
    return spreadsheet.getSheetByName(SHEET_NAME) || spreadsheet.insertSheet(SHEET_NAME);
  }

  return spreadsheet.getSheets()[0];
}

function ensureHeaders(sheet) {
  const cache = CacheService.getScriptCache();
  const cacheKey = `headers:${SPREADSHEET_ID}:${sheet.getSheetId()}:${HEADERS.join("|")}`;
  if (cache.get(cacheKey)) return;

  const currentHeaders = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0];
  const headersMatch = HEADERS.every((header, index) => currentHeaders[index] === header);

  if (!headersMatch) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.setFrozenRows(1);
  }

  // Cache only header readiness, never guest data. Cache misses still validate
  // the sheet, including after a new deployment or sheet change.
  cache.put(cacheKey, 'ready', 21600);
}

function formatAttendance(value) {
  if (value === 'yes') {
    return 'Yes';
  }

  if (value === 'no') {
    return 'No';
  }

  return value || '';
}

function toJson(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
