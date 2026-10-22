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

/**
 * SIGNUPS — sources that submit an email address rather than a job.
 *
 * A signup gets its own tab, a short replyable notification, and NO draft card:
 * there is no job to post. Anything whose `source` is not a key here is treated
 * as a job request, so adding a form to the site without adding it here writes
 * the address into 'Job requests' and mints a draft card for a job nobody asked
 * for. Keyed by the `source` the page sends.
 */
var SIGNUPS = {
  'jobs-board-alerts': {
    sheet: 'Student job alerts',
    subject: 'Job alerts signup: ',
    line: ' asked to hear about new jobs from the board.',
    name: 'JobsU job alerts'
  },
  'resident-updates': {
    sheet: 'Resident updates',
    subject: 'Resident mailing list: ',
    line: ' asked to hear about JobsU updates and free community events.',
    name: 'JobsU updates'
  }
};

/** Students who unlocked the board with a .edu address land here. */
var UNLOCK_SHEET_NAME = 'Board unlocks';

/** Only this domain may unlock the board. */
var ALLOWED_DOMAIN = 'bc.edu';

/**
 * The full job list, which deliberately does NOT live on jobsu.app. Pages
 * runs Jekyll, and Jekyll never publishes a folder beginning with an
 * underscore, so _data/jobs.json is in the repo but not on the site. This
 * script fetches it server-side, which keeps the URL out of the page too.
 */
var JOBS_URL = 'https://raw.githubusercontent.com/benewakim/jobsU-web/main/_data/jobs.json';

/** Must match SHARED_TOKEN in for-residents.html. Blocks drive-by posts. */
var SHARED_TOKEN = 'jobsu-request-v1';

/**
 * The bot trap's field name. It was `company` until 2026-10-22, and browser
 * autofill filled it, so real residents were discarded as bots with no row, no
 * email and no log line. The page now sends `jx_tripwire`; `company` is still
 * checked for a page that was open before the change.
 */
var TRIPWIRE = 'jx_tripwire';

/** Fields never written to the sheet or the email body. */
var HIDDEN_FIELDS = { token: true, company: true, jx_tripwire: true, elapsedMs: true };

/**
 * Every early return logs, so a discarded submission leaves a trace. Read these
 * in the Apps Script editor: Executions (left sidebar), click a run. Before
 * 2026-10-22 all of these returns were silent.
 */
function logBail(guard, payload) {
  var p = payload || {};
  console.log('DISCARDED [' + guard + '] submissionId=' + (p.submissionId || '-') +
              ' email=' + (p.email || '-') + ' category=' + (p.category || '-') +
              ' source=' + (p.source || '-') + ' elapsedMs=' + (p.elapsedMs == null ? '-' : p.elapsedMs));
}

/** Best-effort read of the body, for logging a bail that happens before parsing. */
function peekPayload(e) {
  try { return JSON.parse(e.postData.contents); } catch (err) { return {}; }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    // Serialise writes so two submissions can never claim the same row.
    lock.waitLock(20000);
  } catch (err) {
    logBail('busy: lock not acquired in 20s', peekPayload(e));
    return json({ ok: false, error: 'busy' });
  }

  try {
    var payload = JSON.parse(e.postData.contents);

    if (payload.token !== SHARED_TOKEN) {
      logBail('bad token', payload);
      return json({ ok: false, error: 'bad token' });
    }

    // Unlocking the board is a read, not a submission: no honeypot or timing
    // checks, because a returning student unlocks straight from localStorage.
    if (payload.action === 'unlock') return handleUnlock(payload);
    // Honeypot: real people never fill a field they cannot see. (Autofill did,
    // when the field was called `company`; see TRIPWIRE.)
    if (payload[TRIPWIRE] || payload.company) {
      logBail('honeypot: ' + (payload[TRIPWIRE] ? TRIPWIRE : 'company (old page)') + ' was filled', payload);
      return json({ ok: true, skipped: 'honeypot' });
    }
    // Bots submit instantly; a person needs longer than three seconds.
    if (Number(payload.elapsedMs) < 3000) {
      logBail('too fast', payload);
      return json({ ok: true, skipped: 'too fast' });
    }
    if (!payload.email || !payload.category) {
      logBail('missing fields', payload);
      return json({ ok: false, error: 'missing fields' });
    }

    var signup = SIGNUPS[payload.source] || null;
    var sheet = getSheet(signup ? signup.sheet : SHEET_NAME);

    // Retries and double clicks resolve to the same row rather than duplicates.
    if (payload.submissionId && hasSubmission(sheet, payload.submissionId)) {
      logBail('duplicate submissionId (already on the sheet)', payload);
      return json({ ok: true, duplicate: true });
    }

    // A mailing list must not hold the same address twice, and a second
    // notification for someone already on it is noise. Signups only: a resident
    // may legitimately request two different jobs from the same address.
    if (signup && emailOnSheet(sheet, payload.email)) {
      logBail('duplicate signup (email already on the list)', payload);
      return json({ ok: true, duplicate: true });
    }

    // A signup is an email address, not a job: no draft card, no checklist.
    var draft = signup ? null : buildDraft(payload);
    var flags = signup ? null : draftFlags(payload, draft);

    // The sheet is written first, so if mail fails the lead is still captured.
    // A sheet failure must not cost Ben the email either: before 2026-10-22 a
    // throw here skipped every email below, so the lead was lost in both places.
    var sheeted = true;
    try {
      appendRow(sheet, payload, signup ? {} : {
        draftCard: JSON.stringify(draft, null, 2),
        needsAttention: flags.join(' ')
      });
    } catch (sheetErr) {
      sheeted = false;
      console.error('sheet write failed: ' + sheetErr);
    }

    if (signup) {
      try {
        sendSignupNotification(payload, signup);
      } catch (mailErr) {
        console.error('signup mail failed: ' + mailErr);
        return json({ ok: true, sheeted: sheeted, mailed: false });
      }
      return json({ ok: true, sheeted: sheeted, mailed: true });
    }

    // TWO emails, both to Ben, sent independently. The first is the one he
    // replies to: Reply-To is the resident and it carries ONLY their answers, so
    // when Gmail quotes it back to them nothing internal goes with it. The second
    // carries the draft card and the checklist, with Reply-To Ben, so a mis-reply
    // can never reach the family. A failure of the second never stops the first.
    var mailed = true, drafted = true;
    try {
      sendNotification(payload);
    } catch (mailErr) {
      mailed = false;
      console.error('request mail failed: ' + mailErr);
    }
    try {
      sendDraftCard(payload, draft, flags);
    } catch (draftErr) {
      drafted = false;
      console.error('draft card mail failed: ' + draftErr);
    }

    return json({ ok: true, sheeted: sheeted, mailed: mailed, drafted: drafted });
  } catch (err) {
    console.error(err);
    return json({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

/**
 * Hands the full job list to a student who identifies with a bc.edu address,
 * and records the address so Ben can reach them about future jobs.
 */
function handleUnlock(payload) {
  var email = String(payload.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@bc\.edu$/.test(email)) {
    return json({ ok: false, error: 'Use your ' + ALLOWED_DOMAIN + ' address.' });
  }

  var jobs;
  try {
    jobs = fetchJobs();
  } catch (err) {
    console.error('job fetch failed: ' + err);
    return json({ ok: false, error: 'jobs unavailable' });
  }

  // Recording the address must never cost a student the jobs they asked for.
  var first = false;
  try {
    var sheet = getSheet(UNLOCK_SHEET_NAME, ['Unlocked', 'email']);
    first = !emailSeen(sheet, email);
    if (first) {
      sheet.appendRow([new Date(), email]);
      try {
        MailApp.sendEmail({
          to: NOTIFY_EMAIL,
          subject: 'New student on the board: ' + email,
          body: email + ' unlocked the job board for the first time.\n\n' +
                'Reply to this email and it goes straight to them.\n\n' +
                'Every address is on the "' + UNLOCK_SHEET_NAME + '" tab.',
          replyTo: email,
          name: 'JobsU job board'
        });
      } catch (mailErr) {
        console.error('unlock mail failed: ' + mailErr);
      }
    }
  } catch (sheetErr) {
    console.error('unlock log failed: ' + sheetErr);
  }

  return json({ ok: true, jobs: jobs, first: first });
}

/** Cached briefly so a burst of unlocks is one fetch, not one per student. */
function fetchJobs() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('jobs');
  if (hit) return JSON.parse(hit);

  var res = UrlFetchApp.fetch(JOBS_URL, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('HTTP ' + res.getResponseCode());
  var body = res.getContentText();
  JSON.parse(body); // fail here rather than handing a student broken JSON
  cache.put('jobs', body, 300);
  return JSON.parse(body);
}

/**
 * Is this address already on a signup tab?
 *
 * Distinct from emailSeen() below, which the board-unlock path uses: that tab is
 * created with a fixed ['Unlocked', 'email'] header so its email is always
 * column 2. A signup tab's columns are grown by appendRow() in whatever order
 * the page first sent them, so the column has to be looked up by name. Reading
 * column 2 here would have compared submission ids to email addresses and never
 * found a duplicate.
 */
function emailOnSheet(sheet, email) {
  var wanted = String(email || '').trim().toLowerCase();
  if (!wanted) return false;
  var col = headerRow(sheet).indexOf('email') + 1;
  if (col < 1 || sheet.getLastRow() < 2) return false;
  var values = sheet.getRange(2, col, sheet.getLastRow() - 1, 1).getValues();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim().toLowerCase() === wanted) return true;
  }
  return false;
}

function emailSeen(sheet, email) {
  if (sheet.getLastRow() < 2) return false;
  var values = sheet.getRange(2, 2, sheet.getLastRow() - 1, 1).getValues();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim().toLowerCase() === email) return true;
  }
  return false;
}

function doGet() {
  return json({ ok: true, service: 'jobsu-job-request' });
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getSheet(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers || ['Received', 'submissionId']);
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

/** Someone asking to hear from JobsU. Short, and replyable. */
function sendSignupNotification(payload, signup) {
  MailApp.sendEmail({
    to: NOTIFY_EMAIL,
    subject: signup.subject + payload.email,
    body: [
      payload.email + signup.line,
      '',
      'Reply to this email and it goes straight to them.',
      '',
      'They are on the "' + signup.sheet + '" tab of the requests sheet.'
    ].join('\n'),
    replyTo: payload.email,
    name: signup.name
  });
}

function requesterName(payload) {
  return [payload.firstName, payload.lastName].filter(String).join(' ').trim() || 'Someone';
}

/**
 * The email Ben REPLIES to. Reply-To is the resident, so Gmail will quote this
 * whole body back to them: it must hold nothing but their own answers. The
 * draft card, its derived id and the checklist (some of whose flags read badly
 * to a family: the health-detail, phone-number and street-address ones) go in
 * sendDraftCard() instead. Do not add internal content here.
 */
function sendNotification(payload) {
  var where = payload.town ? ' — ' + payload.town : '';
  var subject = 'New job request: ' + payload.category + where;

  var lines = [
    requesterName(payload) + ' just requested a job through jobsu.app.',
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
    htmlBody: '<div style="font-family:system-ui,-apple-system,sans-serif;font-size:14px;line-height:1.6;color:#0B1B3A"><p>' +
              lines.map(escapeHtml).join('<br>') + '</p></div>',
    replyTo: payload.email,
    name: 'JobsU job requests'
  });
}

/**
 * The internal half: the draft card and the pre-posting checklist. Reply-To is
 * Ben, NOT the resident, so replying to it by mistake reaches nobody else.
 */
function sendDraftCard(payload, draft, flags) {
  var lines = [
    'Draft card for ' + requesterName(payload) + "'s request" + (payload.town ? ' (' + payload.town + ')' : '') + '.',
    'Internal: replies to this email go to ' + NOTIFY_EMAIL + ', not to the resident.',
    '',
    '──────────────────────────────────────────',
    'DRAFT CARD — paste into the JOBS array in jobs/index.html',
    '──────────────────────────────────────────',
    '',
    JSON.stringify(draft, null, 2),
    '',
    'Before it goes live:'
  ];
  flags.forEach(function (f) { lines.push('  • ' + f); });

  MailApp.sendEmail({
    to: NOTIFY_EMAIL,
    subject: 'Draft card: ' + draft.title,
    body: lines.join('\n'),
    // Plain text gets hard-wrapped at ~72 characters by mail clients, which
    // puts line breaks inside the JSON strings and makes the draft unpastable.
    // A <pre> block in the HTML part survives intact.
    htmlBody: htmlVersion(lines, draft, flags),
    replyTo: NOTIFY_EMAIL,
    name: 'JobsU draft cards'
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

/** Field names whose camelCase reading would be unclear in the email. */
var LABEL_OVERRIDES = {
  drivesKids: 'Drives the children',
  gettingHere: 'Getting to the house',
  drivingNeeded: 'Driving needed (old form)',
  // The lessons field is still named `sport` (see lessonsRole); since
  // 2026-10-22 it asks "What would they be learning?", and may be guitar.
  sport: 'Learning'
};

/** camelCase field name -> "Camel case" label for the email body. */
function label(key) {
  if (LABEL_OVERRIDES[key]) return LABEL_OVERRIDES[key];
  var spaced = key.replace(/([A-Z])/g, ' $1').replace(/[_-]+/g, ' ').toLowerCase().trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/* ──────────────────────────────────────────────────────────────
   Draft card generator

   Turns a submission into a job object shaped exactly like the ones
   in jobs/index.html, so a posting is copy, edit, paste. It fills what
   the form actually asked and marks the rest TODO rather than guessing.
   ────────────────────────────────────────────────────────────── */

/** Category -> the role word used in a board title.
    Keyed to the FORM's category list in for-residents.html, which is friendlier
    than the platform's job_type vocabulary on purpose. Babysitting is handled by
    roleFor() below instead of here — see why. */
var ROLE_WORDS = {
  'Babysitting': 'After-School Care',
  'Tutoring': 'Tutoring',
  'Driving': 'Driving Role',
  'Moving Help': 'Moving Help',
  // Music or Sports Lessons is handled by roleFor(), from what the family typed.
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
  // Capitalised: "guitar lessons" (the family's own lower-case answer plus a
  // suffix) used to open a draft description in lower case.
  t = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(t) ? t : t + '.';
}

/**
 * "Home" -> "At home", "Local pool" -> "At a local pool", "Our yard" -> "In our
 * yard". The lessons location used to go into the description raw, so a draft
 * read "Guitar lessons. Child is 6. Just starting out. Home." A family that
 * already typed a phrase ("at the Newton Y", "In our backyard") is left as
 * written, capitalised, so it never comes out as "At at home".
 */
function locationPhrase(raw) {
  var t = String(raw || '').replace(/\s+/g, ' ').trim().replace(/[.,;]+$/, '');
  if (!t) return '';
  var cap = function (s) { return s.charAt(0).toUpperCase() + s.slice(1); };
  var lowerFirst = function (s) { return s.charAt(0).toLowerCase() + s.slice(1); };
  if (/^(at|in|on|from|near|by|around|outside|inside|over)\b/i.test(t)) return cap(t);
  if (/^(home|my home|our home|our house|my house|the house)$/i.test(t)) {
    return /^home$/i.test(t) ? 'At home' : 'At ' + lowerFirst(t);
  }
  var outdoorOwn = /\b(yard|backyard|back yard|garden|driveway)\b/i.test(t);
  if (/^(our|my|their|the|a|an)\b/i.test(t)) return (outdoorOwn ? 'In ' : 'At ') + lowerFirst(t);
  if (/^(local|nearby)\b/i.test(t)) return 'At a ' + lowerFirst(t);
  return 'At ' + t;
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
    'Music or Sports Lessons': [p.sport && p.sport + ' lessons', p.childAge && 'Child is ' + p.childAge,
                                p.skillLevel, locationPhrase(p.lessonLocation)],
    // The label before 2026-10-22, for a page still open in somebody's browser.
    'Sports Lessons': [p.sport && p.sport + ' lessons', p.childAge && 'Child is ' + p.childAge,
                       p.skillLevel, locationPhrase(p.lessonLocation)],
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

/**
 * The car line for the draft card, from the two questions split out on
 * 2026-10-19 (drivesKids, gettingHere), falling back to the old drivingNeeded.
 * The DATABASE decides the stored values, in public.request_car_fields(); this
 * only words them for the email, so keep the two in step if either changes.
 * Curly apostrophes are folded first: the form submits "They’ll" and "We’ll".
 */
function carLine(p) {
  var fold = function (v) { return String(v || '').toLowerCase().replace(/[\u2018\u2019]/g, "'").trim(); };
  var drives = fold(p.drivesKids), arrive = fold(p.gettingHere), legacy = fold(p.drivingNeeded);
  if (drives || arrive) {
    if (drives.indexOf('yes, in their own car') === 0)
      return /gas|mileage/.test(drives) ? 'Own car needed; the family covers gas or mileage' : 'Own car needed';
    if (drives === 'yes, in our car')
      return arrive.indexOf("they'll need their own car") === 0
        ? 'Own car needed to get there; the family provides a car for driving the children'
        : 'The family provides the car';
    if (arrive.indexOf("they'll need their own car") === 0) return 'Own car needed to get there';
    if (arrive.indexOf("we'll cover") === 0) return 'The family covers a ride to get there';
    return null;
  }
  // Old single question.
  if (/cover gas/.test(legacy)) return 'Own car needed; the family covers gas';
  if (/own car|student uses/.test(legacy)) return 'Own car needed';
  if (/we provide a car/.test(legacy)) return 'The family provides the car';
  if (/uber|ride to get here/.test(legacy)) return 'The family covers a ride to get there';
  return null;
}

/** Whatever the form learned about a car, tools, or access. */
function requirementsFor(p) {
  var bits = [];
  p = p || {};
  var car = carLine(p);
  if (car) bits.push(car);
  if (/student brings/i.test(p.toolsProvided || '')) bits.push('Student brings their own tools');
  return bits.length ? bits.join('. ') + '.' : null;
}

/**
 * The role word for a lessons title, from what the family said they want taught.
 * It used to be a fixed "Coaching", which is right for goalkeeping and wrong for
 * guitar. "guitar" -> "Guitar Lessons"; "swim lessons" -> "Swim Lessons" (no
 * doubled word); nothing typed -> "Lessons". The field is still named `sport`
 * because changing a field name would break every reader of old submissions.
 */
function lessonsRole(p) {
  var what = String(p.sport || '').replace(/\s+/g, ' ').trim();
  if (!what) return 'Lessons';
  var titled = what.split(' ').map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(' ');
  return /\b(lessons?|coaching|clinic)\b/i.test(titled) ? titled : titled + ' Lessons';
}

/**
 * The role word for a title.
 *
 * Babysitting cannot use a fixed word. ROLE_WORDS mapped it to
 * "After-School Care" unconditionally, so EVERY babysitting request became
 * "After-School Care, <town>" — including Teresa Chamberlain's occasional
 * evening and weekend sitting, which is not after-school care, and Ashley
 * Rose's, whose draft came out byte-identical in both title and id. Babysitting
 * is the commonest category on the form, so the one word that was always wrong
 * was also the most used.
 *
 * The id is slug(title), so a wrong title silently produced a wrong id too, and
 * two requests from the same town collided. The live board has no collision only
 * because every title has been rewritten by hand before pasting.
 *
 * This reads the schedule the family actually typed. It is a heuristic and the
 * checklist still says to check the title — but it starts from what was asked
 * for rather than from one guess applied to everything.
 */
function roleFor(p) {
  if (p.category === 'Music or Sports Lessons' || p.category === 'Sports Lessons') return lessonsRole(p);
  if (p.category !== 'Babysitting') return ROLE_WORDS[p.category] || 'Help';
  var when = String((p.daysTimes || '') + ' ' + (p.frequency || '') + ' ' + (p.householdNotes || ''));
  if (/after[-\s]?school|school pickup|pick ?up from school|dismissal/i.test(when)) return 'After-School Care';
  // Nobody writes "after school" when they write "Tuesday and Thursday from
  // 2:45-6". Ashley Rose's request is exactly that, and the words-only version
  // of this called it "Sitter". A start time between 2 and 4:30pm IS the school
  // run, so read the clock as well as the vocabulary.
  var startHour = when.match(/\b(1?\d)(?::(\d{2}))?\s*(am|pm)?\s*(?:-|to|–)/i);
  if (startHour) {
    var h = parseInt(startHour[1], 10);
    var mins = startHour[2] ? parseInt(startHour[2], 10) : 0;
    var isPm = /pm/i.test(startHour[3] || '') || (h >= 1 && h <= 6 && !/am/i.test(startHour[3] || ''));
    var h24 = isPm && h < 12 ? h + 12 : h;
    var t = h24 * 60 + mins;
    if (t >= 14 * 60 && t <= 16 * 60 + 30 && !/weekend|saturday|sunday/i.test(when)) {
      return 'After-School Care';
    }
  }
  var evening = /evening|night|date night|bedtime/i.test(when);
  var weekend = /weekend|saturday|sunday/i.test(when);
  if (evening && weekend) return 'Evening and Weekend Sitter';
  if (evening) return 'Evening Sitter';
  if (weekend) return 'Weekend Sitter';
  if (/morning/i.test(when)) return 'Morning Sitter';
  return 'Sitter';
}

function buildDraft(p) {
  var money = parseRate(p.rate);
  var role = roleFor(p);
  var town = p.town || 'TODO town';
  var title = role + ', ' + town;

  // Schedule and frequency are one line on the board card. Both were collected
  // before this and only the schedule half ever reached the card, so every
  // "Recurring" answer was retyped by hand. `dateAndTime` was Moving Help's
  // second date question and is gone from the form.
  var schedule = p.daysTimes || 'TODO';
  if (p.frequency) schedule = p.daysTimes ? schedule + ' — ' + p.frequency : p.frequency;

  var draft = {
    id: slug(title),
    title: title,
    category: p.category,
    rate: money.rate,
    rateUnit: money.rateUnit,
    area: town,
    start: p.startDate || 'TODO',
    schedule: schedule,
    // The form asks this now. It used to be hardcoded TODO on every card, and
    // Moving Help's `estimatedHours` was collected and then dropped here.
    hoursPerWeek: p.duration || 'TODO',
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
  // Was an unconditional "hours/week is not asked on the form". It is asked now,
  // so this fires only when the resident left it blank.
  if (!p.duration) flags.push('No duration given — work the hours out from the schedule.');
  // Checked against the answer, not against draft.schedule: a frequency with no
  // days and times still leaves the card without a schedule.
  if (!p.daysTimes) flags.push('No days and times given.');
  if (draft.start === 'TODO') flags.push('No start date given.');
  if (!p.town) flags.push('No town given — the title and area both need one.');
  // The one car combination the job columns cannot hold (requires_car true AND
  // car_provided is forbidden). Agreed 2026-10-19: requires_car true, and the
  // family's car goes in the description.
  var fold = function (v) { return String(v || '').toLowerCase().replace(/[\u2018\u2019]/g, "'").trim(); };
  if (fold(p.drivesKids) === 'yes, in our car' && fold(p.gettingHere).indexOf("they'll need their own car") === 0)
    flags.push('Car: the family provides a car for driving the children, but the student needs their own car to get there. Post with requires_car true and say in the description that the family car is for driving the children.');
  // The script cannot see jobs/index.html, so it cannot know whether this id is
  // taken. It derives both title and id from a category and a town, which is not
  // enough to be unique: two babysitting requests from one town produce the same
  // id, and duplicate ids in the JOBS array are a silent collision.
  flags.push('Title and id are both derived — "' + draft.id + '". Check it is not already in the JOBS array, and that the title matches what the family actually asked for.');
  // The landmark deliberately does NOT go on the card: it narrows a family's
  // location on a public page. Its readers are the request email and the sheet,
  // where it answers "how far is this from campus" without being published.
  // Required on the form since 2026-10-22, so the "No landmark given" flag that
  // lived here can no longer fire and was removed.

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
        town: 'Newton',
        landmark: 'Near the high school',
        category: 'Babysitting',
        daysTimes: 'Tuesdays and Fridays, 2 to 6pm',
        frequency: 'Recurring (weekly or so)',
        duration: 'About four hours',
        kidsAges: 'Two kids, 3 and 6',
        startDate: 'Next month',
        rate: '$25 to $30',
        notes: 'This row came from testSubmission().'
      })
    }
  });
  Logger.log(result.getContent());
}

/** Run once from the editor to confirm the resident mailing list works. */
function testResidentSignup() {
  var result = doPost({
    postData: {
      contents: JSON.stringify({
        token: SHARED_TOKEN,
        submissionId: 'test-sub-' + Date.now(),
        elapsedMs: 9000,
        source: 'resident-updates',
        category: 'Resident updates',
        email: NOTIFY_EMAIL
      })
    }
  });
  // Expect { ok: true, mailed: true } the first time and
  // { ok: true, duplicate: true } on a second run, with no second row.
  Logger.log(result.getContent());
}
