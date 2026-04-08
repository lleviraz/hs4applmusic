/**
 * Local dev server for Hitster × Apple Music
 * ------------------------------------------
 * Serves static files + handles /proxy?url= requests server-side
 * (no CORS restrictions when fetching from Node.js).
 *
 * Usage:
 *   node server.js
 *   Then on phone (USB): http://localhost:3000
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const { URL } = require('url');

const PORT = 3000;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

// ── Fetch a URL server-side, following redirects ───────────────────────────
function serverFetch(targetUrl, redirectsLeft = 6) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(targetUrl); } catch (e) { return reject(e); }

    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.get(
      { hostname: parsed.hostname, path: parsed.pathname + parsed.search,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HitsterAMBot/1.0)' } },
      res => {
        const loc = res.headers['location'];
        if (res.statusCode >= 300 && res.statusCode < 400 && loc && redirectsLeft > 0) {
          res.resume();
          return serverFetch(new URL(loc, targetUrl).href, redirectsLeft - 1)
            .then(resolve).catch(reject);
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', c => body += c);
        res.on('end', () => resolve({ finalUrl: targetUrl, body, status: res.statusCode }));
      }
    );
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(new Error('timeout')); });
  });
}

// ── HTTP server ────────────────────────────────────────────────────────────
http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://localhost:${PORT}`);

  // ── /proxy?url=<encoded> ────────────────────────────────────────────────
  if (reqUrl.pathname === '/proxy') {
    const target = reqUrl.searchParams.get('url');
    if (!target) {
      res.writeHead(400); res.end('Missing url param'); return;
    }
    try {
      const { finalUrl, body, status } = await serverFetch(target);
      res.writeHead(status === 200 ? 200 : 502, {
        'Content-Type':                'text/html; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'X-Final-Url':                 finalUrl,
      });
      res.end(body);
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end('Proxy error: ' + e.message);
    }
    return;
  }

  // ── Static files ─────────────────────────────────────────────────────────
  let filePath = path.join(__dirname, reqUrl.pathname === '/' ? 'index.html' : reqUrl.pathname);
  // prevent path traversal
  if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end(); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const mime = MIME[path.extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });

}).listen(PORT, () => {
  console.log('');
  console.log('  Hitster × Apple Music  —  local server');
  console.log('  ----------------------------------------');
  console.log(`  Desktop : http://localhost:${PORT}`);
  console.log(`  Phone   : connect USB then http://localhost:${PORT}`);
  console.log('            (adb reverse tcp:3000 tcp:3000)');
  console.log('');
});
