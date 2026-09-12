// Vercel serverless function: GET -> today's menus per meal period per dining hall.
//
// Three-tier fallback, in order:
//   1. Today's row in the Supabase `daily_menus` table, kept fresh by
//      scripts/scrape-menus.js running on a schedule (see
//      .github/workflows/scrape-menus.yml) — the common case, cheap and fast.
//   2. If that row is missing (scraper hasn't run yet today, or Supabase is
//      unreachable/unconfigured), fetch liondine.com live as a backstop —
//      same fetch/parse logic the scraper uses, from lib/liondine.js. This is
//      the rare path, only hit when the cache is stale, so it doesn't turn
//      into hitting liondine on every single page load.
//   3. If even that fails, return an empty menus object rather than made-up
//      placeholder data — index.html's renderHalls() already shows a clean
//      "No data available" card per hall when there's no entry for it, so an
//      empty {} per meal period is a real, honest state, not an error. This
//      app previously fell back to hardcoded curated sample data that looked
//      plausible enough to be mistaken for a real menu — that silently showed
//      wrong information instead of admitting menus weren't available, which
//      is worse than an honest gap.

import liondine from '../lib/liondine.js';
const { fetchLiondineMenus } = liondine;

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
  const cached = await getFromSupabase();
  if (cached) return cached;

  try {
    const { menus, anyPageLoaded } = await fetchLiondineMenus();
    if (anyPageLoaded) return menus;
  } catch (err) {
    console.error('liondine live-fetch backstop failed:', err.message);
  }

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
