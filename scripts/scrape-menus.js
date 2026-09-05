// Scrapes today's dining hall menus from liondine.com and upserts the result into
// the Supabase `daily_menus` table so api/menus.js can serve it without touching
// liondine itself on every page load.
//
// WHY LIONDINE INSTEAD OF SCRAPING COLUMBIA/BARNARD DIRECTLY: liondine.com already
// aggregates Columbia's dining.columbia.edu locations *and* Barnard's Hewitt/Diana
// (dineoncampus.com) into one site, in the exact 11-hall order/naming this app
// wants (confirmed 2026-09-04 by reading liondine.com's own markup). It's also
// plain server-rendered HTML with NO Cloudflare challenge (confirmed: a bare curl
// gets real menu HTML back, unlike dining.columbia.edu) — so this no longer needs
// Playwright/a real browser at all, just a plain fetch().
//
// HOW EXTRACTION WORKS: liondine has one page per meal period —
// https://liondine.com/breakfast, /lunch, /dinner, /latenight — each server-
// rendered for "today" (America/New_York, matching this app's own day boundary).
// Each page has exactly one `<div class="col">...</div>` block per dining hall,
// always in the same order, e.g.:
//   <div class="col">
//     <a href="..."><h3>Ferris</h3></a>
//     <div class="timing"><div class="hours">10:00 AM to 4:00 PM</div></div>
//     <div class="menu">
//       <div class="food-type">Main Line</div>
//       <div class="food-name">Chocolate Croissants</div>
//       ...
//     </div>
//   </div>
// A closed/no-menu hall has the same shape with an empty `<div class="menu">`
// (or a `no-menu` variant with placeholder text) — those are skipped so the
// front end's existing "no data available" fallback applies uniformly, rather
// than trying to reproduce liondine's own wording ("Closed this week" etc.).
// Splitting the page on the literal `<div class="col">` string (rather than a
// full HTML parser) is enough since these blocks never nest.

const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, 'scrape-output');

const MEAL_PATHS = { Breakfast: 'breakfast', Lunch: 'lunch', Dinner: 'dinner', 'Late Night': 'latenight' };

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
  const menus = { Breakfast: {}, Lunch: {}, Dinner: {}, 'Late Night': {} };
  let anyPageLoaded = false;

  for (const [meal, mealPath] of Object.entries(MEAL_PATHS)) {
    const url = `https://liondine.com/${mealPath}`;
    console.log(`Fetching ${url}...`);
    let html;
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LionSwipe menu sync; +https://lionswipe.vercel.app/)' }
      });
      if (!resp.ok) {
        console.warn(`Fetching ${url} failed: HTTP ${resp.status}`);
        continue;
      }
      html = await resp.text();
    } catch (e) {
      console.warn(`Fetching ${url} failed:`, e.message);
      continue;
    }
    fs.writeFileSync(path.join(OUT_DIR, `${mealPath}.html`), html);
    anyPageLoaded = true;
    menus[meal] = extractMealPage(html);
  }

  if (!anyPageLoaded) {
    process.exitCode = 1;
    return;
  }

  console.log(`\nExtracted menus for ${today}:`, JSON.stringify(menus, null, 2));
  const anyContent = Object.values(menus).some(byHall => Object.keys(byHall).length > 0);
  if (!anyContent) {
    console.log('(All meal periods are empty — normal when dining halls are closed, e.g. over a break. Nothing written to Supabase.)');
    return;
  }
  await cleanupOldMenus(today);
  await upsertToSupabase(menus, today);
}

function decodeEntities(str) {
  if (!str) return str;
  return String(str)
    .replace(/&#0?39;/g, "'")
    .replace(/&#0?34;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]*>/g, '') // strip any stray HTML tags
    .trim();
}

// One meal page -> { hallName -> {hours, stations} }, in liondine's own hall order
// (each hall's own short name, e.g. "Ferris", "JJ's" — used as-is as the data key).
function extractMealPage(html) {
  const menu = {};
  const blocks = html.split('<div class="col">').slice(1);

  blocks.forEach(block => {
    const nameMatch = block.match(/<h3>([\s\S]*?)<\/h3>/);
    const hoursMatch = block.match(/<div class="hours">([\s\S]*?)<\/div>/);
    if (!nameMatch) return;
    const hallName = decodeEntities(nameMatch[1]);
    const hours = hoursMatch ? decodeEntities(hoursMatch[1]) : '';

    const stations = [];
    const itemRe = /<div class="food-(type|name)">([\s\S]*?)<\/div>/g;
    let m;
    while ((m = itemRe.exec(block))) {
      const [, kind, text] = m;
      const decoded = decodeEntities(text);
      if (!decoded) continue;
      if (kind === 'type') {
        stations.push({ name: decoded, items: [] });
      } else if (stations.length) {
        stations[stations.length - 1].items.push(decoded);
      }
    }

    const nonEmptyStations = stations.filter(s => s.items.length > 0);
    if (nonEmptyStations.length > 0) {
      menu[hallName] = { hours, stations: nonEmptyStations };
    }
  });

  return menu;
}

// Recursively sorts object keys (leaving array order — meal/station/item order —
// untouched, since that's real content) so two menus objects with identical
// content always stringify identically regardless of key insertion order.
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

  // Scraping runs every 2 hours (see .github/workflows/scrape-menus.yml), but
  // liondine doesn't necessarily change its published menu between runs — skip
  // the write (and the scraped_at bump) when today's row already holds identical
  // content, so daily_menus only changes when the actual menu does.
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
