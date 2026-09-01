/**
 * JobsU — job request intake.
 *
 * Receives a submission from the "Request a Job" form on jobsu.app,
 * appends it to the response sheet, then emails Ben a readable copy with
 * Reply-To set to the resident so he can answer straight from his inbox.
 *
 * Deploy: see README.md in this folder. The site posts JSON as text/plain,
 * which avoids a CORS preflight that Apps Script cannot answer.
 */

/** Where the notification lands. */
var NOTIFY_EMAIL = 'ben@jobsu.app';

/** Tab inside the bound spreadsheet. Created automatically if missing. */
var SHEET_NAME = 'Job requests';

/** Must match SHARED_TOKEN in for-residents.html. Blocks drive-by posts. */
var SHARED_TOKEN = 'jobsu-request-v1';

/** Fields never written to the sheet or the email body. */
var HIDDEN_FIELDS = { token: true, company: true, elapsedMs: true };

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    // Serialise writes so two submissions can never claim the same row.
    lock.waitLock(20000);
  } catch (err) {
    return json({ ok: false, error: 'busy' });
  }

  try {
    var payload = JSON.parse(e.postData.contents);

    if (payload.token !== SHARED_TOKEN) return json({ ok: false, error: 'bad token' });
    // Honeypot: real people never fill a field they cannot see.
    if (payload.company) return json({ ok: true, skipped: 'honeypot' });
    // Bots submit instantly; a person needs longer than three seconds.
    if (Number(payload.elapsedMs) < 3000) return json({ ok: true, skipped: 'too fast' });
    if (!payload.email || !payload.category) return json({ ok: false, error: 'missing fields' });

    var sheet = getSheet();

    // Retries and double clicks resolve to the same row rather than duplicates.
    if (payload.submissionId && hasSubmission(sheet, payload.submissionId)) {
      return json({ ok: true, duplicate: true });
    }

    // The sheet is written first: if mail fails, the lead is still captured.
    appendRow(sheet, payload);

    try {
      sendNotification(payload);
    } catch (mailErr) {
      console.error('mail failed: ' + mailErr);
      return json({ ok: true, mailed: false });
    }

    return json({ ok: true, mailed: true });
  } catch (err) {
    console.error(err);
    return json({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function doGet() {
  return json({ ok: true, service: 'jobsu-job-request' });
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(['Received', 'submissionId']);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function hasSubmission(sheet, id) {
  var headers = headerRow(sheet);
  var col = headers.indexOf('submissionId') + 1;
  if (col < 1 || sheet.getLastRow() < 2) return false;
  var ids = sheet.getRange(2, col, sheet.getLastRow() - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return true;
  }
  return false;
}

function headerRow(sheet) {
  return sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0];
}

/**
 * Writes the submission, adding a column for any field it has not seen
 * before. Editing the form on the site therefore cannot break intake.
 */
function appendRow(sheet, payload) {
  var headers = headerRow(sheet);

  Object.keys(payload).forEach(function (key) {
    if (HIDDEN_FIELDS[key]) return;
    if (headers.indexOf(key) === -1) headers.push(key);
  });
  if (headers.indexOf('Received') === -1) headers.unshift('Received');

  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);

  var row = headers.map(function (key) {
    if (key === 'Received') return new Date();
    return payload[key] == null ? '' : payload[key];
  });

  sheet.appendRow(row);
}

function sendNotification(payload) {
  var who = [payload.firstName, payload.lastName].filter(String).join(' ').trim() || 'Someone';
  var where = payload.town ? ' — ' + payload.town : '';
  var subject = 'New job request: ' + payload.category + where;

  var lines = [
    who + ' just requested a job through jobsu.app.',
    '',
    'Reply to this email and it goes straight to them.',
    ''
  ];

  Object.keys(payload).forEach(function (key) {
    if (HIDDEN_FIELDS[key] || key === 'submissionId') return;
    var value = payload[key];
    if (value === '' || value == null) return;
    lines.push(label(key) + ': ' + value);
  });

  MailApp.sendEmail({
    to: NOTIFY_EMAIL,
    subject: subject,
    body: lines.join('\n'),
    replyTo: payload.email,
    name: 'JobsU job requests'
  });
}

/** camelCase field name -> "Camel case" label for the email body. */
function label(key) {
  var spaced = key.replace(/([A-Z])/g, ' $1').replace(/[_-]+/g, ' ').toLowerCase().trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Run once from the editor to confirm the sheet and email both work. */
function testSubmission() {
  var result = doPost({
    postData: {
      contents: JSON.stringify({
        token: SHARED_TOKEN,
        submissionId: 'test-' + Date.now(),
        elapsedMs: 9000,
        firstName: 'Test',
        lastName: 'Resident',
        email: NOTIFY_EMAIL,
        phone: '(617) 555-0100',
        town: 'Newtonville',
        category: 'Babysitting',
        daysTimes: 'Tuesdays and Fridays, 2 to 6pm',
        kidsAges: 'Two kids, 3 and 6',
        startDate: 'Next month',
        rate: '$25 to $30',
        notes: 'This row came from testSubmission().'
      })
    }
  });
  Logger.log(result.getContent());
}
