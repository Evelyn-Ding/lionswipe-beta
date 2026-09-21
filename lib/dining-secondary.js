// Secondary-source lookups for hall+meals lib/liondine.js flagged `ambiguous`
// (real hours or unknown status, but liondine has no menu) — used only by
// scripts/scrape-menus.js, never by api/menus.js's request-time live path,
// since these are too slow/heavy (a browser launch, in Barnard's case) for a
// single HTTP request.
//
// - The 9 Columbia halls -> dining.columbia.edu. Plain fetch() (confirmed
//   2026-09-14 this loads fine with no Cloudflare challenge, contradicting an
//   earlier assumption that blocked bare requests). Each hall page embeds its
//   own page-state as JS vars (`dining_nodes`, `dining_terms`, `menu_data`)
//   containing real hours + a station/item menu straight from Columbia's own
//   Drupal backend.
// - The 2 Barnard halls (Hewitt Dining, Diana) -> dineoncampus.com, via its
//   public apiv4.dineoncampus.com JSON API. Both the page and the API are
//   behind an Incapsula/Imperva-style WAF that hard-blocks plain fetch/curl
//   (403) regardless of headers, so this path uses Playwright: load the real
//   site once to pass the WAF, then call the JSON API from inside that
//   browser context. This is best-effort — if the WAF still blocks it, that's
//   treated the same as "checked, found nothing" rather than a fatal error.
//
// Any hall this module doesn't recognize (e.g. "Kosher" has no dedicated
// dining.columbia.edu page as of 2026-09-14) simply returns null, same as a
// real "found nothing" result.

const COLUMBIA_HALLS = [
  "Chef Don's", "Chef Mike's", 'Fac Shack', 'Faculty House', 'Ferris',
  'Grace Dodge', "JJ's", "Johnny's", 'John Jay', 'Kosher'
];
const BARNARD_HALLS = ['Hewitt Dining', 'Diana'];

// ---------------------------------------------------------------------------
// Columbia
// ---------------------------------------------------------------------------

// dining.columbia.edu embeds several JS vars as backtick template literals whose
// content is JSON.stringify'd then run through PHP's addslashes() (escaping ",
// ', and \ again) before being dropped into the template — e.g. a literal `'`
// in "Chef Don's" becomes `\'`, and json_encode's own `\/`/`\uXXXX` escapes get
// their backslash doubled. Reversing addslashes (undo exactly one backslash
// before ", ', or \) recovers plain JSON text that JSON.parse can read directly.
// Confirmed live 2026-09-14 against https://dining.columbia.edu/content/john-jay-dining-hall.
function decodeColumbiaVar(html, name) {
  const marker = `var ${name} = \``;
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const contentStart = start + marker.length;
  const end = html.indexOf('`;', contentStart);
  if (end === -1) return null;
  const raw = html.slice(contentStart, end).replace(/\\(["'\\])/g, '$1');
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.warn(`Failed to decode dining.columbia.edu var ${name}:`, e.message);
    return null;
  }
}

function decodeHtmlEntities(str) {
  if (!str) return str;
  return String(str)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function normalizeHallName(s) {
  return decodeHtmlEntities(s).toLowerCase().replace(/['\u2019]/g, '').trim();
}

// hallName -> path (e.g. "/content/john-jay-dining-hall"), built once per
// process from dining.columbia.edu's own location directory (embedded in
// every page, including the homepage) rather than hardcoding guessed slugs.
// Halls with no dedicated page (e.g. "Chef Don's", "Kosher" as of 2026-09-14)
// are left unmapped and fall through to "nothing found" like any other
// unreachable hall.
//
// Both this and getColumbiaPage below are also used by api/menus.js's live
// path, where one warm serverless instance outlives many requests -- so cache
// entries expire (COLUMBIA_CACHE_TTL_MS) instead of living for the whole
// process, and an empty/failed directory lookup is never cached.
const COLUMBIA_CACHE_TTL_MS = 5 * 60 * 1000;
const COLUMBIA_FETCH_TIMEOUT_MS = 5000;
let columbiaHallPathsPromise = null;
let columbiaHallPathsAt = 0;
function getColumbiaHallPaths() {
  if (!columbiaHallPathsPromise || Date.now() - columbiaHallPathsAt > COLUMBIA_CACHE_TTL_MS) {
    columbiaHallPathsAt = Date.now();
    const promise = columbiaHallPathsPromise = (async () => {
      const paths = {};
      try {
        const resp = await fetch('https://dining.columbia.edu/', { signal: AbortSignal.timeout(COLUMBIA_FETCH_TIMEOUT_MS) });
        if (!resp.ok) return paths;
        const html = await resp.text();
        const nodes = decodeColumbiaVar(html, 'dining_nodes');
        const locations = nodes && nodes.locations;
        if (!Array.isArray(locations)) return paths;
        for (const hallName of COLUMBIA_HALLS) {
          const needle = normalizeHallName(hallName);
          const match = locations.find(l => l.path && normalizeHallName(l.title || '').includes(needle));
          if (match) paths[hallName] = match.path;
        }
      } catch (e) {
        console.warn('Failed to load dining.columbia.edu location directory:', e.message);
      }
      return paths;
    })();
    promise.then(paths => { if (Object.keys(paths).length === 0 && columbiaHallPathsPromise === promise) columbiaHallPathsPromise = null; });
  }
  return columbiaHallPathsPromise;
}

// One hall's page -> { terms, menuData } (or null on failure), cached for the
// life of this process so the 4 meal periods share a single fetch per hall.
const columbiaPageCache = new Map(); // hallPath -> { promise, at }
function getColumbiaPage(hallPath) {
  const cached = columbiaPageCache.get(hallPath);
  if (cached && Date.now() - cached.at <= COLUMBIA_CACHE_TTL_MS) return cached.promise;
  const promise = (async () => {
    try {
      const url = `https://dining.columbia.edu${hallPath}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(COLUMBIA_FETCH_TIMEOUT_MS) });
      if (!resp.ok) return null;
      const html = await resp.text();
      const terms = decodeColumbiaVar(html, 'dining_terms');
      const menuData = decodeColumbiaVar(html, 'menu_data');
      if (!terms || !menuData) return null;
      return { terms, menuData };
    } catch (e) {
      console.warn(`Failed to fetch dining.columbia.edu page ${hallPath}:`, e.message);
      return null;
    }
  })();
  columbiaPageCache.set(hallPath, { promise, at: Date.now() });
  return promise;
}

async function fetchColumbiaMenu(hallName, meal, todayStr) {
  const paths = await getColumbiaHallPaths();
  const hallPath = paths[hallName];
  if (!hallPath) return null;

  const page = await getColumbiaPage(hallPath);
  if (!page) return null;

  const types = page.terms.types || {};
  const mealTid = Object.keys(types).find(tid => types[tid].name === meal);
  if (!mealTid) return null;

  const stationsMap = new Map(); // station name -> items[]
  for (const entry of page.menuData || []) {
    for (const dr of entry.date_range_fields || []) {
      const isToday = typeof dr.date_from === 'string' && dr.date_from.slice(0, 10) === todayStr;
      if (!isToday || !(dr.menu_type || []).includes(mealTid)) continue;
      for (const station of dr.stations || []) {
        const stationInfo = page.terms.stations && page.terms.stations[station.station];
        const stationName = decodeHtmlEntities((stationInfo && stationInfo.name) || 'Menu');
        const items = (station.meals_paragraph || []).map(item => decodeHtmlEntities(item.title)).filter(Boolean);
        if (!items.length) continue;
        if (!stationsMap.has(stationName)) stationsMap.set(stationName, []);
        stationsMap.get(stationName).push(...items);
      }
    }
  }

  if (stationsMap.size === 0) return null;
  return { stations: Array.from(stationsMap, ([name, items]) => ({ name, items })) };
}

// ---------------------------------------------------------------------------
// Barnard
// ---------------------------------------------------------------------------

const BARNARD_LOCATION_IDS = {
  'Hewitt Dining': '5d27a0461ca48e0aca2a104c',
  Diana: '5d8775484198d40d7a0b8078'
};

let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    const { chromium } = require('playwright');
    browserPromise = chromium.launch();
  }
  return browserPromise;
}

async function closeBrowserIfOpen() {
  if (!browserPromise) return;
  try {
    const browser = await browserPromise;
    await browser.close();
  } catch (e) {
    console.warn('Failed to close Playwright browser:', e.message);
  }
}

// One hall's { periods, page } (or null on failure), cached for the life of
// this process so the 4 meal periods share a single browser page + periods
// lookup.
const barnardHallCache = new Map();
function getBarnardHallSession(hallName, locationId, todayStr) {
  const cacheKey = `${hallName}:${todayStr}`;
  if (barnardHallCache.has(cacheKey)) return barnardHallCache.get(cacheKey);

  const promise = (async () => {
    let page;
    try {
      const browser = await getBrowser();
      page = await browser.newPage();
      await page.goto('https://dineoncampus.com/barnard', { waitUntil: 'domcontentloaded', timeout: 20000 });
      const periodsUrl = `https://apiv4.dineoncampus.com/locations/${locationId}/periods/?date=${todayStr}`;
      const periodsJson = await page.evaluate(u => fetch(u).then(r => (r.ok ? r.json() : null)), periodsUrl);
      const periods = (periodsJson && periodsJson.periods) || [];
      return { page, periods };
    } catch (e) {
      console.warn(`Barnard secondary-source session failed for ${hallName}:`, e.message);
      if (page) await page.close().catch(() => {});
      return null;
    }
  })();
  barnardHallCache.set(cacheKey, promise);
  return promise;
}

async function fetchBarnardMenu(hallName, meal, todayStr) {
  const locationId = BARNARD_LOCATION_IDS[hallName];
  if (!locationId) return null;

  const session = await getBarnardHallSession(hallName, locationId, todayStr);
  if (!session) return null;

  const period = session.periods.find(p => p.name === meal);
  if (!period) return null; // e.g. no "Late Night" period at this hall

  try {
    const menuUrl = `https://apiv4.dineoncampus.com/locations/${locationId}/menu?date=${todayStr}&period=${period.id}`;
    const menuJson = await session.page.evaluate(u => fetch(u).then(r => (r.ok ? r.json() : null)), menuUrl);
    const categories = (menuJson && menuJson.period && menuJson.period.categories) || [];
    const stations = categories
      .map(c => ({ name: c.name, items: (c.items || []).map(item => item.name).filter(Boolean) }))
      .filter(s => s.items.length > 0);
    return stations.length > 0 ? { stations } : null;
  } catch (e) {
    console.warn(`Barnard menu fetch failed for ${hallName} / ${meal}:`, e.message);
    return null;
  }
}

// ---------------------------------------------------------------------------

const NO_INFO_MESSAGE = 'No data available.';

// Mutates `menus` (lib/liondine.js's { Meal: { hallName: {...} } } shape, keyed
// by this app's own capitalized meal names — "Breakfast", "Lunch", "Dinner",
// "Late Night") in place: for every hall+meal flagged `ambiguous`, checks that
// hall's secondary source and either fills in a real menu or settles on
// NO_INFO_MESSAGE. Both dining.columbia.edu's taxonomy term names and
// dineoncampus.com's period names happen to match this same capitalized
// convention, so `meal` is passed through as-is to both fetchers.
//
// `skipBarnard` is for api/menus.js's request-time live path: Barnard's source
// needs a Playwright browser, which is too heavy for a single HTTP request, so
// those cells are left as liondine's own "No data available." (the scheduled
// scraper still fills them into the Supabase copy). Columbia cells are plain
// fetch()es, so they run in parallel.
async function fillGapsFromSecondarySources(menus, todayStr, { skipBarnard = false } = {}) {
  const resolveCell = async (meal, hallName) => {
    let secondary = null;
    try {
      if (COLUMBIA_HALLS.includes(hallName)) {
        secondary = await fetchColumbiaMenu(hallName, meal, todayStr);
      } else if (BARNARD_HALLS.includes(hallName)) {
        secondary = await fetchBarnardMenu(hallName, meal, todayStr);
      }
    } catch (e) {
      console.warn(`Secondary-source check failed for ${hallName} / ${meal}:`, e.message);
    }

    menus[meal][hallName] = (secondary && secondary.stations && secondary.stations.length > 0)
      ? { stations: secondary.stations }
      : { message: NO_INFO_MESSAGE };
  };

  const columbiaWork = [];
  const barnardWork = [];
  for (const meal of Object.keys(menus)) {
    for (const hallName of Object.keys(menus[meal] || {})) {
      const current = menus[meal][hallName];
      if (!current || !current.ambiguous) continue;
      if (BARNARD_HALLS.includes(hallName)) {
        if (!skipBarnard) barnardWork.push([meal, hallName]);
      } else {
        columbiaWork.push([meal, hallName]);
      }
    }
  }

  await Promise.all(columbiaWork.map(([meal, hallName]) => resolveCell(meal, hallName)));
  for (const [meal, hallName] of barnardWork) await resolveCell(meal, hallName); // one shared browser: keep sequential
}

module.exports = { fillGapsFromSecondarySources, fetchColumbiaMenu, closeBrowserIfOpen, NO_INFO_MESSAGE };
