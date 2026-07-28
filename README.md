# JobsU — Marketing Site (jobsu.app)

Static HTML marketing site for **jobsu.app**. Plain `.html` files, no build step;
deployed via **GitHub Pages** from the **`main`** branch (`CNAME` → `jobsu.app`).

> The resident app portal is a **separate** repo (`jobsu-resident` → app.jobsu.app).
> This repo is marketing only.

## ⚠️ TEMPORARY: concierge interstitial (put up 2026-07-28)

While `app.jobsu.app` is **not publicly live**, every resident **"Post a Job"** CTA
routes to **`for-residents.html`** — a manual, founder-run concierge flow (email
Ben) — instead of to signup. **Students still sign up normally.**

### Revert when the platform goes live

1. **Repoint all 15 resident "Post a Job" CTAs** from `for-residents.html` back to
   `https://app.jobsu.app` (re-add `target="_blank" rel="noopener"`; the
   `post_job_clicked` onclick can stay). Find them with `grep -rn for-residents.html`:
   - `index.html` — nav CTA, hero button, "How it Works" resident button, bottom CTA, footer (5)
   - `about.html` — body CTA, footer (2)
   - `help.html` — footer (1)
   - `contact.html`, `terms.html`, `privacy.html`, `cookie-policy.html`, `cybersecurity.html`, `acceptable-use.html` — footer (6)
   - `for-residents.html` — footer (self; moot once deleted) (1)
2. **Restore `help.html`'s "How do I post a job?" answer** to the account-based
   instructions ("Create an account at app.jobsu.app, then tap 'Post a Job'…" — see git history).
3. **Restore "Sign In" to the `index.html` header nav.** It was moved out of
   `<ul class="nav-links">` into the footer Legal column ("Resident Sign In");
   remove it from the footer and put it back in the nav before the "Post a Job" nav-cta.
   Target unchanged: `https://app.jobsu.app/sign-in`.
4. **Delete or archive `for-residents.html`.**

**Keepers — do NOT revert:** the `.edu-confirmed` student language (replaced the
old "trusted, hand-picked / individually reviewed / verified" screening claims)
and the site-wide `posthog.init`.

The same checklist lives in an HTML comment at the top of `for-residents.html`.

## Analytics
PostHog is initialized on every page. Key resident-funnel events:
`post_job_clicked` (CTA) → `for-residents.html` pageview (arrival) →
`concierge_email_clicked` (reached out).
