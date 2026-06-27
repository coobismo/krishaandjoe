const SPREADSHEET_ID = '10fyCAN4sg_NDr5q4zW5zjLiAMdTjrpai3dcO613waiw';
const SHEET_NAME = '';
const HEADERS = ['Submitted At', 'Name', 'Contact Number', 'Attendance', 'Guests', 'Message'];

function doPost(event) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const payload = JSON.parse(event.postData.contents || '{}');
    const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
    const sheet = getTargetSheet(spreadsheet);

    ensureHeaders(sheet);
    sheet.appendRow([
      payload.submittedAt ? new Date(payload.submittedAt) : new Date(),
      payload.name || '',
      payload.contactNumber || payload.phone || payload.email || '',
      formatAttendance(payload.attendance),
      payload.guests || '',
      payload.message || '',
    ]);

    return toJson({ ok: true });
  } catch (error) {
    return toJson({ ok: false, message: error.message });
  } finally {
    lock.releaseLock();
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
  const currentHeaders = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0];
  const headersMatch = HEADERS.every((header, index) => currentHeaders[index] === header);

  if (!headersMatch) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.setFrozenRows(1);
  }
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
