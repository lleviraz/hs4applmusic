/**
 * Hitster × Apple Music — Cloudflare Worker proxy
 * ─────────────────────────────────────────────────
 * Paste this entire file into the Cloudflare Worker editor.
 *
 * What it does: fetches a URL server-side (no CORS restrictions),
 * follows redirects, and returns the HTML with CORS headers so the
 * browser app can read it.
 *
 * Security: only fetches from the four domains the app actually needs.
 */

const ALLOWED_DOMAINS = [
  'hitstergame.com',
  'open.spotify.com',
  'itunes.apple.com',
  'music.apple.com',
];

export default {
  async fetch(request) {

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin':  '*',
          'Access-Control-Allow-Methods': 'GET',
          'Access-Control-Max-Age':       '86400',
        },
      });
    }

    const { searchParams } = new URL(request.url);
    const target = searchParams.get('url');

    if (!target) {
      return new Response('Missing ?url= parameter', { status: 400 });
    }

    // Validate target domain
    let targetUrl;
    try { targetUrl = new URL(target); } catch {
      return new Response('Invalid URL', { status: 400 });
    }

    const allowed = ALLOWED_DOMAINS.some(d => targetUrl.hostname === d || targetUrl.hostname.endsWith('.' + d));
    if (!allowed) {
      return new Response(`Domain not allowed: ${targetUrl.hostname}`, { status: 403 });
    }

    // Fetch server-side (Cloudflare follows redirects automatically)
    let response;
    try {
      response = await fetch(target, {
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
          'Accept':          'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
      });
    } catch (e) {
      return new Response('Fetch failed: ' + e.message, { status: 502 });
    }

    const body = await response.text();

    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type':                'text/html; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'X-Final-Url':                 response.url,   // URL after redirects
      },
    });
  },
};
