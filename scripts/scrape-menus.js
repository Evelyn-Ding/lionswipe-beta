// Scrapes today's dining hall menus from liondine.com and upserts the result into
// the Supabase `daily_menus` table, which api/menus.js reads as its primary
// source (falling back to fetching liondine directly if today's row is
// missing, then to an honest "no data available" if even that fails — see
// api/menus.js).
//
// WHY LIONDINE INSTEAD OF SCRAPING COLUMBIA/BARNARD DIRECTLY: liondine.com
// already aggregates Columbia's dining.columbia.edu locations *and* Barnard's
// two dining locations (dineoncampus.com) into one place, in the same
// hall-naming this app displays.
//
// HOW EXTRACTION WORKS: liondine.com was rebuilt (sometime between
// 2026-09-08 and 2026-09-12) as a client-rendered Next.js app — see
// lib/liondine.js's header comment for how that broke the old per-meal-page
// HTML scraping this file used to do directly, and how `fetchLiondineMenus()`
// there now gets the same data (actually richer: every meal period for every
// hall in one response, straight from liondine's own `/api/dining` endpoint)
// without needing a browser.

const fs = require('fs');
const path = require('path');
const { fetchLiondineMenus } = require('../lib/liondine.js');

const OUT_DIR = path.join(__dirname, 'scrape-output');

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
  const { menus, currentMeal, loaded } = await fetchLiondineMenus();

  if (!loaded) {
    console.warn('Fetching https://liondine.com/api/dining failed.');
    process.exitCode = 1;
    return;
  }

  // Saved for debugging (e.g. if liondine's response shape changes again) —
  // replaces the old per-meal-period *.html snapshots from when this scraped
  // plain HTML pages instead of one JSON endpoint.
  fs.writeFileSync(path.join(OUT_DIR, 'dining.json'), JSON.stringify({ menus, currentMeal }, null, 2));

  console.log(`\nExtracted menus for ${today} (current_meal: ${currentMeal}):`, JSON.stringify(menus, null, 2));
  const anyContent = Object.values(menus).some(byHall => Object.keys(byHall).length > 0);
  if (!anyContent) {
    console.log('(All meal periods are empty — normal when dining halls are closed, e.g. over a break. Nothing written to Supabase.)');
    return;
  }
  await cleanupOldMenus(today);
  await upsertToSupabase(menus, today);
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

  // Scraping runs every 30 min (see .github/workflows/scrape-menus.yml), but
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
