// Scrapes today's dining hall menus from dining.columbia.edu using a real (headless
// or headed) browser, then upserts the result into the Supabase `daily_menus` table
// so api/menus.js can serve it without ever touching the site itself.
//
// WHY A BROWSER: dining.columbia.edu sits behind a Cloudflare bot-challenge that
// blocks plain HTTP requests (confirmed: `curl` with a normal browser User-Agent
// still gets a "Just a moment..." 403 page). Playwright + the stealth patches below
// (masking navigator.webdriver, missing chrome.runtime, etc. — the fingerprints
// Cloudflare's Managed Challenge checks for) reliably get past it as of this
// writing. No guarantee that holds forever — Cloudflare updates its bot detection
// periodically. If npm run scrape:menus:headed starts showing "Verifying..." stuck
// forever again (check scripts/scrape-output/page.png), that mitigation has stopped
// working and needs revisiting.
//
// HOW EXTRACTION WORKS: rather than parsing rendered DOM/CSS (which the new site's
// per-hall pages don't fully populate without clicking a Locations/Days widget),
// every dining.columbia.edu content page embeds the *entire* site's dining data as
// inline JS variables in a <script> tag:
//   var dining_terms = `{...}`;  // meal-period id -> name, station id -> name
//   var dining_nodes = `{...}`;  // every dining location: id, title, hours, path
//   var menu_data    = `[...]`;  // every published menu: which location, which
//                                // date/meal-period, which stations, which items
// Each variable is a backtick JS template literal containing double-escaped JSON
// (it went through JSON encoding once, then got embedded as a JS string another
// time). We reverse that by evaluating the literal with Function() — the same
// unescaping the browser itself would do — then JSON.parse the result. Verified
// against both a live (empty, summer) capture and a 2024 archived snapshot with
// real menu content (see git history / conversation for how this was found).
// Because menu_data covers every location, ONE page load is enough — no need to
// visit each dining hall separately.

const fs = require('fs');
const path = require('path');

// Any dining.columbia.edu content page works — this one's stable and simple.
const TARGET_URL = process.env.MENU_URL || 'https://dining.columbia.edu/content/john-jay-dining-hall';
const HEADLESS = process.env.HEADLESS !== 'false';
const OUT_DIR = path.join(__dirname, 'scrape-output');

// Only these map onto the app's meal-period tabs (index.html). Real menu_type
// values also include "Brunch", "Daily", and "Lunch & Dinner" combo entries that
// don't cleanly fit one tab — skipped for now.
const KNOWN_MEALS = ['Breakfast', 'Lunch', 'Dinner', 'Late Night'];

async function main() {
  const { chromium } = require('playwright');
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: HEADLESS,
    channel: 'chrome',
    args: ['--disable-blink-features=AutomationControlled']
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'en-US'
  });

  // Stealth patches: mask the Playwright/CDP fingerprints Cloudflare's Managed
  // Challenge checks for (navigator.webdriver, missing chrome.runtime, empty
  // plugin list, permission-query quirks).
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = window.chrome || { runtime: {} };
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) =>
      parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(parameters);
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5].map(() => ({ name: 'Chrome PDF Plugin' }))
    });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  });

  // Everything below can throw mid-navigation (e.g. page.content() while the page
  // is still loading) — wrap in try/finally so browser.close() always runs. Without
  // this, an uncaught error here leaves the Chromium subprocess running, which
  // keeps Node's event loop alive and hangs the process until CI's job timeout
  // force-kills it hours later (confirmed via a run that hung 6h on 2026-08-30).
  let html;
  try {
    const page = await context.newPage();

    console.log(`Navigating to ${TARGET_URL} (headless=${HEADLESS})...`);
    // 'domcontentloaded' rather than 'networkidle': the dining_terms/dining_nodes/
    // menu_data we need are server-rendered inline in the initial HTML, so we don't
    // need to wait for this page's ~6 third-party domains (Google Analytics/Maps,
    // Typekit, Cloudflare's challenge script, etc.) to go fully quiet — 'networkidle'
    // was timing out intermittently on CI whenever any one of them was slow, which
    // left the page mid-navigation and crashed the later page.content() call.
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {
      console.warn('Navigation warning (continuing anyway):', e.message);
    });
    await page.waitForTimeout(6000); // Cloudflare's passive challenge clears (or doesn't) within a few seconds

    html = await page.content();
    await page.screenshot({ path: path.join(OUT_DIR, 'page.png'), fullPage: true });
    fs.writeFileSync(path.join(OUT_DIR, 'page.html'), html);
  } finally {
    await browser.close();
  }
  const stillChallenged = /Just a moment|Checking your browser|cf-browser-verification/i.test(html);

  if (stillChallenged) {
    console.log('\n❌ Still a Cloudflare challenge page — the stealth mitigation has stopped working. Check scripts/scrape-output/page.png.');
    process.exitCode = 1;
    return;
  }

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
  await cleanupOldMenus(today);
  const menus = extractMenus(html, today);
  if (!menus) {
    console.log('\n⚠️  Page loaded, but dining_terms/dining_nodes/menu_data weren\'t found in it — the site\'s markup may have changed. Check scripts/scrape-output/page.html for `var menu_data`.');
    process.exitCode = 1;
    return;
  }

  console.log(`\nExtracted menus for ${today}:`, JSON.stringify(menus, null, 2));
  const anyContent = Object.values(menus).some(byHall => Object.keys(byHall).length > 0);
  if (!anyContent) {
    console.log('(All meal periods are empty — normal when dining halls are closed, e.g. over the summer or a break. Nothing written to Supabase.)');
    return;
  }
  await upsertToSupabase(menus, today);
}

function extractInlineVar(html, name) {
  const re = new RegExp('var ' + name + ' = `([\\s\\S]*?)`;');
  const m = html.match(re);
  if (!m) return null;
  // The captured text is JSON that's been escaped a second time to survive being
  // embedded in a JS template literal. Evaluating it as one (letting the JS engine
  // itself reverse that escaping) is the only reliable way to undo it — manual
  // regex replacement breaks on double-escaped sequences like \\u00e9.
  const jsonText = new Function('return `' + m[1] + '`')();
  try {
    return JSON.parse(jsonText);
  } catch (e) {
    console.warn(`Failed to parse ${name}:`, e.message);
    return null;
  }
}

function decodeEntities(str) {
  if (!str) return str;
  return String(str)
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]*>/g, '') // strip any stray HTML tags in titles
    .trim();
}

// Columbia's timestamps here are naive local (Eastern) strings, e.g.
// "2026-09-04T11:30:00" for an 11:30am lunch start — no timezone math needed,
// just read the digits.
function fmtTime(iso) {
  const t = iso && iso.split('T')[1];
  if (!t) return '';
  let [h, m] = t.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')} ${ampm}`;
}

function extractMenus(html, targetDate) {
  const terms = extractInlineVar(html, 'dining_terms');
  const nodes = extractInlineVar(html, 'dining_nodes');
  const menuData = extractInlineVar(html, 'menu_data');
  if (!terms || !nodes || !menuData) return null;

  const locationsById = {};
  (nodes.locations || []).forEach(loc => { locationsById[loc.nid] = decodeEntities(loc.title); });

  const menus = { Breakfast: {}, Lunch: {}, Dinner: {}, 'Late Night': {} };

  menuData.forEach(node => {
    const hallName = (node.locations || []).map(id => locationsById[id]).filter(Boolean)[0];
    if (!hallName) return;
    (node.date_range_fields || []).forEach(period => {
      const dateStr = (period.date_from || '').slice(0, 10);
      if (dateStr !== targetDate) return;
      const typeId = (period.menu_type || [])[0];
      const mealName = terms.types[typeId] && decodeEntities(terms.types[typeId].name);
      if (!KNOWN_MEALS.includes(mealName)) return;

      const stations = (period.stations || []).map(st => ({
        name: decodeEntities((terms.stations[(st.station || [])[0]] || {}).name || 'Menu'),
        items: (st.meals_paragraph || []).map(mp => decodeEntities(mp.title)).filter(Boolean)
      })).filter(st => st.items.length > 0);

      if (stations.length > 0) {
        menus[mealName][hallName] = {
          hours: `${fmtTime(period.date_from)} – ${fmtTime(period.date_to)}`,
          stations
        };
      }
    });
  });

  return menus;
}

// Recursively sorts object keys (leaving array order — meal/station/item order —
// untouched, since that's real content) so two menus objects with identical
// content always stringify identically regardless of what order Columbia's own
// data happened to list locations/stations in on a given run.
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',')}}`;
  }
  return JSON.stringify(value);
}

const MENU_RETENTION_DAYS = 7;

// daily_menus has no built-in expiry (Supabase/Postgres doesn't auto-delete
// rows), so prune anything older than a week on every run — cheap enough to
// just do unconditionally rather than tracking whether it's "time yet".
async function cleanupOldMenus(todayStr) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return; // upsertToSupabase already logs the missing-config case

  const cutoff = new Date(todayStr);
  cutoff.setUTCDate(cutoff.getUTCDate() - MENU_RETENTION_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(url, key);
  const { error, count } = await supabase
    .from('daily_menus')
    .delete({ count: 'exact' })
    .lt('date', cutoffStr);
  if (error) {
    console.warn('Failed to delete old daily_menus rows:', error.message);
  } else if (count) {
    console.log(`Deleted ${count} daily_menus row(s) older than ${cutoffStr} (${MENU_RETENTION_DAYS}-day retention).`);
  }
}

async function upsertToSupabase(menus, dateStr) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.log('\n(SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — skipping write, printed JSON above instead.)');
    return;
  }
  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(url, key);

  // Scraping runs 3x/day (see .github/workflows/scrape-menus.yml), but Columbia
  // doesn't necessarily change the published menu between runs — skip the write
  // (and the scraped_at bump) when today's row already holds identical content,
  // so daily_menus only changes when the actual menu does.
  const { data: existing, error: fetchError } = await supabase
    .from('daily_menus')
    .select('menus')
    .eq('date', dateStr)
    .maybeSingle();
  if (fetchError) {
    console.warn('daily_menus lookup failed, writing anyway:', fetchError.message);
  } else if (existing && stableStringify(existing.menus) === stableStringify(menus)) {
    console.log(`No change in menus for ${dateStr} — skipping write.`);
    return;
  }

  const { error } = await supabase.from('daily_menus').upsert({
    date: dateStr,
    menus,
    scraped_at: new Date().toISOString()
  });
  if (error) {
    console.error('Supabase write failed:', error.message);
    process.exitCode = 1;
  } else {
    console.log(`Wrote menus for ${dateStr} to Supabase daily_menus.`);
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
