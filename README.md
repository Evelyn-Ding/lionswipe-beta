# LionSwipe

Website: [https://www.lionswipe.com/](https://www.lionswipe.com/) / [https://lionswipe.vercel.app/](https://lionswipe-beta.vercel.app/)

## Build Stack

Columbia dining menus and meal-swipe / spending tracking. Frontend is a single
`index.html` (no build step); `api/` holds Vercel serverless functions; Supabase
handles auth + data.

## Local setup

```
npm install
```

Copy your real Supabase project values into `config.js` (already gitignored):
`SUPABASE_URL` and `SUPABASE_ANON_KEY` from Supabase → Project Settings → API.
Run `schema.sql` once in the Supabase SQL editor to create the tables.

## Running the app locally

The frontend calls `/api/menus`, so a plain static server (e.g. `npx serve .`)
won't fully work — that route will 404. Use the Vercel CLI instead, which runs
the `api/*.js` functions locally exactly as they'd run in production:

```
npm i -g vercel      # once
vercel dev
```

First run will ask to link a Vercel project (or you can skip linking and it still
serves locally). No API keys are required for local dev beyond Supabase — set
`SUPABASE_URL` either by linking to a Vercel project that already has it set, or
by creating a local `.env` file:

```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...   # only needed for the scraper, see below — never in config.js
```

Then open the URL `vercel dev` prints (usually `http://localhost:3000`).

## Testing the menu scraper

`scripts/scrape-menus.js` pulls today's menus from
[liondine.com](https://liondine.com), a site that already aggregates every
Columbia dining hall (`dining.columbia.edu`) and Barnard's two dining locations
(`dineoncampus.com`) into one place, in a fixed 11-hall order, and is plain
server-rendered HTML with no Cloudflare challenge — so this is just a `fetch()`
against `liondine.com/breakfast`, `/lunch`, `/dinner`, and `/latenight`, no
browser needed. See the comment at the top of that file for the exact markup
it parses (`<div class="col">` per hall, `<div class="food-type">`/
`<div class="food-name">` per item).

```
npm run scrape:menus
```

This prints the extracted menus to the terminal. `scripts/scrape-output/*.html`
(one per meal period) are saved either way for debugging — if a run comes back
all-empty unexpectedly, check those first for whether liondine's markup changed.

Outside of the fall/spring semester (breaks, summer), dining halls publish nothing,
so a successful run will correctly print all-empty meal periods — that's expected,
not a bug. Re-test once dining halls are back in session (check `SEMESTER_START` in
`config.js`) to confirm real content comes through.

**Production schedule:** `.github/workflows/scrape-menus.yml` runs the scraper every
2 hours via GitHub Actions once this repo is pushed to GitHub, using `SUPABASE_URL` /
`SUPABASE_SERVICE_ROLE_KEY` repo secrets (Settings → Secrets and variables →
Actions). The service role key bypasses Row Level Security to write — never put it
in `config.js` or anything shipped to the browser.

## Auth email deliverability (Supabase "Confirm signup" template)

By default, Supabase's signup-confirmation email links straight to
`https://<project-ref>.supabase.co/auth/v1/verify?...`. Sent from a custom SMTP
domain (this project uses Resend + `lionswipe.com`), that's a sender-domain vs.
link-domain mismatch — a pattern Google Workspace's Advanced Phishing
Protection silently quarantines, even with SPF/DKIM/DMARC all passing and
Resend reporting "Delivered" (confirmed 2026-09-04 against `@columbia.edu`
addresses). `index.html` already handles verifying a `token_hash` client-side
(search for `verifyOtp`), so the email template just needs to link to our own
domain instead. **This is a per-Supabase-project dashboard setting, not
version-controlled** — redo it any time the project switches Supabase backends:

Supabase dashboard → Authentication → Email Templates → **Confirm signup** →
replace the link's `href` with:

```
https://www.lionswipe.com/?token_hash={{ .TokenHash }}&type=signup
```

(If a password-reset flow gets added later, its template needs the same
treatment with `type=recovery`, and `index.html`'s handler already forwards
whatever `type` value it finds in the URL.)

## Deploying

Vercel build command should run `node scripts/generate-config.js` first (it writes
`config.js` from the `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SEMESTER_*` env vars set
in Vercel's Project Settings, since `config.js` itself is gitignored).
