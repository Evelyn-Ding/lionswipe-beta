// Vercel serverless function: GET -> today's menus per meal period per dining hall.
//
// dining.columbia.edu sits behind a Cloudflare JS challenge ("Just a moment...")
// that blocks plain server-side HTTP requests — a bare `fetch()` from here gets a
// 403 challenge page, not menu HTML. So this function never scrapes the site
// itself. Instead, scripts/scrape-menus.js runs on a schedule (outside Vercel,
// using a real/headless browser) and writes the day's menus into the Supabase
// `daily_menus` table (see schema.sql). This function just reads that table with
// the same public anon key the rest of the app uses, and falls back to curated
// sample data if today's row isn't there yet (scraper hasn't run, or hasn't been
// wired up to real selectors yet — see the TODO in scripts/scrape-menus.js).

const SAMPLE_MENUS = {
  Breakfast: {
    "Chef Don's Pizza Pi": { closed: true },
    "Chef Mike's Sub Shop": { closed: true },
    "Fac Shack": { hours: "8:00 AM – 11:00 AM", stations: [
      { name: "Grab & Go", items: ["Bacon Egg & Cheese Bagel", "Yogurt Parfait"] }
    ]},
    "Faculty House": { closed: true },
    "Ferris Booth Commons": { hours: "7:00 AM – 10:00 AM", stations: [
      { name: "Main Line", items: ["Scrambled Eggs", "Turkey Bacon", "Home Fries"] },
      { name: "Bakery", items: ["Assorted Muffins", "Bagels & Cream Cheese"] }
    ]},
    "Grace Dodge Dining Hall": { hours: "7:30 AM – 10:00 AM", stations: [
      { name: "Hot Station", items: ["Oatmeal Bar", "Pancakes"] }
    ]},
    "JJ's Place": { hours: "9:00 AM – 12:00 AM", stations: [
      { name: "Grill", items: ["Bacon Egg & Cheese", "Hash Browns"] }
    ]},
    "Johnny's Food Truck": { closed: true },
    "John Jay Dining Hall": { hours: "7:30 AM – 10:30 AM", stations: [
      { name: "Main Line", items: ["Scrambled Eggs", "French Toast", "Bacon"] }
    ]}
  },
  Lunch: {
    "Chef Don's Pizza Pi": { hours: "11:00 AM – 3:00 PM", stations: [
      { name: "Pizza Counter", items: ["Cheese Slice", "Pepperoni Slice", "Garlic Knots"] }
    ]},
    "Chef Mike's Sub Shop": { hours: "11:00 AM – 4:00 PM", stations: [
      { name: "Sub Counter", items: ["Italian Sub", "Turkey Club Sub", "Veggie Sub"] }
    ]},
    "Fac Shack": { hours: "11:00 AM – 3:00 PM", stations: [
      { name: "Grab & Go", items: ["Turkey Wrap", "Chicken Caesar Wrap", "Chips"] }
    ]},
    "Faculty House": { hours: "11:30 AM – 2:00 PM", stations: [
      { name: "Buffet", items: ["Seasonal Salad Bar", "Pasta Primavera"] }
    ]},
    "Ferris Booth Commons": { hours: "11:00 AM – 3:00 PM", stations: [
      { name: "Main Line", items: ["Grilled Chicken", "Rice Pilaf", "Roasted Vegetables"] },
      { name: "Action Station", items: ["Build-Your-Own Bowl"] }
    ]},
    "Grace Dodge Dining Hall": { hours: "11:00 AM – 2:00 PM", stations: [
      { name: "Hot Station", items: ["Turkey Club", "Tomato Soup"] }
    ]},
    "JJ's Place": { hours: "12:00 PM – midnight", stations: [
      { name: "Main Line", items: ["Cilantro Lime Rice", "Black Beans", "Chicken Quesadilla"] }
    ]},
    "Johnny's Food Truck": { hours: "11:30 AM – 3:00 PM", stations: [
      { name: "Truck Window", items: ["Chicken Tender Basket", "Loaded Fries", "Lemonade"] }
    ]},
    "John Jay Dining Hall": { hours: "11:00 AM – 2:30 PM", stations: [
      { name: "Main Line", items: ["Grilled Salmon", "Roasted Potatoes", "Green Beans"] },
      { name: "Grill", items: ["Cheeseburger", "Veggie Burger"] }
    ]}
  },
  Dinner: {
    "Chef Don's Pizza Pi": { hours: "5:00 PM – 9:00 PM", stations: [
      { name: "Pizza Counter", items: ["Margherita Slice", "Sicilian Slice", "Caesar Salad"] }
    ]},
    "Chef Mike's Sub Shop": { hours: "4:00 PM – 9:00 PM", stations: [
      { name: "Sub Counter", items: ["Meatball Sub", "Chicken Parm Sub", "Buffalo Chicken Sub"] }
    ]},
    "Fac Shack": { closed: true },
    "Faculty House": { closed: true },
    "Ferris Booth Commons": { hours: "5:00 PM – 8:30 PM", stations: [
      { name: "Main Line", items: ["Roasted Chicken", "Pan Roasted Sprouts"] },
      { name: "Action Station", items: ["Stir Fry Bar"] }
    ]},
    "Grace Dodge Dining Hall": { hours: "5:00 PM – 8:00 PM", stations: [
      { name: "Hot Station", items: ["Ramen Bar"] }
    ]},
    "JJ's Place": { hours: "12:00 PM – midnight", stations: [
      { name: "Main Line", items: ["Cilantro Lime Rice", "Black Beans", "Citrus Peanuts"] }
    ]},
    "Johnny's Food Truck": { hours: "5:00 PM – 9:00 PM", stations: [
      { name: "Truck Window", items: ["Cheeseburger", "Loaded Fries", "Milkshake"] }
    ]},
    "John Jay Dining Hall": { hours: "5:00 PM – 8:30 PM", stations: [
      { name: "Main Line", items: ["Baked Ziti", "Garlic Bread", "Caesar Salad"] }
    ]}
  },
  "Late Night": {
    "Chef Don's Pizza Pi": { hours: "9:00 PM – 1:00 AM", stations: [
      { name: "Late Night Slices", items: ["Cheese Slice", "Buffalo Chicken Slice"] }
    ]},
    "Chef Mike's Sub Shop": { closed: true },
    "Fac Shack": { closed: true },
    "Faculty House": { closed: true },
    "Ferris Booth Commons": { closed: true },
    "Grace Dodge Dining Hall": { closed: true },
    "JJ's Place": { hours: "10:00 PM – 2:00 AM", stations: [
      { name: "Grill", items: ["Mozzarella Sticks", "Late Night Fries"] }
    ]},
    "Johnny's Food Truck": { hours: "9:00 PM – 1:00 AM", stations: [
      { name: "Truck Window", items: ["Mozzarella Sticks", "Chicken Tenders"] }
    ]},
    "John Jay Dining Hall": { closed: true }
  }
};

async function getMenus() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return SAMPLE_MENUS;

  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
    const resp = await fetch(
      `${url}/rest/v1/daily_menus?date=eq.${today}&select=menus`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }
    );
    if (!resp.ok) return SAMPLE_MENUS;
    const rows = await resp.json();
    return (rows && rows[0] && rows[0].menus) || SAMPLE_MENUS;
  } catch (err) {
    console.error('daily_menus lookup failed, using sample data:', err.message);
    return SAMPLE_MENUS;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const menus = await getMenus();
    res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=1800');
    res.status(200).json(menus);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
