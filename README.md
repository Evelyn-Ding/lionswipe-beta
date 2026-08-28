# LionSwipe
Story: https://lionswipe.lovable.app/

Demo: https://lionswipe.vercel.app/

Video: https://youtu.be/IzkPfH7cWFA


Columbia dining menus, an off-campus food search backed by Claude, and meal-swipe /
spending tracking. Frontend is a single `index.html` (no build step); `api/` holds
Vercel serverless functions; Supabase handles auth + data.

## Local setup

```
npm install
```

Copy your real Supabase project values into `config.js` (already gitignored):
`SUPABASE_URL` and `SUPABASE_ANON_KEY` from Supabase → Project Settings → API.
Run `schema.sql` once in the Supabase SQL editor to create the tables.

## Running the app locally

The frontend calls `/api/search` and `/api/menus`, so a plain static server (e.g.
`npx serve .`) won't fully work — those routes will 404. Use the Vercel CLI instead,
which runs the `api/*.js` functions locally exactly as they'd run in production:

```
npm i -g vercel      # once
vercel dev
```

First run will ask to link a Vercel project (or you can skip linking and it still
serves locally). Set `ANTHROPIC_API_KEY` (for `/api/search`) either by linking to a
Vercel project that already has it set, or by creating a local `.env` file:

```
ANTHROPIC_API_KEY=sk-ant-...
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...   # only needed for the scraper, see below — never in config.js
```

Then open the URL `vercel dev` prints (usually `http://localhost:3000`).

## Testing the menu scraper

`dining.columbia.edu` sits behind a Cloudflare bot-challenge that blocks plain HTTP
requests, so menus can't be fetched with a simple `fetch()`. `scripts/scrape-menus.js`
uses Playwright with stealth patches (masking the automation fingerprints Cloudflare's
Managed Challenge checks for) to get past it, then reads the site's own embedded data:
every dining.columbia.edu content page ships the day's full menu — every location,
every meal period, every station and item — as inline JS variables
(`dining_terms`/`dining_nodes`/`menu_data`) in a `<script>` tag. No CSS selectors or
clicking through the UI needed; see the comment at the top of that file for details.

```
npx playwright install chromium
npm run scrape:menus:headed
```

This opens a visible Chrome window, navigates to a dining hall page, and prints the
extracted menus to the terminal. Watch the window — it should load the real page, not
hang on "Just a moment...". `scripts/scrape-output/page.html`/`page.png` are saved
either way for debugging. If it's stuck on the challenge, Cloudflare has likely
changed its detection since this was written; the stealth patches in `main()` are the
place to revisit.

Outside of the fall/spring semester (breaks, summer), dining halls publish nothing,
so a successful run will correctly print all-empty meal periods — that's expected,
not a bug. Re-test once dining halls are back in session (check `SEMESTER_START` in
`config.js`) to confirm real content comes through.

**Production schedule:** `.github/workflows/scrape-menus.yml` runs the scraper twice
a day via GitHub Actions once this repo is pushed to GitHub, using `SUPABASE_URL` /
`SUPABASE_SERVICE_ROLE_KEY` repo secrets (Settings → Secrets and variables →
Actions). The service role key bypasses Row Level Security to write — never put it
in `config.js` or anything shipped to the browser.

## Deploying

Vercel build command should run `node scripts/generate-config.js` first (it writes
`config.js` from the `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SEMESTER_*` env vars set
in Vercel's Project Settings, since `config.js` itself is gitignored).
