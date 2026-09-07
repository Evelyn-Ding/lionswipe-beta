// Runs at build time (see Vercel "Build Command" in README) to generate config.js
// from environment variables, since config.js itself is gitignored.
const fs = require('fs');

const cfg = {
  SUPABASE_URL: process.env.SUPABASE_URL || '',
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || '',
  SEMESTER_END: process.env.SEMESTER_END || '2026-12-23T23:59:59-05:00',
  SEMESTER_START: process.env.SEMESTER_START || '2026-09-04T00:00:00-04:00',
  SEMESTER_TYPE: process.env.SEMESTER_TYPE || 'fall'
};

if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) {
  console.warn('⚠️  SUPABASE_URL / SUPABASE_ANON_KEY env vars are not set — config.js will use empty placeholders.');
}

const out = `// AUTO-GENERATED at build time from Vercel environment variables. Do not edit directly —
// edit config.example.js for defaults, or set env vars in Vercel Project Settings instead.
window.LIONSWIPE_CONFIG = ${JSON.stringify(cfg, null, 2)};
`;

fs.writeFileSync('config.js', out);
console.log('Generated config.js from environment variables.');
