# Job request intake (Google Apps Script)

The "Request a Job" form on `for-residents.html` posts here. The script writes
every submission to a Google Sheet, then emails `ben@jobsu.app` a readable copy
with **Reply-To set to the resident**, so replying from Gmail reaches them
directly.

Unlimited submissions, no third-party service, no monthly cost.

## One deployment, several forms

Three pages post to this same web app URL. What a submission *is* comes from its
`source` field, not from a separate endpoint:

| `source` | posted by | tab | treated as |
|---|---|---|---|
| `for-residents` | the "Request a Job" form, `for-residents.html` | `Job requests` | a job — draft card + checklist |
| `resident-updates` | the "Stay in the loop" form, `for-residents.html` | `Resident updates` | a signup — email only |
| `jobs-board-alerts` | the alerts block, `jobs/index.html` | `Student job alerts` | a signup — email only |
| `unlock` (an `action`, not a source) | nothing any more | `Board unlocks` | dead; left for a later pass |

**Adding a form means adding its source to `SIGNUPS` in `job-request.gs`.** A
source that is not a key there falls through to the job-request path: the address
lands on the `Job requests` tab and the script mints a draft job card and a
"before it goes live" checklist for a job nobody asked for.

Signups are also **de-duplicated by email address**, so the same person
submitting twice does not produce two list rows or two notifications. Job
requests are not — a resident may legitimately ask for two different jobs.

### The resident mailing list is not the `Job requests` tab

Residents on the `Job requests` tab gave their address to get an answer about one
specific job. That is not consent to a newsletter. The only recorded consent is:

- a row on the `Resident updates` tab, or
- `marketingConsent: Yes` on a `Job requests` row (the tick box at the foot of
  the intake form, unchecked by default).

Rows predating that column have no recorded answer, and are deliberately left
alone.

## One-time setup

1. **Create the sheet.** In Google Drive, make a new spreadsheet named
   `JobsU — job requests`. The script creates the `Job requests` tab itself.
2. **Open the editor.** In that spreadsheet: **Extensions → Apps Script**.
3. **Paste the code.** Replace everything in `Code.gs` with the contents of
   [`job-request.gs`](job-request.gs). Save.
4. **Test before deploying.** Pick `testSubmission` in the function dropdown and
   press **Run**. Approve the permissions prompt (it needs to send mail as you
   and edit this sheet). A test row should appear in the sheet and a test email
   in your inbox. Delete the row afterwards.

   `testResidentSignup` does the same for the mailing list. Run it **twice**:
   the first run should answer `{ ok: true, mailed: true }`, the second
   `{ ok: true, duplicate: true }` with no second row on the tab — that is the
   email de-duplication working. Delete the row afterwards.
5. **Deploy.** **Deploy → New deployment → Web app**:
   - Description: `job request intake`
   - Execute as: **Me**
   - Who has access: **Anyone**  ← required; "Anyone with Google account" blocks residents
   - Press **Deploy** and copy the **Web app URL**
   (it looks like `https://script.google.com/macros/s/AKfy…/exec`)
6. **Wire up the site.** In `for-residents.html`, set:
   ```js
   var ENDPOINT = 'https://script.google.com/macros/s/AKfy…/exec';
   ```
   Commit and push. Submit a real request through the live page to confirm.

## The draft card in every email

Each notification ends with a **DRAFT CARD** block: a job object shaped like the
ones in the `JOBS` array in `jobs/index.html`, built from the submission. Copy
it, fix the `TODO`s, rewrite the description in the board's voice, and paste it
into the array.

The same JSON is stored in the sheet's `draftCard` column, so nothing is lost if
the email is deleted.

Under the block is a short **Before it goes live** list. It always calls out
`hoursPerWeek` (the form does not ask for it) and flags anything that should not
appear on a public page: a school name, a phone number, an email address, a
street address, or a health detail. The flags are prompts for a human, not
decisions — publishing is still a deliberate act.

## Changing the script later

Edit the code, then **Deploy → Manage deployments → ✏️ Edit → Version: New
version → Deploy**. This keeps the same URL. Using "New deployment" instead
mints a *different* URL and the site keeps posting to the old code.

## How it stays up

- **The sheet is written before the email is sent.** If Gmail's daily quota is
  hit, the lead is still captured and the site still reports success.
- **Columns are added automatically.** Adding a field to the form on the site
  creates a new column instead of dropping the answer.
- **Duplicate-proof.** Every submission carries a `submissionId`; a retry or a
  double click updates nothing and returns success.
- **Spam-resistant.** A shared token, a hidden honeypot field, and a minimum
  fill time are all checked server-side. The 3-second floor in `doPost` is
  mirrored by `MIN_FILL_MS` in `for-residents.html`, which holds a fast
  submission back rather than letting it be silently dropped &mdash; raise one
  and you must raise the other. Both forms on that page share that constant and
  the hold-back, but each keeps its **own** `openedAt`: the mailing list is one
  field and is easily filled inside three seconds, so it is the form that
  actually needs the hold.
- **The site degrades gracefully.** If this script is unreachable, times out, or
  returns an error, the page hands the resident a prefilled email containing
  everything they typed, so no request is ever lost.

## Limits worth knowing

| | Consumer Gmail |
|---|---|
| Emails per day | 100 |
| Script runtime | 6 min per execution (this uses well under a second) |
| Sheet rows | 10 million cells |

## Troubleshooting

- **No email, but rows appear** — Gmail quota, or the deployment's authorisation
  expired. Re-run `testSubmission` and re-approve.
- **Nothing arrives at all** — check the deployment is "Anyone" access, and that
  `ENDPOINT` in `for-residents.html` matches the current Web app URL exactly.
- **Executions log** — Apps Script editor → **Executions** shows every call, its
  payload size, and any error.
