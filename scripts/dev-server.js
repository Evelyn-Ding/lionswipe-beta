// Minimal local dev server — no Vercel CLI, no login, no GitHub OAuth involved.
// Serves index.html/config.js as static files and runs the api/*.js handlers
// the same way Vercel would: handler(req, res) with req.body pre-parsed as JSON and
// res.status()/res.json() shimmed to match Vercel's Node runtime conventions.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 3000;

// vercel dev normally loads .env automatically; since we're bypassing it entirely,
// do that ourselves here (simple KEY=VALUE parser, no dependency needed).
function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (!m) return;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(m[1] in process.env)) process.env[m[1]] = val;
  });
}
loadEnv();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

function serveStatic(req, res) {
  let reqPath = req.url.split('?')[0];
  if (reqPath === '/') reqPath = '/index.html';
  const filePath = path.join(ROOT, reqPath);
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found: ' + reqPath); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { resolve({}); }
    });
  });
}

function shimRes(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => {
    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(obj));
  };
  return res;
}

async function callApiHandler(relPath, req, res) {
  const mod = await import(pathToFileURL(path.join(ROOT, relPath)).href);
  req.body = await readJsonBody(req);
  shimRes(res);
  await mod.default(req, res);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/api/menus')) {
      await callApiHandler('api/menus.js', req, res);
    } else if (req.url.startsWith('/api/delete-account')) {
      await callApiHandler('api/delete-account.js', req, res);
    } else {
      serveStatic(req, res);
    }
  } catch (err) {
    console.error(err);
    res.writeHead(500);
    res.end('Internal error: ' + err.message);
  }
});

server.listen(PORT, () => {
  console.log(`LionSwipe dev server running at http://localhost:${PORT}`);
});
