// Vercel serverless function: GET -> today's menus per meal period per dining hall.
//
// Fetches liondine.com (which already aggregates Columbia + Barnard dining halls)
// live on every request — see lib/liondine.js for the fetch/parse logic, shared
// with scripts/scrape-menus.js. This replaced an earlier design that scraped on
// a schedule into a Supabase `daily_menus` table instead: that added a caching
// layer whose scrape cadence/target could drift out of sync with what the app
// actually reads (exactly what happened — see git history around 2026-09-08),
// so the two are now collapsed into one direct fetch. Falls back to curated
// sample data only if liondine itself is unreachable.

const SAMPLE_MENUS = {
  Breakfast: {
    "Chef Don's": { closed: true, message: "Closed for breakfast" },
    "Chef Mike's": { closed: true, message: "Closed for breakfast" },
    "Fac Shack": { hours: "8:00 AM to 11:00 AM", stations: [
      { name: "Grab & Go", items: ["Bacon Egg & Cheese Bagel", "Yogurt Parfait"] }
    ]},
    "Faculty House": { closed: true, message: "Closed for breakfast" },
    "Ferris": { hours: "7:00 AM to 10:00 AM", stations: [
      { name: "Main Line", items: ["Scrambled Eggs", "Turkey Bacon", "Home Fries"] },
      { name: "Bakery", items: ["Assorted Muffins", "Bagels & Cream Cheese"] }
    ]},
    "Grace Dodge": { hours: "7:30 AM to 10:00 AM", stations: [
      { name: "Hot Station", items: ["Oatmeal Bar", "Pancakes"] }
    ]},
    "JJ's": { hours: "9:00 AM to 12:00 AM", stations: [
      { name: "Grill", items: ["Bacon Egg & Cheese", "Hash Browns"] }
    ]},
    "Johnny's": { closed: true, message: "Closed for breakfast" },
    "John Jay": { hours: "7:30 AM to 10:30 AM", stations: [
      { name: "Main Line", items: ["Scrambled Eggs", "French Toast", "Bacon"] }
    ]},
    "Hewitt": { hours: "7:30 AM to 10:00 AM", stations: [
      { name: "Homestyle", items: ["Scrambled Eggs", "Waffles", "Tofu Scramble"] }
    ]},
    "Diana": { closed: true, message: "Closed for breakfast" }
  },
  Lunch: {
    "Chef Don's": { hours: "11:00 AM to 3:00 PM", stations: [
      { name: "Pizza Counter", items: ["Cheese Slice", "Pepperoni Slice", "Garlic Knots"] }
    ]},
    "Chef Mike's": { hours: "11:00 AM to 4:00 PM", stations: [
      { name: "Sub Counter", items: ["Italian Sub", "Turkey Club Sub", "Veggie Sub"] }
    ]},
    "Fac Shack": { hours: "11:00 AM to 3:00 PM", stations: [
      { name: "Grab & Go", items: ["Turkey Wrap", "Chicken Caesar Wrap", "Chips"] }
    ]},
    "Faculty House": { hours: "11:30 AM to 2:00 PM", stations: [
      { name: "Buffet", items: ["Seasonal Salad Bar", "Pasta Primavera"] }
    ]},
    "Ferris": { hours: "11:00 AM to 3:00 PM", stations: [
      { name: "Main Line", items: ["Grilled Chicken", "Rice Pilaf", "Roasted Vegetables"] },
      { name: "Action Station", items: ["Build-Your-Own Bowl"] }
    ]},
    "Grace Dodge": { hours: "11:00 AM to 2:00 PM", stations: [
      { name: "Hot Station", items: ["Turkey Club", "Tomato Soup"] }
    ]},
    "JJ's": { hours: "12:00 PM to midnight", stations: [
      { name: "Main Line", items: ["Cilantro Lime Rice", "Black Beans", "Chicken Quesadilla"] }
    ]},
    "Johnny's": { hours: "11:30 AM to 3:00 PM", stations: [
      { name: "Truck Window", items: ["Chicken Tender Basket", "Loaded Fries", "Lemonade"] }
    ]},
    "John Jay": { hours: "11:00 AM to 2:30 PM", stations: [
      { name: "Main Line", items: ["Grilled Salmon", "Roasted Potatoes", "Green Beans"] },
      { name: "Grill", items: ["Cheeseburger", "Veggie Burger"] }
    ]},
    "Hewitt": { hours: "11:00 AM to 2:00 PM", stations: [
      { name: "Homestyle", items: ["Baked Chicken Quarter", "Cajun Vegetable Rice"] }
    ]},
    "Diana": { closed: true, message: "Closed for lunch" }
  },
  Dinner: {
    "Chef Don's": { hours: "5:00 PM to 9:00 PM", stations: [
      { name: "Pizza Counter", items: ["Margherita Slice", "Sicilian Slice", "Caesar Salad"] }
    ]},
    "Chef Mike's": { hours: "4:00 PM to 9:00 PM", stations: [
      { name: "Sub Counter", items: ["Meatball Sub", "Chicken Parm Sub", "Buffalo Chicken Sub"] }
    ]},
    "Fac Shack": { closed: true, message: "Closed for dinner" },
    "Faculty House": { closed: true, message: "Closed for dinner" },
    "Ferris": { hours: "5:00 PM to 8:30 PM", stations: [
      { name: "Main Line", items: ["Roasted Chicken", "Pan Roasted Sprouts"] },
      { name: "Action Station", items: ["Stir Fry Bar"] }
    ]},
    "Grace Dodge": { hours: "5:00 PM to 8:00 PM", stations: [
      { name: "Hot Station", items: ["Ramen Bar"] }
    ]},
    "JJ's": { hours: "12:00 PM to midnight", stations: [
      { name: "Main Line", items: ["Cilantro Lime Rice", "Black Beans", "Citrus Peanuts"] }
    ]},
    "Johnny's": { hours: "5:00 PM to 9:00 PM", stations: [
      { name: "Truck Window", items: ["Cheeseburger", "Loaded Fries", "Milkshake"] }
    ]},
    "John Jay": { hours: "5:00 PM to 8:30 PM", stations: [
      { name: "Main Line", items: ["Baked Ziti", "Garlic Bread", "Caesar Salad"] }
    ]},
    "Hewitt": { closed: true, message: "Closed for dinner" },
    "Diana": { closed: true, message: "Closed for dinner" }
  },
  "Late Night": {
    "Chef Don's": { hours: "9:00 PM to 1:00 AM", stations: [
      { name: "Late Night Slices", items: ["Cheese Slice", "Buffalo Chicken Slice"] }
    ]},
    "Chef Mike's": { closed: true, message: "Closed for latenight" },
    "Fac Shack": { closed: true, message: "Closed for latenight" },
    "Faculty House": { closed: true, message: "Closed for latenight" },
    "Ferris": { closed: true, message: "Closed for latenight" },
    "Grace Dodge": { closed: true, message: "Closed for latenight" },
    "JJ's": { hours: "10:00 PM to 2:00 AM", stations: [
      { name: "Grill", items: ["Mozzarella Sticks", "Late Night Fries"] }
    ]},
    "Johnny's": { hours: "9:00 PM to 1:00 AM", stations: [
      { name: "Truck Window", items: ["Mozzarella Sticks", "Chicken Tenders"] }
    ]},
    "John Jay": { closed: true, message: "Closed for latenight" },
    "Hewitt": { closed: true, message: "Closed for latenight" },
    "Diana": { closed: true, message: "Closed for latenight" }
  }
};

import liondine from '../lib/liondine.js';
const { fetchLiondineMenus } = liondine;

async function getMenus() {
  try {
    const { menus, anyPageLoaded } = await fetchLiondineMenus();
    if (!anyPageLoaded) return SAMPLE_MENUS;
    return menus;
  } catch (err) {
    console.error('liondine fetch failed, using sample data:', err.message);
    return SAMPLE_MENUS;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const menus = await getMenus();
    // Short edge cache so a burst of simultaneous page loads shares one
    // liondine fetch instead of each hitting it individually, without
    // meaningfully delaying how fresh the data is (liondine itself doesn't
    // update mid-meal-period anyway).
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    res.status(200).json(menus);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
