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

## Menus: how they're fetched

`api/menus.js` gets today's menus from [liondine.com](https://liondine.com)'s
own `/api/dining` endpoint — a plain public JSON API their site's client-side
app calls, returning every meal period for every dining hall (Columbia +
Barnard, liondine already aggregates both) in one response: hours, stations,
items, even which meal is "current" right now. See `lib/liondine.js`'s header
comment for the full shape and how this was found (liondine was rebuilt as a
client-rendered app between 2026-09-08 and 2026-09-12, breaking the plain-HTML
scraping this used to do — the fix was downloading their JS bundles and
grepping for `/api/`, not a headless browser). Consuming their own live data
directly, rather than re-parsing their rendered page, means this app's menus
match liondine's exactly — same hall names, same hours text, same items.

`api/menus.js` reaches this through three fallback tiers, in order:

1. **Supabase cache** — today's row in the `daily_menus` table, kept fresh by
   `scripts/scrape-menus.js` running every 30 min via GitHub Actions
   (`.github/workflows/scrape-menus.yml`). The common case: cheap, fast, no
   per-request liondine traffic.
2. **Live liondine fetch** — if today's Supabase row is missing (scraper
   hasn't run yet, or Supabase is unreachable/unconfigured), fetch
   `liondine.com/api/dining` directly instead (`lib/liondine.js`,
   `fetchLiondineMenus()`). This is the rare backstop path, not the normal one.
3. **Empty, not fake** — if even that fails, the API returns an empty menus
   object rather than made-up data. `index.html`'s `renderHalls()` already
   shows a clean "No data available" card per hall when there's no entry for
   it, so this is an honest state, not an error to hide. (This app used to
   fall back to hardcoded sample data that looked plausible enough to be
   mistaken for a real menu when the scrape/cache went stale in production on
   2026-09-08 — that was worse than admitting the gap, so it was removed.)

GitHub Actions scheduled runs are best-effort — they can land late (gaps of
several hours have been observed) or occasionally get skipped, even on a
30-min schedule. Trigger a run manually anytime from the Actions tab
(`workflow_dispatch`) or with `gh workflow run scrape-menus.yml` if today's
menus look stale; the live-fetch fallback above also means a slow cron
degrades gracefully instead of showing wrong data.

To manually test against liondine's current API response:

```
npm run scrape:menus
```

This prints the extracted menus to the terminal and writes to Supabase if
`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` are set (repo secrets in Settings →
Secrets and variables → Actions for the GitHub Actions run — the service role
key bypasses Row Level Security to write, so never put it in `config.js` or
anything shipped to the browser). `scripts/scrape-output/dining.json` (the raw
response) is saved either way for debugging — if a run comes back all-empty
unexpectedly, check that first for whether liondine's response shape changed
again (`api/menus.js`'s live-fetch fallback would break the same way, since it
shares this same fetch/parse code).

Outside of the fall/spring semester (breaks, summer), dining halls publish nothing
(liondine's own API reports `"mode": "summer"` and empty halls), so a successful
run will correctly show all-empty meal periods — that's expected, not a bug.
Re-test once dining halls are back in session (check `SEMESTER_START` in
`config.js`) to confirm real content comes through.

## Auth email deliverability (Supabase "Confirm signup" template)

By default, Supabase's signup-confirmation email links straight to
`https://<project-ref>.supabase.co/auth/v1/verify?...`. Sent from a custom SMTP
domain (this project uses Resend + `lionswipe.com`), that's a sender-domain vs.
link-domain mismatch — a pattern Google Workspace's Advanced Phishing
Protection silently quarantines, even with SPF/DKIM/DMARC all passing and
Resend reporting "Delivered" (confirmed 2026-09-04 against `@columbia.edu`
addresses). Pointing the link at our own domain instead (verifying the
`token_hash` client-side) was tried first, but Google kept quarantining the
email anyway — the emails still showed "Delivered" in Resend/Supabase's logs
but never reached an inbox, not even spam (confirmed 2026-09-05). A magic link
of any kind is apparently enough to trip the heuristic for this recipient
domain, so the template now sends a plain 6-digit code instead, with no link
at all. The user types the code into the login modal in `index.html`, which
calls `supabase.auth.verifyOtp({ email, token, type:'signup' })` (search for
`verifyOtp`). **This is a per-Supabase-project dashboard setting, not
version-controlled** — redo it any time the project switches Supabase backends:

Supabase dashboard → Authentication → Email Templates → **Confirm signup** →
replace the template body with something like:

```
<h2>Confirm your email address</h2>
<p>Enter this code in LionSwipe to finish signing up:</p>
<h1>{{ .Token }}</h1>
```

Remove any `<a href="...">` link from the template — the whole point is that
there's nothing to click.

(If a password-reset flow gets added later, its template needs the same
treatment with `{{ .Token }}` and `type:'recovery'` in the `verifyOtp` call.)

## Deploying

Vercel build command should run `node scripts/generate-config.js` first (it writes
`config.js` from the `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SEMESTER_*` env vars set
in Vercel's Project Settings, since `config.js` itself is gitignored).
