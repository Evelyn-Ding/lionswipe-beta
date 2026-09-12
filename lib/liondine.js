// Shared liondine.com fetch/parse logic — used directly by api/menus.js (as a
// live backstop) and by scripts/scrape-menus.js (the Supabase-cache path).
// CommonJS so both a plain `node script.js` (scrape-menus.js) and a Vercel
// serverless function loaded via dynamic import() (api/menus.js, which can
// `import` a CommonJS module's exports as its default export) can use it
// without an ESM/CJS build step.
//
// liondine.com was rebuilt (sometime between 2026-09-08 and 2026-09-12) as a
// client-rendered Next.js app — its old per-meal-period pages
// (liondine.com/breakfast etc.) now 404, and menu content isn't in the
// initial server-rendered HTML at all. Its homepage bundle calls
// `fetch("/api/dining")` client-side, which turned out to be a plain public
// JSON endpoint (found by downloading and grepping liondine's own JS chunks
// for "/api/" — no headless browser needed after all) returning ALL 4 meal
// periods for every dining hall in one response:
//   {
//     "alert": null,
//     "current_meal": "lunch",
//     "mode": "normal",
//     "dining_halls": {
//       "Ferris": {
//         "breakfast": {
//           "hours": { "open": "09:00", "close": "11:00", "display": "9:00 AM to 11:00 AM" },
//           "status": "closed",   // whether the hall is serving THIS INSTANT — not
//                                 // whether today's menu exists, so it's ignored
//                                 // below the same way the old HTML scraper ignored
//                                 // liondine's "closed" wording and just checked for
//                                 // real stations/items.
//           "stations": { "Main Line": { "Scrambled Eggs": { "allergens": [...], "prefs": [...] }, ... } }
//         },
//         "lunch": {...}, "dinner": {...}, "latenight": {...},
//         "crowdedness": { "percentage": 15, "status": "Busy" } | null,
//         "menu_snippet": "..." | null
//       },
//       ...
//     }
//   }
// This is liondine's own live data, not a re-derived guess, so consuming it
// directly gives menus that match liondine exactly (same hall names, same
// hours text, same items) rather than approximating them.

const MEAL_KEYS = { Breakfast: 'breakfast', Lunch: 'lunch', Dinner: 'dinner', 'Late Night': 'latenight' };

// Converts one hall's one-meal-period object (see shape above) into this
// app's { hours, stations } / { hours, message } shape — same two shapes
// index.html's renderHalls() already expects from the old HTML scraper.
function extractHallMeal(mealData) {
  const hours = (mealData && mealData.hours && mealData.hours.display) || '';
  const stationsObj = (mealData && mealData.stations) || {};
  const stations = Object.entries(stationsObj)
    .map(([name, items]) => ({ name, items: Object.keys(items || {}) }))
    .filter(s => s.items.length > 0);

  if (stations.length > 0) return { hours, stations };
  return { hours, message: hours || 'No data available' };
}

// dining_halls -> { Breakfast: {hall: {...}}, Lunch: {...}, Dinner: {...}, "Late Night": {...} },
// i.e. this app's per-meal-period shape, grouped the other way from how the
// API groups it (per-hall).
function reshapeDiningHalls(diningHalls) {
  const menus = { Breakfast: {}, Lunch: {}, Dinner: {}, 'Late Night': {} };
  Object.entries(diningHalls || {}).forEach(([hallName, hallData]) => {
    Object.entries(MEAL_KEYS).forEach(([ourMeal, apiMeal]) => {
      menus[ourMeal][hallName] = extractHallMeal(hallData[apiMeal]);
    });
  });
  return menus;
}

// Fetches https://liondine.com/api/dining and returns
// { menus, currentMeal, loaded } — menus in this app's shape (see above),
// currentMeal is liondine's own live "what meal is it right now" (so the UI
// can match liondine's default tab exactly instead of guessing from a local
// clock), loaded is false only on a genuine network/parse failure (caller
// decides the fallback, same contract the old per-page version had).
async function fetchLiondineMenus() {
  try {
    const resp = await fetch('https://liondine.com/api/dining', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LionSwipe menu sync; +https://lionswipe.vercel.app/)' }
    });
    if (!resp.ok) return { menus: null, currentMeal: null, loaded: false };
    const data = await resp.json();
    if (!data || !data.dining_halls) return { menus: null, currentMeal: null, loaded: false };
    return { menus: reshapeDiningHalls(data.dining_halls), currentMeal: data.current_meal || null, loaded: true };
  } catch (e) {
    return { menus: null, currentMeal: null, loaded: false };
  }
}

module.exports = { MEAL_KEYS, extractHallMeal, reshapeDiningHalls, fetchLiondineMenus };
