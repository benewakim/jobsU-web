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

    var draft = buildDraft(payload);
    var flags = draftFlags(payload, draft);

    // The sheet is written first: if mail fails, the lead is still captured.
    appendRow(sheet, payload, {
      draftCard: JSON.stringify(draft, null, 2),
      needsAttention: flags.join(' ')
    });

    try {
      sendNotification(payload, draft, flags);
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
function appendRow(sheet, payload, extras) {
  var headers = headerRow(sheet);
  var row = {};

  Object.keys(payload).forEach(function (key) {
    if (HIDDEN_FIELDS[key]) return;
    row[key] = payload[key];
  });
  Object.keys(extras || {}).forEach(function (key) { row[key] = extras[key]; });

  Object.keys(row).forEach(function (key) {
    if (headers.indexOf(key) === -1) headers.push(key);
  });
  if (headers.indexOf('Received') === -1) headers.unshift('Received');

  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);

  sheet.appendRow(headers.map(function (key) {
    if (key === 'Received') return new Date();
    return row[key] == null ? '' : row[key];
  }));
}

function sendNotification(payload, draft, flags) {
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

  lines.push('');
  lines.push('──────────────────────────────────────────');
  lines.push('DRAFT CARD — paste into the JOBS array in jobs/index.html');
  lines.push('──────────────────────────────────────────');
  lines.push('');
  lines.push(JSON.stringify(draft, null, 2));
  lines.push('');
  lines.push('Before it goes live:');
  flags.forEach(function (f) { lines.push('  • ' + f); });

  MailApp.sendEmail({
    to: NOTIFY_EMAIL,
    subject: subject,
    body: lines.join('\n'),
    // Plain text gets hard-wrapped at ~72 characters by mail clients, which
    // puts line breaks inside the JSON strings and makes the draft unpastable.
    // A <pre> block in the HTML part survives intact.
    htmlBody: htmlVersion(lines, draft, flags),
    replyTo: payload.email,
    name: 'JobsU job requests'
  });
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Same content as the plain-text part, with the draft kept copy-pasteable. */
function htmlVersion(lines, draft, flags) {
  var answers = [];
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('─') === 0) break;
    answers.push(escapeHtml(lines[i]));
  }

  var html = [
    '<div style="font-family:system-ui,-apple-system,sans-serif;font-size:14px;line-height:1.6;color:#0B1B3A">',
    '<p>' + answers.join('<br>') + '</p>',
    '<p style="font-weight:700;margin-bottom:6px">Draft card &mdash; paste into the JOBS array in jobs/index.html</p>',
    '<pre style="background:#F5F8FF;border:1px solid #E6ECFF;border-radius:8px;padding:14px;',
    'font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;line-height:1.5;',
    'white-space:pre;overflow-x:auto">',
    escapeHtml(JSON.stringify(draft, null, 2)),
    '</pre>',
    '<p style="font-weight:700;margin-bottom:6px">Before it goes live</p>',
    '<ul style="margin-top:0;padding-left:20px">'
  ];
  flags.forEach(function (f) { html.push('<li>' + escapeHtml(f) + '</li>'); });
  html.push('</ul></div>');
  return html.join('');
}

/** camelCase field name -> "Camel case" label for the email body. */
function label(key) {
  var spaced = key.replace(/([A-Z])/g, ' $1').replace(/[_-]+/g, ' ').toLowerCase().trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/* ──────────────────────────────────────────────────────────────
   Draft card generator

   Turns a submission into a job object shaped exactly like the ones
   in jobs/index.html, so a posting is copy, edit, paste. It fills what
   the form actually asked and marks the rest TODO rather than guessing.
   ────────────────────────────────────────────────────────────── */

/** Category -> the role word used in a board title. */
var ROLE_WORDS = {
  'Babysitting': 'After-School Care',
  'Tutoring': 'Tutoring',
  'Driving': 'Driving Role',
  'Moving Help': 'Moving Help',
  'Sports Lessons': 'Coaching',
  'Yard Work': 'Yard Work',
  'Tech Setup': 'Tech Setup',
  'Something else': 'Help'
};

/** Free text -> the board's rate + rateUnit pair. */
function parseRate(raw) {
  var text = String(raw || '');
  var nums = text.match(/\d+(?:\.\d+)?/g) || [];

  var unit = 'per hour';
  if (/week/i.test(text)) unit = 'per week';
  else if (/day/i.test(text)) unit = 'per day';
  else if (/ride/i.test(text)) unit = 'per ride';
  else if (/session|visit/i.test(text)) unit = 'per session';
  else if (/flat|total|job/i.test(text)) unit = /person|each/i.test(text) ? 'flat per person' : 'flat';

  if (!nums.length) return { rate: 'TODO', rateUnit: unit };
  if (nums.length === 1) return { rate: '$' + nums[0], rateUnit: unit };
  return { rate: '$' + nums[0] + ' to $' + nums[1], rateUnit: unit };
}

function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function sentence(text) {
  var t = String(text || '').trim();
  if (!t) return '';
  return /[.!?]$/.test(t) ? t : t + '.';
}

/** The answers that describe the work, in the order they read best. */
function describe(p) {
  var byCategory = {
    'Babysitting': [p.kidsAges, p.householdNotes],
    'Tutoring': [p.subjects && 'Subjects: ' + p.subjects, p.gradeLevel && 'Student is in ' + p.gradeLevel,
                 p.format, p.learningNotes],
    'Driving': [p.pickupLocation && p.dropoffLocation
                  ? 'Pickup at ' + p.pickupLocation + ', drop-off at ' + p.dropoffLocation
                  : (p.pickupLocation || p.dropoffLocation)],
    'Moving Help': [p.peopleNeeded && p.peopleNeeded + ' people needed', p.access,
                    p.truckProvided && 'Truck: ' + p.truckProvided.toLowerCase()],
    'Sports Lessons': [p.sport && p.sport + ' lessons', p.childAge && 'Child is ' + p.childAge,
                       p.skillLevel, p.lessonLocation],
    'Yard Work': [p.yardTasks, p.yardSize && p.yardSize + ' yard', p.toolsProvided],
    'Tech Setup': [p.techTasks, p.devices && 'Devices: ' + p.devices, p.techNotes],
    'Something else': [p.whatYouNeed]
  };

  var parts = (byCategory[p.category] || [])
    .filter(function (x) { return x; })
    .map(sentence)
    .filter(function (x) { return x; });
  var first = parts.join(' ').trim();
  var out = [];
  if (first) out.push(first);
  if (p.notes) out.push(sentence(p.notes));
  if (!out.length) out.push('TODO: describe the job.');
  return out;
}

/** Whatever the form learned about a car, tools, or access. */
function requirementsFor(p) {
  var bits = [];
  p = p || {};
  if (/own car|student uses/i.test(p.drivingNeeded || '')) bits.push('Own car needed');
  if (/own/i.test(p.carProvided || '')) bits.push('Own car needed');
  if (/student brings/i.test(p.toolsProvided || '')) bits.push('Student brings their own tools');
  return bits.length ? bits.join('. ') + '.' : null;
}

function buildDraft(p) {
  var money = parseRate(p.rate);
  var role = ROLE_WORDS[p.category] || 'Help';
  var town = p.town || 'TODO town';
  var title = role + ', ' + town;

  var schedule = p.daysTimes || p.dateAndTime || 'TODO';

  var draft = {
    id: slug(title),
    title: title,
    category: p.category,
    rate: money.rate,
    rateUnit: money.rateUnit,
    area: town,
    start: p.startDate || 'TODO',
    schedule: schedule,
    hoursPerWeek: 'TODO',
    description: describe(p)
  };

  var reqs = requirementsFor(p);
  if (reqs) draft.requirements = reqs;
  return draft;
}

/** Things a person should look at before this goes on a public page. */
function draftFlags(p, draft) {
  var flags = [];
  var publicText = draft.description.join(' ') + ' ' + (draft.requirements || '');

  if (draft.rate === 'TODO') flags.push('No rate given — ask before posting.');
  flags.push('Hours/week is not asked on the form — work it out from the schedule.');
  if (draft.schedule === 'TODO') flags.push('No schedule given.');
  if (draft.start === 'TODO') flags.push('No start date given.');
  if (!p.town) flags.push('No town given — the title and area both need one.');

  if (/\b(school|elementary|middle|high|academy|preschool)\b/i.test(publicText)) {
    flags.push('Mentions a school. Board convention is to name the town, not the school.');
  }
  if (/\d{3}[\s.-]?\d{3}[\s.-]?\d{4}/.test(publicText)) flags.push('Contains a phone number — take it out.');
  if (/@/.test(publicText)) flags.push('Contains an email address — take it out.');
  if (/\d+\s+[A-Z][a-z]+\s+(St|Street|Ave|Avenue|Rd|Road|Ln|Lane|Dr|Drive|Way|Ct|Court)\b/.test(publicText)) {
    flags.push('Looks like a street address — take it out.');
  }
  if (/allerg|adhd|dyslex|autis|neurodiver|anxiet|medical|diagnos/i.test(publicText)) {
    flags.push('Mentions a health detail. Keep it only if a student needs it to do the job safely.');
  }
  flags.push('Rewrite the description in the board\'s voice before pasting.');
  return flags;
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
