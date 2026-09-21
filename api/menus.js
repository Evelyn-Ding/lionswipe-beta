// Vercel serverless function: GET -> today's menus per meal period per dining hall.
//
// Three-tier fallback, in order:
//   1. Fetch liondine.com live — one fast JSON call (lib/liondine.js), not
//      the old 4-page HTML scrape, so hitting it on every request is cheap
//      enough to be the primary path rather than something to avoid. Where
//      liondine truly has no menu for a Columbia hall+meal, that one cell is
//      then checked against the hall's own dining.columbia.edu page
//      (lib/dining-secondary.js) before falling back to "No data available."
//   2. If that fails (liondine itself down/unreachable), fall back to
//      today's row in the Supabase `daily_menus` table, kept fresh by
//      scripts/scrape-menus.js running on a schedule (see
//      .github/workflows/scrape-menus.yml).
//   3. If even that fails, return an empty menus object rather than made-up
//      placeholder data — index.html's renderHalls() already shows a clean
//      "No data available." card per hall when there's no entry for it, so an
//      empty {} per meal period is a real, honest state, not an error.
//
// Supabase was tried as the PRIMARY source first (see git history) but that
// requires the scraper's SUPABASE_URL (a GitHub Actions secret) and this
// function's SUPABASE_URL (a Vercel env var) to actually point at the same
// project — they drifted apart at least twice (2026-09-08, 2026-09-14),
// each time silently serving stale/wrong data from an abandoned project
// while the scraper kept reporting successful writes elsewhere. Since the
// live fetch is fast and reliable on its own, Supabase is now just a
// fallback for a genuine liondine outage, not something either path's
// correctness depends on day to day.

import liondine from '../lib/liondine.js';
const { fetchLiondineMenus } = liondine;
import diningSecondary from '../lib/dining-secondary.js';
const { fillGapsFromSecondarySources } = diningSecondary;

const EMPTY_MENUS = { Breakfast: {}, Lunch: {}, Dinner: {}, 'Late Night': {} };

async function getFromSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;

  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
    const resp = await fetch(
      `${url}/rest/v1/daily_menus?date=eq.${today}&select=menus`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }
    );
    if (!resp.ok) return null;
    const rows = await resp.json();
    return (rows && rows[0] && rows[0].menus) || null;
  } catch (err) {
    console.error('daily_menus lookup failed:', err.message);
    return null;
  }
}

async function getMenus() {
  try {
    const { menus, currentMeal, loaded } = await fetchLiondineMenus();
    if (loaded) {
      // _currentMeal is liondine's own live "what meal is it right now",
      // included alongside (never replacing) the 4 real meal-period keys so
      // index.html can default to the same tab liondine itself would show,
      // rather than guessing from a local clock. Only available on this live
      // path — the Supabase fallback below doesn't carry a "right now" concept.
      if (currentMeal) menus._currentMeal = currentMeal;
      // Where liondine truly has no menu (flagged `ambiguous`), try the
      // hall's own dining.columbia.edu page before showing "No data
      // available." -- Columbia halls only; see lib/dining-secondary.js.
      try {
        const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
        await fillGapsFromSecondarySources(menus, today, { skipBarnard: true });
      } catch (err) {
        console.error('Columbia fallback failed:', err.message);
      }
      return menus;
    }
  } catch (err) {
    console.error('liondine live fetch failed:', err.message);
  }

  const cached = await getFromSupabase();
  if (cached) return cached;

  return EMPTY_MENUS;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const menus = await getMenus();
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.status(200).json(menus);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
