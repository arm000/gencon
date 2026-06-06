/**
 * GenCon AI Proxy — Cloudflare Worker
 *
 * Routes:
 *   POST /              → Anthropic Messages API proxy
 *   POST /sync-gencon   → Scrape user's registered events from GenCon.com
 *   GET  /watches       → List saved searches
 *   POST /watches       → Create saved search (+ sends initial notification)
 *   DELETE /watches/:id → Delete saved search
 *   GET  /prefs         → Get notification preferences
 *   POST /prefs         → Update notification preferences
 *
 * Cron (every 2 hours):
 *   Fetches latest events.json, runs each saved search, sends email/SMS
 *   for new matches or ticket restocks.
 */

const ANTHROPIC_API      = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION  = '2023-06-01';
const ALLOWED_ORIGIN     = '*';
const GENCON_BASE        = 'https://www.gencon.com';
const GENCON_UA          = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const EVENTS_JSON_URL    = 'https://arm000.github.io/gencon/events.json';

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return corsResponse(null, 204);

    const { pathname } = new URL(request.url);
    const method = request.method;

    // ── Watches (saved searches) ──────────────────────────────
    if (pathname === '/watches') {
      if (method === 'GET')  return handleGetWatches(env);
      if (method === 'POST') return handlePostWatch(request, env);
      return corsResponse('Method not allowed', 405);
    }
    if (pathname.startsWith('/watches/')) {
      if (method === 'DELETE') return handleDeleteWatch(pathname, env);
      return corsResponse('Method not allowed', 405);
    }

    // ── Notification prefs ────────────────────────────────────
    if (pathname === '/prefs') {
      if (method === 'GET')  return handleGetPrefs(env);
      if (method === 'POST') return handlePostPrefs(request, env);
      return corsResponse('Method not allowed', 405);
    }

    // ── Existing routes ───────────────────────────────────────
    if (method !== 'POST') return corsResponse('Method not allowed', 405);

    if (pathname === '/sync-gencon') return handleGenconSync(request);
    return handleAnthropic(request, env);
  },

  async scheduled(event, env) {
    await runNotificationCheck(env);
  },
};

// ── Watches CRUD ──────────────────────────────────────────────

async function handleGetWatches(env) {
  const { results } = await env.DB.prepare(
    'SELECT id, name, filters, created_at FROM saved_searches ORDER BY created_at DESC'
  ).all();
  return corsResponse(JSON.stringify(results || []));
}

async function handlePostWatch(request, env) {
  let body;
  try { body = await request.json(); } catch { return corsResponse(JSON.stringify({ error: 'Invalid JSON' }), 400); }

  const { name, filters } = body || {};
  if (!name || !filters) return corsResponse(JSON.stringify({ error: 'name and filters required' }), 400);

  const id = crypto.randomUUID();
  const created_at = Date.now();
  await env.DB.prepare(
    'INSERT INTO saved_searches (id, name, filters, created_at) VALUES (?, ?, ?, ?)'
  ).bind(id, name, JSON.stringify(filters), created_at).run();

  // Baseline: record all current matches so first cron doesn't re-notify them.
  // Also send an initial notification so the user sees what matches right now.
  try {
    const events = await fetchEvents();
    const matches = searchEventsLocal(events, filters);
    if (matches.length) {
      const stmts = matches.map(ev =>
        env.DB.prepare(
          'INSERT OR IGNORE INTO notification_state (event_id, search_id, tickets, notified_at) VALUES (?, ?, ?, ?)'
        ).bind(ev.id, id, ev.ticketsAvailable ?? 0, Date.now())
      );
      await env.DB.batch(stmts);

      const prefs = await getPrefs(env);
      if (prefs.email || prefs.phone) {
        await sendNotifications(prefs, [{ searchName: name, items: matches.map(ev => ({ ev, reason: 'new' })) }], env);
      }
    }
  } catch (e) {
    // Non-fatal: watch was saved, initial notification failed
    console.error('Initial notification failed:', e.message);
  }

  return corsResponse(JSON.stringify({ id, name, filters: JSON.stringify(filters), created_at }), 201);
}

async function handleDeleteWatch(pathname, env) {
  const id = pathname.replace('/watches/', '');
  await env.DB.prepare('DELETE FROM saved_searches WHERE id = ?').bind(id).run();
  await env.DB.prepare('DELETE FROM notification_state WHERE search_id = ?').bind(id).run();
  return corsResponse(JSON.stringify({ ok: true }));
}

// ── Prefs ─────────────────────────────────────────────────────

async function handleGetPrefs(env) {
  return corsResponse(JSON.stringify(await getPrefs(env)));
}

async function handlePostPrefs(request, env) {
  let body;
  try { body = await request.json(); } catch { return corsResponse(JSON.stringify({ error: 'Invalid JSON' }), 400); }

  const allowed = ['email', 'phone', 'email_on', 'sms_on'];
  const stmts = [];
  for (const key of allowed) {
    if (key in body) {
      stmts.push(
        env.DB.prepare('INSERT OR REPLACE INTO user_prefs (key, value) VALUES (?, ?)')
          .bind(key, String(body[key]))
      );
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
  return corsResponse(JSON.stringify({ ok: true }));
}

async function getPrefs(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM user_prefs').all();
  const map = Object.fromEntries((results || []).map(r => [r.key, r.value]));
  return {
    email:     map.email    || '',
    phone:     map.phone    || '',
    email_on:  map.email_on !== '0',
    sms_on:    map.sms_on   !== '0',
  };
}

// ── Cron: notification check ──────────────────────────────────

async function runNotificationCheck(env) {
  const prefs = await getPrefs(env);
  const canEmail = prefs.email    && prefs.email_on;
  const canSms   = prefs.phone    && prefs.sms_on;
  if (!canEmail && !canSms) return;

  const events = await fetchEvents();

  const { results: searches } = await env.DB.prepare(
    'SELECT id, name, filters FROM saved_searches'
  ).all();
  if (!searches?.length) return;

  const groups = [];

  for (const search of searches) {
    let filters;
    try { filters = JSON.parse(search.filters); } catch { continue; }

    const matches = searchEventsLocal(events, filters);
    if (!matches.length) continue;

    const matchIds = new Set(matches.map(m => m.id));

    const { results: stateRows } = await env.DB.prepare(
      'SELECT event_id, tickets FROM notification_state WHERE search_id = ?'
    ).bind(search.id).all();
    const stateMap = Object.fromEntries((stateRows || []).map(r => [r.event_id, r.tickets]));

    const toNotify = [];
    const upserts  = [];

    for (const ev of matches) {
      const prev = stateMap[ev.id];
      const cur  = ev.ticketsAvailable ?? 0;

      if (prev === undefined) {
        toNotify.push({ ev, reason: 'new' });
        upserts.push(
          env.DB.prepare(
            'INSERT INTO notification_state (event_id, search_id, tickets, notified_at) VALUES (?, ?, ?, ?)'
          ).bind(ev.id, search.id, cur, Date.now())
        );
      } else if (cur > prev) {
        toNotify.push({ ev, reason: 'restock', prevTickets: prev });
        upserts.push(
          env.DB.prepare(
            'UPDATE notification_state SET tickets = ?, notified_at = ? WHERE event_id = ? AND search_id = ?'
          ).bind(cur, Date.now(), ev.id, search.id)
        );
      } else {
        // Update ticket count silently (might have decreased; keep tracking)
        upserts.push(
          env.DB.prepare(
            'UPDATE notification_state SET tickets = ? WHERE event_id = ? AND search_id = ?'
          ).bind(cur, ev.id, search.id)
        );
      }
    }

    if (upserts.length) await env.DB.batch(upserts);
    if (toNotify.length) groups.push({ searchName: search.name, items: toNotify });
  }

  if (groups.length) {
    await sendNotifications(prefs, groups, env);
  }
}

// ── Notification senders ──────────────────────────────────────

async function sendNotifications(prefs, groups, env) {
  const totalItems = groups.reduce((n, g) => n + g.items.length, 0);

  const emailBody = buildEmailBody(groups);
  const smsBody   = buildSmsBody(groups, totalItems);

  const tasks = [];
  if (prefs.email && prefs.email_on && env.RESEND_API_KEY) {
    tasks.push(sendEmail(prefs.email, emailBody, totalItems, env));
  }
  if (prefs.phone && prefs.sms_on && env.TWILIO_ACCOUNT_SID) {
    tasks.push(sendSms(prefs.phone, smsBody, env));
  }
  await Promise.allSettled(tasks);
}

function buildEmailBody(groups) {
  const lines = [];
  for (const { searchName, items } of groups) {
    lines.push(`=== ${searchName} ===\n`);
    for (const { ev, reason, prevTickets } of items) {
      const label = reason === 'restock'
        ? `TICKETS RESTOCKED (was ${prevTickets}, now ${ev.ticketsAvailable})`
        : 'NEW MATCH';
      lines.push(`[${label}] ${ev.title}`);
      lines.push(`  Type: ${ev.type}`);
      lines.push(`  When: ${ev.start} for ${ev.duration}h`);
      if (ev.location) lines.push(`  Where: ${ev.location}${ev.roomName ? ' / ' + ev.roomName : ''}`);
      lines.push(`  Tickets available: ${ev.ticketsAvailable}`);
      if (ev.cost) lines.push(`  Cost: $${ev.cost}`);
      lines.push(`  https://www.gencon.com/events/${ev.id.replace(/^[A-Z]+26[A-Z]*/, '')}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}

function buildSmsBody(groups, totalItems) {
  const searchNames = groups.map(g => `"${g.searchName}"`).join(', ');
  return `GenCon: ${totalItems} new match${totalItems !== 1 ? 'es' : ''} for ${searchNames}. Check your email for details.`;
}

async function sendEmail(to, body, count, env) {
  const subject = `GenCon Watch: ${count} new match${count !== 1 ? 'es' : ''}`;
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL || 'GenCon Watch <onboarding@resend.dev>',
      to: [to],
      subject,
      text: body,
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Resend error ${resp.status}: ${err}`);
  }
}

async function sendSms(to, body, env) {
  const phone = to.startsWith('+') ? to : `+1${to.replace(/\D/g, '')}`;
  const creds = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
  const resp = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${creds}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        From: env.TWILIO_FROM_NUMBER,
        To:   phone,
        Body: body,
      }).toString(),
    }
  );
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Twilio error ${resp.status}: ${err}`);
  }
}

// ── Event fetching & search ───────────────────────────────────

async function fetchEvents() {
  const resp = await fetch(EVENTS_JSON_URL, { cf: { cacheTtl: 300 } });
  if (!resp.ok) throw new Error(`Failed to fetch events: ${resp.status}`);
  return resp.json();
}

// Mirror of app.js search logic (no hideConflicts support needed here)
function normalizeText(s) {
  return (s || '').toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

const DAYS_MAP = { '07/30': 'Thu', '07/31': 'Fri', '08/01': 'Sat', '08/02': 'Sun' };
const TIME_OF_DAY = { morning: [0, 12], afternoon: [12, 18], evening: [18, 24] };
const SEARCH_FIELDS = ['title', 'shortDesc', 'longDesc', 'system', 'gmNames', 'type'];

function parseDayFilter(val) {
  const idx = val.lastIndexOf('-');
  if (idx > 0 && TIME_OF_DAY[val.slice(idx + 1)]) {
    return { day: val.slice(0, idx), timeOfDay: val.slice(idx + 1) };
  }
  return { day: val, timeOfDay: '' };
}

function searchEventsLocal(events, p = {}) {
  const { query = '', type = '', day = '', system = '', minTickets = 0, minDur = 0, maxDur = 0 } = p;
  const words = normalizeText(query).split(' ').filter(Boolean);

  return events.filter(ev => {
    if (words.length) {
      const haystack = SEARCH_FIELDS.map(f => normalizeText(ev[f])).join(' ');
      if (!words.every(w => haystack.includes(w))) return false;
    }
    if (type && !(ev.type || '').toLowerCase().includes(type.toLowerCase())) return false;
    if (day) {
      const { day: dayPart, timeOfDay } = parseDayFilter(day);
      const prefix   = (ev.start || '').slice(0, 5);
      const dayLabel = DAYS_MAP[prefix] || '';
      if (!dayLabel.toLowerCase().startsWith(dayPart.toLowerCase()) &&
          !prefix.startsWith(dayPart)) return false;
      if (timeOfDay && TIME_OF_DAY[timeOfDay]) {
        const d = new Date(ev.start.replace(/(\d+)\/(\d+)\/(\d+) (\d+):(\d+) (AM|PM)/, (_, mo, dy, yr, h, mi, ap) => {
          let hh = +h; if (ap === 'PM' && hh !== 12) hh += 12; if (ap === 'AM' && hh === 12) hh = 0;
          return `${yr}-${mo.padStart(2,'0')}-${dy.padStart(2,'0')}T${String(hh).padStart(2,'0')}:${mi}:00`;
        }));
        if (!isNaN(d)) {
          const h = d.getHours();
          const [startH, endH] = TIME_OF_DAY[timeOfDay];
          if (h < startH || h >= endH) return false;
        }
      }
    }
    if (system && !(ev.system || '').toLowerCase().includes(system.toLowerCase())) return false;
    if (minTickets > 0 && (ev.ticketsAvailable || 0) < minTickets) return false;
    if (minDur > 0 && (ev.duration || 0) < minDur) return false;
    if (maxDur > 0 && (ev.duration || 0) > maxDur) return false;
    return true;
  });
}

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
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
