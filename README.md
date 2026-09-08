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

`api/menus.js` fetches today's menus from [liondine.com](https://liondine.com)
**live, on every request** — a site that already aggregates every Columbia
dining hall (`dining.columbia.edu`) and Barnard's two dining locations
(`dineoncampus.com`) into one place, in a fixed 11-hall order, and is plain
server-rendered HTML with no Cloudflare challenge — so this is just a `fetch()`
against `liondine.com/breakfast`, `/lunch`, `/dinner`, and `/latenight`, no
browser needed. The fetch/parse logic lives in `lib/liondine.js` (see its
comment for the exact markup parsed: `<div class="col">` per hall,
`<div class="food-type">`/`<div class="food-name">` per item); the response is
cached at Vercel's edge for 60s (`s-maxage=60`) so a burst of simultaneous page
loads shares one liondine fetch rather than each hitting it individually.

This used to go through a separate scraper (`scripts/scrape-menus.js`) writing
into a Supabase `daily_menus` table on a cron, with `api/menus.js` reading from
that table instead of liondine directly. That extra caching layer's scrape
cadence/target could drift out of sync with what the deployed app actually
read (this happened in production on 2026-09-08 — the scraper kept reporting
success while the live site silently fell back to stale sample data for
hours), so it was removed in favor of the direct fetch above. `scripts/
scrape-menus.js` and its GitHub Actions workflow (`.github/workflows/
scrape-menus.yml`) still exist and still work, but nothing in the deployed app
reads their output anymore — they're only useful again if a caching layer in
front of liondine is wanted back (e.g. for higher traffic).

To manually test the extraction logic against liondine's current markup:

```
npm run scrape:menus
```

This prints the extracted menus to the terminal (without writing to Supabase
unless `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` are set — see below).
`scripts/scrape-output/*.html` (one per meal period) are saved either way for
debugging — if a run comes back all-empty unexpectedly, check those first for
whether liondine's markup changed (`api/menus.js` would break the same way,
since it shares this same parsing code).

Outside of the fall/spring semester (breaks, summer), dining halls publish nothing,
so a successful run will correctly show all-empty meal periods — that's expected,
not a bug. Re-test once dining halls are back in session (check `SEMESTER_START` in
`config.js`) to confirm real content comes through.

If you do want the scraper's cron path running again, it uses `SUPABASE_URL`/
`SUPABASE_SERVICE_ROLE_KEY` repo secrets (Settings → Secrets and variables →
Actions) — the service role key bypasses Row Level Security to write, so never
put it in `config.js` or anything shipped to the browser — and you'd need to
switch `api/menus.js` back to reading from `daily_menus` instead of calling
`fetchLiondineMenus()` directly.

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
