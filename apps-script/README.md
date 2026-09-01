# Job request intake (Google Apps Script)

The "Request a Job" form on `for-residents.html` posts here. The script writes
every submission to a Google Sheet, then emails `ben@jobsu.app` a readable copy
with **Reply-To set to the resident**, so replying from Gmail reaches them
directly.

Unlimited submissions, no third-party service, no monthly cost.

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
  and you must raise the other.
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
