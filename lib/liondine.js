// Shared liondine.com fetch/parse logic — used directly by api/menus.js (live,
// on every request) and by scripts/scrape-menus.js (the older Supabase-cache
// path, kept around but no longer what the deployed app reads from). CommonJS
// so both a plain `node script.js` (scrape-menus.js) and a Vercel serverless
// function loaded via dynamic import() (api/menus.js, which can `import` a
// CommonJS module's exports as its default export) can use it without an
// ESM/CJS build step.
//
// See scripts/scrape-menus.js's original header comment for why liondine
// (rather than dining.columbia.edu/dineoncampus.com directly) and for the
// exact markup shape this parses.

const MEAL_PATHS = { Breakfast: 'breakfast', Lunch: 'lunch', Dinner: 'dinner', 'Late Night': 'latenight' };

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

// One meal page -> { hallName -> {hours, stations} } for halls with a real menu,
// or { hallName -> {hours, message} } for halls without one.
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
      return;
    }

    const noMenuMatch = block.match(/<div class="menu no-menu">([\s\S]*?)<\/div>/);
    const message = noMenuMatch ? decodeEntities(noMenuMatch[1]) : hours;
    menu[hallName] = { hours, message };
  });

  return menu;
}

// Fetches and parses all 4 meal periods in parallel. Returns { menus, anyPageLoaded } —
// menus is always the { Breakfast, Lunch, Dinner, "Late Night" } shape (empty {}
// per meal period that failed to load), so callers can decide their own
// fallback behavior (e.g. api/menus.js falls back to SAMPLE_MENUS wholesale
// when nothing loaded, rather than mixing live and sample data per meal).
async function fetchLiondineMenus() {
  const menus = { Breakfast: {}, Lunch: {}, Dinner: {}, 'Late Night': {} };
  let anyPageLoaded = false;

  await Promise.all(Object.entries(MEAL_PATHS).map(async ([meal, mealPath]) => {
    const url = `https://liondine.com/${mealPath}`;
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LionSwipe menu sync; +https://lionswipe.vercel.app/)' }
      });
      if (!resp.ok) return;
      const html = await resp.text();
      menus[meal] = extractMealPage(html);
      anyPageLoaded = true;
    } catch (e) {
      // Leave this meal period empty — caller decides the fallback.
    }
  }));

  return { menus, anyPageLoaded };
}

module.exports = { MEAL_PATHS, decodeEntities, extractMealPage, fetchLiondineMenus };
