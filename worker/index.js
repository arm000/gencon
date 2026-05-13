/**
 * GenCon AI Proxy — Cloudflare Worker
 *
 * Proxies POST requests to the Anthropic Messages API, injecting the
 * API key from an environment secret so it never appears in the browser.
 *
 * Deploy:
 *   cd worker
 *   npx wrangler@latest deploy
 *   npx wrangler@latest secret put ANTHROPIC_API_KEY
 *
 * Optional: restrict ALLOWED_ORIGIN to your GitHub Pages URL.
 */

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const ALLOWED_ORIGIN = '*';   // tighten to 'https://yourname.github.io' if desired

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return corsResponse(null, 204);
    }

    if (request.method !== 'POST') {
      return corsResponse('Method not allowed', 405);
    }

    if (!env.ANTHROPIC_API_KEY) {
      return corsResponse(JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }), 500);
    }

    let body;
    try {
      body = await request.text();
    } catch {
      return corsResponse(JSON.stringify({ error: 'Failed to read request body' }), 400);
    }

    // Forward to Anthropic, injecting the secret key
    let upstream;
    try {
      upstream = await fetch(ANTHROPIC_API, {
        method: 'POST',
        headers: {
          'Content-Type':    'application/json',
          'x-api-key':       env.ANTHROPIC_API_KEY,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body,
      });
    } catch (err) {
      return corsResponse(JSON.stringify({ error: `Upstream fetch failed: ${err.message}` }), 502);
    }

    const responseBody = await upstream.text();
    return corsResponse(responseBody, upstream.status, 'application/json');
  },
};

function corsResponse(body, status = 200, contentType = 'application/json') {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
