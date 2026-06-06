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

const ANTHROPIC_API      = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION  = '2023-06-01';
const ALLOWED_ORIGIN     = '*';
const GENCON_BASE        = 'https://www.gencon.com';
const GENCON_UA          = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return corsResponse(null, 204);
    if (request.method !== 'POST')   return corsResponse('Method not allowed', 405);

    const path = new URL(request.url).pathname;

    if (path === '/sync-gencon') return handleGenconSync(request);
    return handleAnthropic(request, env);
  },
};

// ── Anthropic proxy ───────────────────────────────────────────
async function handleAnthropic(request, env) {
  if (!env.ANTHROPIC_API_KEY)
    return corsResponse(JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }), 500);

  let body;
  try { body = await request.text(); }
  catch { return corsResponse(JSON.stringify({ error: 'Failed to read request body' }), 400); }

  let upstream;
  try {
    upstream = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         env.ANTHROPIC_API_KEY,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body,
    });
  } catch (err) {
    return corsResponse(JSON.stringify({ error: `Upstream fetch failed: ${err.message}` }), 502);
  }

  return corsResponse(await upstream.text(), upstream.status);
}

// ── GenCon sync ───────────────────────────────────────────────
async function handleGenconSync(request) {
  let body;
  try { body = await request.json(); }
  catch { return corsResponse(JSON.stringify({ error: 'Invalid JSON body' }), 400); }

  const { email, password } = body || {};
  if (!email || !password)
    return corsResponse(JSON.stringify({ error: 'email and password required' }), 400);

  try {
    const event_ids = await scrapeGencon(email, password);
    return corsResponse(JSON.stringify({ event_ids }));
  } catch (err) {
    return corsResponse(JSON.stringify({ error: err.message }), 500);
  }
}

function updateJar(jar, headers) {
  for (const [k, v] of headers) {
    if (k.toLowerCase() !== 'set-cookie') continue;
    const eqIdx = v.indexOf('=');
    if (eqIdx > -1) jar[v.slice(0, eqIdx).trim()] = v.slice(eqIdx + 1).split(';')[0].trim();
  }
}

function cookieStr(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function scrapeGencon(email, password) {
  const jar = {};
  const baseHeaders = {
    'User-Agent': GENCON_UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  };

  // 1. GET /login — grab session cookie + CSRF token
  const loginResp = await fetch(`${GENCON_BASE}/login`, { headers: baseHeaders });
  updateJar(jar, loginResp.headers);
  const loginHtml = await loginResp.text();
  const tokenMatch = loginHtml.match(/name="authenticity_token"[^>]*value="([^"]+)"/);
  if (!tokenMatch) throw new Error('Could not find CSRF token on login page');

  // 2. POST /users/sign_in — use redirect:manual to capture the new session cookie
  const signInResp = await fetch(`${GENCON_BASE}/users/sign_in`, {
    method: 'POST',
    headers: {
      ...baseHeaders,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie':   cookieStr(jar),
      'Referer':  `${GENCON_BASE}/login`,
    },
    body: new URLSearchParams({
      'authenticity_token': tokenMatch[1],
      'user[email]':        email,
      'user[password]':     password,
      'user[remember_me]':  '0',
      'commit':             'Sign In',
    }).toString(),
    redirect: 'manual',
  });
  updateJar(jar, signInResp.headers);

  const location = signInResp.headers.get('location') || '';
  if (signInResp.status >= 400 || location.includes('/login') || location.includes('sign_in')) {
    throw new Error('Login failed — check your email and password');
  }

  // Follow the post-login redirect
  const afterLogin = await fetch(
    location.startsWith('http') ? location : `${GENCON_BASE}${location}`,
    { headers: { ...baseHeaders, 'Cookie': cookieStr(jar) } },
  );
  updateJar(jar, afterLogin.headers);
  if ((await afterLogin.text()).includes('Invalid Email or password')) {
    throw new Error('Login failed — check your email and password');
  }

  // 3. GET /profile — extract contactId from user-id attribute
  const profileResp = await fetch(`${GENCON_BASE}/profile`, {
    headers: { ...baseHeaders, 'Cookie': cookieStr(jar) },
  });
  if (profileResp.url?.includes('/login')) throw new Error('Session not authenticated after login');
  const profileHtml = await profileResp.text();
  const contactMatch = profileHtml.match(/user-id=['"](\d+)['"]/) ||
                       profileHtml.match(/"userId":(\d+)/);
  if (!contactMatch) throw new Error('Could not find contact ID on profile page');
  const contactId = contactMatch[1];

  // 4. GET /api/v2/schedule — fetch all pages
  const eventIds = [];
  let page = 1, totalPages = 1;
  do {
    const schedResp = await fetch(
      `${GENCON_BASE}/api/v2/schedule?contact_id=${contactId}&page=${page}`,
      { headers: { ...baseHeaders, 'Cookie': cookieStr(jar), 'Accept': 'application/json' } },
    );
    const sched = await schedResp.json();
    for (const ev of sched.data || []) {
      if (ev.event_id) eventIds.push(ev.event_id);
    }
    totalPages = sched.total_num_of_pages || 1;
    page++;
  } while (page <= totalPages);

  return [...new Set(eventIds)];
}

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
