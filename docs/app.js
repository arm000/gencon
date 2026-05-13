// ============================================================
//  GenCon 2026 Event Planner — shared application logic
// ============================================================

// ── Configuration ────────────────────────────────────────────
const EVENTS_JSON_URL = 'events.json';
const STORAGE_KEY     = 'gencon-schedule-2026';
const CONV_DATES      = ['07/30', '07/31', '08/01', '08/02'];
const DAYS_MAP        = { '07/30': 'Thu', '07/31': 'Fri', '08/01': 'Sat', '08/02': 'Sun' };
const DAY_DATES       = { 'Thu': '07/30', 'Fri': '07/31', 'Sat': '08/01', 'Sun': '08/02' };
const DAY_START_HOUR  = 8;   // 8 AM — earlier events ignored in gap calc
const DAY_END_HOUR    = 24;  // midnight
const SEARCH_FIELDS   = ['title', 'shortDesc', 'longDesc', 'system', 'gmNames', 'type'];
const PAGE_SIZE       = 50;

// ── App state ─────────────────────────────────────────────────
let ALL_EVENTS   = [];
let EVENT_INDEX  = {};   // id → event
const TIME_CACHE = {};   // str → Date

// ── Bootstrap ────────────────────────────────────────────────
async function initApp() {
  const res = await fetch(EVENTS_JSON_URL);
  if (!res.ok) throw new Error(`Failed to load events.json: ${res.status}`);
  ALL_EVENTS  = await res.json();
  EVENT_INDEX = {};
  for (const ev of ALL_EVENTS) EVENT_INDEX[ev.id] = ev;

  // Load version info and render footer
  try {
    const vres = await fetch('version.json');
    if (vres.ok) {
      const { built, count } = await vres.json();
      const d = new Date(built);
      const label = `${count.toLocaleString()} events · built ${d.toLocaleString(undefined, {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
      })}`;
      for (const el of document.querySelectorAll('.version-label')) {
        el.textContent = label;
      }
    }
  } catch { /* non-fatal */ }
}

// ── Time utilities ────────────────────────────────────────────

/**
 * Parse "07/30/2026 01:00 PM" → Date (local time).
 * Results are cached so repeated calls are O(1).
 */
function parseTime(str) {
  if (!str) return null;
  if (TIME_CACHE[str]) return TIME_CACHE[str];
  const m = str.match(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{1,2}):(\d{2}) (AM|PM)$/);
  if (!m) return null;
  let [, mo, dy, yr, hr, mn, ap] = m;
  hr = parseInt(hr, 10);
  if (ap === 'PM' && hr !== 12) hr += 12;
  if (ap === 'AM' && hr === 12) hr = 0;
  const d = new Date(+yr, +mo - 1, +dy, hr, +mn);
  TIME_CACHE[str] = d;
  return d;
}

/** Format a Date as "1:00 PM" */
function fmtTime(d) {
  if (!d) return '?';
  const hr = d.getHours(), mn = d.getMinutes();
  const h  = hr % 12 || 12;
  const m  = String(mn).padStart(2, '0');
  return `${h}:${m} ${hr < 12 ? 'AM' : 'PM'}`;
}

/** Format an event's timeslot as "Thu 1:00 PM – 5:00 PM" */
function fmtSlot(ev) {
  const s = parseTime(ev.start), e = parseTime(ev.end);
  const prefix = (ev.start || '').slice(0, 5);
  const day = DAYS_MAP[prefix] ? DAYS_MAP[prefix] + ' ' : '';
  return `${day}${fmtTime(s)} – ${fmtTime(e)}`;
}

/** Get day label for an event ("Thu", "Fri", …) */
function evDay(ev) {
  return DAYS_MAP[(ev.start || '').slice(0, 5)] || '';
}

// ── Schedule (localStorage) ───────────────────────────────────

function getIds() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); }
  catch { return []; }
}

function setIds(ids) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
}

function getScheduledEvents() {
  return getIds().map(id => EVENT_INDEX[id]).filter(Boolean);
}

function isScheduled(id) {
  return getIds().includes(id);
}

/**
 * Attempt to add an event to the schedule.
 * @param {string} id
 * @param {boolean} force  Add even if conflicts exist.
 * @returns {{ status: 'ok'|'already'|'notfound'|'conflict', conflicts: object[] }}
 */
function addEvent(id, force = false) {
  const ids = getIds();
  if (ids.includes(id))           return { status: 'already',  conflicts: [] };
  const ev = EVENT_INDEX[id];
  if (!ev)                         return { status: 'notfound', conflicts: [] };

  const scheduled = ids.map(i => EVENT_INDEX[i]).filter(Boolean);
  const cfls = findConflicts(ev, scheduled);

  if (cfls.length && !force)      return { status: 'conflict', conflicts: cfls };

  ids.push(id);
  setIds(ids);
  return { status: 'ok', conflicts: cfls };
}

function removeEvent(id) {
  const ids = getIds().filter(i => i !== id);
  setIds(ids);
}

// ── Conflict detection ────────────────────────────────────────

function overlaps(as, ae, bs, be) {
  return as < be && bs < ae;
}

function findConflicts(ev, scheduledEvents) {
  const s = parseTime(ev.start), e = parseTime(ev.end);
  if (!s || !e) return [];
  return scheduledEvents.filter(se => {
    const ss = parseTime(se.start), se2 = parseTime(se.end);
    return ss && se2 && overlaps(s, e, ss, se2);
  });
}

// ── Search ────────────────────────────────────────────────────

/**
 * Filter ALL_EVENTS by search params.
 * @param {object} p  { query, type, day, system, minTickets, minDur, maxDur }
 */
function searchEvents(p = {}) {
  const { query = '', type = '', day = '', system = '', minTickets = 0, minDur = 0, maxDur = 0 } = p;
  const q = query.trim().toLowerCase();

  return ALL_EVENTS.filter(ev => {
    // Full-text
    if (q && !SEARCH_FIELDS.some(f => (ev[f] || '').toLowerCase().includes(q))) return false;
    // Type
    if (type && !(ev.type || '').toLowerCase().includes(type.toLowerCase())) return false;
    // Day / Day+time: "Thu", "Thu-morning", "07/30", etc.
    if (day) {
      const { day: dayPart, timeOfDay } = parseDayFilter(day);
      const prefix   = (ev.start || '').slice(0, 5);
      const dayLabel = DAYS_MAP[prefix] || '';
      if (!dayLabel.toLowerCase().startsWith(dayPart.toLowerCase()) &&
          !prefix.startsWith(dayPart)) return false;
      if (timeOfDay && TIME_OF_DAY[timeOfDay]) {
        const startDate = parseTime(ev.start);
        if (startDate) {
          const h = startDate.getHours();
          const [startH, endH] = TIME_OF_DAY[timeOfDay];
          if (h < startH || h >= endH) return false;
        }
      }
    }
    // System
    if (system && !(ev.system || '').toLowerCase().includes(system.toLowerCase())) return false;
    // Tickets
    if (minTickets > 0 && (ev.ticketsAvailable || 0) < minTickets) return false;
    // Duration
    if (minDur > 0 && (ev.duration || 0) < minDur) return false;
    if (maxDur > 0 && (ev.duration || 0) > maxDur) return false;
    return true;
  });
}

/** All unique event types sorted by frequency */
function allTypes() {
  const counts = {};
  for (const ev of ALL_EVENTS) counts[ev.type] = (counts[ev.type] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([t]) => t);
}

// ── Alternatives ──────────────────────────────────────────────

/**
 * Return all events with the same title as the given event,
 * sorted by start time, annotated with schedule status.
 */
function getAlternatives(id) {
  const base = EVENT_INDEX[id];
  if (!base) return [];
  const title = (base.title || '').trim();
  const ids   = getIds();
  const scheduled = ids.map(i => EVENT_INDEX[i]).filter(Boolean);

  return ALL_EVENTS
    .filter(ev => (ev.title || '').trim() === title)
    .map(ev => {
      const inSched = ids.includes(ev.id);
      const cfls    = inSched ? [] : findConflicts(ev, scheduled);
      return {
        ...ev,
        _inSchedule: inSched,
        _conflicts:  cfls,
        _status: inSched ? 'in-schedule' : cfls.length ? 'conflict' : 'free',
      };
    })
    .sort((a, b) => {
      const sa = parseTime(a.start), sb = parseTime(b.start);
      return sa && sb ? sa - sb : 0;
    });
}

// ── Gap suggestions ───────────────────────────────────────────

/**
 * Compute free time windows for one convention day.
 * @param {string} dateKey  "07/30"
 * @param {object[]} scheduledEvents  Already-scheduled event objects.
 * @returns {Array<[Date, Date]>}  List of [gapStart, gapEnd] pairs.
 */
function getGapsForDay(dateKey, scheduledEvents) {
  const [mo, dy] = dateKey.split('/').map(Number);
  const wallStart = new Date(2026, mo - 1, dy, DAY_START_HOUR, 0);
  // DAY_END_HOUR = 24 → midnight = start of next day
  const wallEnd   = new Date(2026, mo - 1, dy + (DAY_END_HOUR >= 24 ? 1 : 0), DAY_END_HOUR % 24, 0);

  // Include events that overlap this day's wall window
  const dayEvs = scheduledEvents
    .map(ev => [parseTime(ev.start), parseTime(ev.end), ev])
    .filter(([s, e]) => s && e && s < wallEnd && e > wallStart)
    .sort((a, b) => a[0] - b[0]);

  const gaps = [];
  let cursor = new Date(wallStart);

  for (const [evS, evE] of dayEvs) {
    const gapS = new Date(Math.max(cursor, wallStart));
    const gapE = new Date(Math.min(evS,   wallEnd));
    if (gapE > gapS) gaps.push([gapS, gapE]);
    if (evE > cursor) cursor = new Date(evE);
  }
  if (cursor < wallEnd) gaps.push([new Date(Math.max(cursor, wallStart)), wallEnd]);

  return gaps;
}

/**
 * Find all unscheduled events that fit entirely in [gapStart, gapEnd]
 * on the given date, after applying optional filters.
 * Sorted by fill ratio (desc) then ticket availability (desc).
 */
function eventsForGap(gapStart, gapEnd, dateKey, scheduledIds, filters = {}) {
  const { type = '', system = '', minDur = 0, maxDur = 0, minTickets = 0 } = filters;
  const gapHours = (gapEnd - gapStart) / 3_600_000;

  return ALL_EVENTS
    .filter(ev => {
      if (scheduledIds.includes(ev.id)) return false;
      if ((ev.start || '').slice(0, 5) !== dateKey) return false;
      const s = parseTime(ev.start), e = parseTime(ev.end);
      if (!s || !e || s < gapStart || e > gapEnd) return false;
      if (type       && !(ev.type   || '').toLowerCase().includes(type.toLowerCase()))   return false;
      if (system     && !(ev.system || '').toLowerCase().includes(system.toLowerCase())) return false;
      if (minDur > 0 && (ev.duration || 0) < minDur)           return false;
      if (maxDur > 0 && (ev.duration || 0) > maxDur)           return false;
      if (minTickets > 0 && (ev.ticketsAvailable || 0) < minTickets) return false;
      return true;
    })
    .map(ev => ({ ...ev, _fillRatio: (ev.duration || 0) / gapHours }))
    .sort((a, b) => (b._fillRatio - a._fillRatio) || (b.ticketsAvailable - a.ticketsAvailable));
}

// Morning/afternoon/evening hour boundaries
const TIME_OF_DAY = {
  morning:   [6,  12],
  afternoon: [12, 18],
  evening:   [18, 24],
};

/**
 * Parse a day filter value that may include a time-of-day suffix.
 * "Thu-morning" → { day: "Thu", timeOfDay: "morning" }
 * "Fri"         → { day: "Fri", timeOfDay: null }
 */
function parseDayFilter(val) {
  if (!val) return { day: null, timeOfDay: null };
  const idx = val.indexOf('-');
  if (idx === -1) return { day: val, timeOfDay: null };
  return { day: val.slice(0, idx), timeOfDay: val.slice(idx + 1) };
}

/**
 * Collect suggestions for all relevant convention days.
 * @param {object} filters  Passed through to eventsForGap.
 * @param {string|null} dayFilter  Optional "Thu", "Fri-morning", etc.
 * @returns {Array<{ dateKey, dayLabel, gapStart, gapEnd, gapHours, events }>}
 */
function getSuggestions(filters = {}, dayFilter = null) {
  const { day, timeOfDay } = parseDayFilter(dayFilter);
  const ids          = getIds();
  const scheduledEvs = getScheduledEvents();
  const results      = [];

  for (const dateKey of CONV_DATES) {
    if (day) {
      const label = DAYS_MAP[dateKey] || '';
      if (!label.toLowerCase().startsWith(day.toLowerCase()) &&
          !dateKey.startsWith(day)) continue;
    }

    let gaps = getGapsForDay(dateKey, scheduledEvs);

    // Clip gaps to the selected time window
    if (timeOfDay && TIME_OF_DAY[timeOfDay]) {
      const [mo, dy] = dateKey.split('/').map(Number);
      const [startH, endH] = TIME_OF_DAY[timeOfDay];
      const winStart = new Date(2026, mo - 1, dy, startH, 0);
      const winEnd   = new Date(2026, mo - 1, dy + (endH >= 24 ? 1 : 0), endH % 24, 0);
      gaps = gaps
        .map(([s, e]) => [new Date(Math.max(s, winStart)), new Date(Math.min(e, winEnd))])
        .filter(([s, e]) => e > s);
    }

    for (const [gapStart, gapEnd] of gaps) {
      const gapHours = (gapEnd - gapStart) / 3_600_000;
      if (gapHours < 0.5) continue;

      const evs = eventsForGap(gapStart, gapEnd, dateKey, ids, filters);
      if (!evs.length) continue;

      results.push({
        dateKey,
        dayLabel: DAYS_MAP[dateKey] || dateKey,
        gapStart,
        gapEnd,
        gapHours,
        events: evs,
      });
    }
  }
  return results;
}

// ── Export / Import ───────────────────────────────────────────

function exportSchedule() {
  const ids    = getIds();
  const events = ids.map(id => EVENT_INDEX[id]).filter(Boolean);
  const blob   = new Blob([JSON.stringify({ events: ids, details: events }, null, 2)],
                          { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'gencon-schedule-2026.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

function importSchedule(jsonText) {
  const data = JSON.parse(jsonText);
  const ids  = Array.isArray(data) ? data
             : Array.isArray(data.events) ? data.events
             : null;
  if (!ids) throw new Error('Unrecognized schedule format');
  setIds(ids);
  return ids.length;
}

// ── UI helpers (shared) ───────────────────────────────────────

/** Show a brief toast notification */
function showToast(msg, type = 'ok') {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className   = `show toast-${type}`;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = ''; }, 2800);
}

/** Format availability with colour coding */
function fmtAvail(n) {
  const cls = n === 0 ? 'avail-low' : n <= 4 ? 'avail-low' : n <= 12 ? 'avail-med' : 'avail-good';
  return `<span class="${cls}">${n}</span>`;
}

/** Format cost as "$4" or "Free" */
function fmtCost(n) {
  return n > 0 ? `$${n % 1 === 0 ? n : n.toFixed(2)}` : 'Free';
}

/** Short event-type label: "RPG" from "RPG - Roleplaying Game" */
function shortType(type) {
  return (type || '').split(' - ')[0] || '';
}

// ── AI Suggest ────────────────────────────────────────────────

const AI_WORKER_URL = 'https://gencon-ai-proxy.armartin.workers.dev';

/** Extract GenCon event IDs from a text string, returning only those present in EVENT_INDEX. */
function extractEventIds(text) {
  const found = [];
  const seen  = new Set();
  const tokens = text.match(/\b[A-Z]{2,6}26[A-Z0-9]{2,}\b/g) || [];
  for (const token of tokens) {
    if (EVENT_INDEX[token] && !seen.has(token)) {
      found.push(token);
      seen.add(token);
    }
  }
  return found;
}

const AI_TOOLS = [
  {
    name: 'search_events',
    description: 'Search the GenCon event catalog. Returns up to `limit` matching events (default 20).',
    input_schema: {
      type: 'object',
      properties: {
        query:       { type: 'string',  description: 'Full-text search across title, description, game system, GM names' },
        event_type:  { type: 'string',  description: 'Filter by type prefix, e.g. "RPG", "BGM", "SEM", "TCG"' },
        day:         { type: 'string',  description: 'Filter by convention day: "Thu", "Fri", "Sat", or "Sun"' },
        system:      { type: 'string',  description: 'Filter by game system substring, e.g. "D&D", "Pathfinder"' },
        min_tickets: { type: 'integer', description: 'Minimum tickets available (use 1 to exclude sold-out events)' },
        min_dur:     { type: 'number',  description: 'Minimum event duration in hours' },
        max_dur:     { type: 'number',  description: 'Maximum event duration in hours' },
        limit:       { type: 'integer', description: 'Max results to return (default 20, max 50)' },
      },
    },
  },
  {
    name: 'get_event_details',
    description: 'Get full details for a specific event by its Game ID.',
    input_schema: {
      type: 'object',
      properties: {
        game_id: { type: 'string', description: 'The event Game ID, e.g. "RPG26ND300797"' },
      },
      required: ['game_id'],
    },
  },
  {
    name: 'get_alternatives',
    description: 'Get all available timeslots for the same event (same title) as the given Game ID. ' +
                 'Use this to find alternate times for a scheduled event, especially to resolve schedule conflicts.',
    input_schema: {
      type: 'object',
      properties: {
        game_id: { type: 'string', description: 'Game ID of the event whose alternative timeslots you want' },
      },
      required: ['game_id'],
    },
  },
];

function executeAiTool(name, input) {
  if (name === 'search_events') {
    const limit = Math.min(input.limit || 20, 50);
    const results = searchEvents({
      query:      input.query       || '',
      type:       input.event_type  || '',
      day:        input.day         || '',
      system:     input.system      || '',
      minTickets: input.min_tickets || 0,
      minDur:     input.min_dur     || 0,
      maxDur:     input.max_dur     || 0,
    }).slice(0, limit);

    if (!results.length) return 'No events found matching those criteria.';

    const scheduledIds = getIds();
    return JSON.stringify(results.map(ev => ({
      id:        ev.id,
      title:     ev.title,
      type:      ev.type,
      system:    ev.system,
      time:      fmtSlot(ev),
      duration:  ev.duration,
      cost:      ev.cost,
      tickets:   ev.ticketsAvailable,
      shortDesc: ev.shortDesc,
      scheduled: scheduledIds.includes(ev.id),
    })));
  }

  if (name === 'get_event_details') {
    const ev = EVENT_INDEX[input.game_id];
    if (!ev) return `Event ${input.game_id} not found.`;
    const scheduledIds = getIds();
    return JSON.stringify({
      id:          ev.id,
      title:       ev.title,
      type:        ev.type,
      system:      ev.system,
      time:        fmtSlot(ev),
      duration:    ev.duration,
      cost:        ev.cost,
      tickets:     ev.ticketsAvailable,
      gmNames:     ev.gmNames,
      location:    [ev.location, ev.roomName].filter(Boolean).join(' '),
      shortDesc:   ev.shortDesc,
      longDesc:    ev.longDesc,
      minPlayers:  ev.minPlayers,
      maxPlayers:  ev.maxPlayers,
      ageRequired: ev.ageRequired,
      experience:  ev.experienceRequired,
      scheduled:   scheduledIds.includes(ev.id),
    });
  }

  if (name === 'get_alternatives') {
    const alts = getAlternatives(input.game_id);
    if (!alts.length) return `No alternative timeslots found for event ${input.game_id}.`;
    return JSON.stringify(alts.map(a => ({
      id:              a.id,
      time:            fmtSlot(a),
      tickets:         a.ticketsAvailable,
      status:          a._status,        // "in-schedule" | "conflict" | "free"
      conflicts_with:  a._conflicts.map(c => ({ id: c.id, title: c.title, time: fmtSlot(c) })),
    })));
  }

  return `Unknown tool: ${name}`;
}

/**
 * Run the AI suggest agentic loop.
 * Pass `existingMessages` + `existingSystemPrompt` to continue a prior conversation.
 * onDone receives { messages, systemPrompt } so the caller can continue the thread.
 */
async function runAiSuggest(
  { count, day: rawDay, eventType, minDur = 0, maxDur = 0,
    existingMessages = null, existingSystemPrompt = null },
  onProgress, onText, onDone, onError,
) {
  let systemPrompt = existingSystemPrompt;
  let messages     = existingMessages;

  // First turn — build system prompt and initial user message
  if (!messages) {
    const scheduledEvents = getScheduledEvents();
    if (!scheduledEvents.length) {
      onError(new Error('No events scheduled yet — add some events first so I can learn your tastes.'));
      return;
    }

    // Detect conflicts upfront
    const conflictPairs = [];
    for (const ev of scheduledEvents) {
      const cfls = findConflicts(ev, scheduledEvents.filter(e => e.id !== ev.id));
      for (const c of cfls) {
        // Only record each pair once (lower id first)
        const key = [ev.id, c.id].sort().join('|');
        if (!conflictPairs.find(p => p.key === key)) {
          conflictPairs.push({ key, a: ev, b: c });
        }
      }
    }

    const scheduleDesc = scheduledEvents.map(ev => {
      const cfls = findConflicts(ev, scheduledEvents.filter(e => e.id !== ev.id));
      const conflictNote = cfls.length
        ? ` ⚠ CONFLICTS with: ${cfls.map(c => `${c.title} (${fmtSlot(c)})`).join(', ')}`
        : '';
      return `- [${ev.id}] ${ev.title} (${shortType(ev.type)}, ${fmtSlot(ev)})${ev.system ? `, ${ev.system}` : ''}${conflictNote}`;
    }).join('\n');

    const { day, timeOfDay } = parseDayFilter(rawDay);
    const TOD_DESC = { morning: 'before noon', afternoon: 'noon–6 PM', evening: '6 PM or later' };
    const dayDesc  = day ? day + (timeOfDay ? ` (${TOD_DESC[timeOfDay] || timeOfDay})` : '') : null;

    const conflictSection = conflictPairs.length
      ? `\n\n⚠ SCHEDULE CONFLICTS DETECTED (${conflictPairs.length}):\n` +
        conflictPairs.map(p => `- [${p.a.id}] ${p.a.title} (${fmtSlot(p.a)}) overlaps [${p.b.id}] ${p.b.title} (${fmtSlot(p.b)})`).join('\n')
      : '';

    systemPrompt =
      `You are a GenCon event planning assistant. The user has these events in their schedule:\n\n${scheduleDesc}${conflictSection}\n\n` +
      (conflictPairs.length
        ? `PRIORITY: The schedule has conflicts listed above. Before suggesting new events, you MUST address each conflict. ` +
          `For each conflicting pair, use get_alternatives to find other available timeslots for one or both events. ` +
          `Recommend which event to move and to which alternate timeslot (must have tickets > 0 and no new conflicts). ` +
          `Then, after resolving conflicts, `
        : `Based on their interests, `) +
      `use the search_events tool to find events they'd enjoy. ` +
      `Use get_event_details when you need more information about a specific event. ` +
      `Suggest exactly ${count} new events they don't already have scheduled` +
      (dayDesc    ? ` on ${dayDesc}`         : '') +
      (eventType  ? ` of type ${eventType}`  : '') +
      `. Only suggest events with tickets available (tickets > 0). ` +
      (timeOfDay  ? `Only suggest events that START ${TOD_DESC[timeOfDay] || timeOfDay}. ` : '') +
      (minDur > 0 ? `Only suggest events at least ${minDur}h long. ` : '') +
      (maxDur > 0 ? `Only suggest events no longer than ${maxDur}h. ` : '') +
      `For each suggestion include: Game ID, title, time, and a short reason why it fits their tastes.`;

    const conflictPreamble = conflictPairs.length
      ? `My schedule has ${conflictPairs.length} conflict${conflictPairs.length > 1 ? 's' : ''} — please resolve those first, then `
      : `Please `;

    const userMsg =
      conflictPreamble +
      `suggest ${count} events I'd enjoy based on my schedule` +
      (dayDesc    ? `, specifically on ${dayDesc}`           : '') +
      (eventType  ? `, preferably ${eventType} type events`  : '') +
      (minDur > 0 ? `, at least ${minDur}h long`            : '') +
      (maxDur > 0 ? `, no longer than ${maxDur}h`           : '') +
      `.`;

    messages = [{ role: 'user', content: userMsg }];
  }

  try {
    for (let i = 0; i < 12; i++) {
      const response = await fetch(AI_WORKER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model:    'claude-opus-4-6',
          max_tokens: 4096,
          system:   systemPrompt,
          tools:    AI_TOOLS,
          thinking: { type: 'adaptive' },
          messages,
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Worker error ${response.status}: ${text}`);
      }

      const data = await response.json();
      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));

      messages.push({ role: 'assistant', content: data.content });

      if (data.stop_reason === 'end_turn') {
        for (const block of data.content) {
          if (block.type === 'text') onText(block.text);
        }
        onDone({ messages, systemPrompt });
        return;
      }

      if (data.stop_reason === 'tool_use') {
        const toolResults = [];
        for (const block of data.content) {
          if (block.type !== 'tool_use') continue;
          const label = block.name === 'search_events'
            ? `Searching: ${Object.entries(block.input).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}`
            : block.name === 'get_alternatives'
            ? `Finding alternate timeslots for: ${block.input.game_id}`
            : `Getting details: ${block.input.game_id}`;
          onProgress(label);
          const result = executeAiTool(block.name, block.input);
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
        }
        messages.push({ role: 'user', content: toolResults });
      }
    }
    onError(new Error('Stopped after too many tool-call iterations'));
  } catch (err) {
    onError(err);
  }
}

// ── AI Alternate Schedules ────────────────────────────────────

/**
 * Ask Claude to suggest alternate schedule configurations by swapping events
 * to different available timeslots with open tickets.
 * @param {{ count }} opts
 * @param {function(string)} onProgress
 * @param {function(Array)}  onDone   receives array of schedule suggestions
 * @param {function(Error)}  onError
 */
async function runAiAlternates({ count = 3 }, onProgress, onDone, onError) {
  const scheduledEvents = getScheduledEvents();
  if (!scheduledEvents.length) {
    onError(new Error('No events scheduled yet.'));
    return;
  }

  // Gather alternatives for each scheduled event (same title, different time, tickets available)
  const evData = scheduledEvents.map(ev => ({
    ev,
    alts: getAlternatives(ev.id).filter(a => !a._inSchedule && a.ticketsAvailable > 0),
  }));

  if (!evData.some(d => d.alts.length > 0)) {
    onError(new Error('None of your scheduled events have alternative time slots available with open tickets.'));
    return;
  }

  const schedDesc = evData.map(({ ev, alts }) => {
    let s = `• "${ev.title}" — ${fmtSlot(ev)} [ID: ${ev.id}]`;
    if (alts.length) {
      s += '\n  Available alternatives:';
      for (const a of alts) {
        s += `\n    - ${fmtSlot(a)} [ID: ${a.id}, ${a.ticketsAvailable} ticket${a.ticketsAvailable === 1 ? '' : 's'}]`;
      }
    } else {
      s += '\n  (no alternatives available)';
    }
    return s;
  }).join('\n\n');

  onProgress('Analyzing schedule alternatives…');

  try {
    const resp = await fetch(AI_WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 4096,
        system:
          'You are a GenCon scheduling assistant. Analyze the schedule and suggest improved ' +
          'alternate configurations by swapping events to different available time slots. ' +
          'Focus on reducing conflicts, improving day flow, and giving the user variety.',
        tool_choice: { type: 'tool', name: 'submit_schedules' },
        tools: [{
          name: 'submit_schedules',
          description: 'Submit the suggested alternate schedule configurations',
          input_schema: {
            type: 'object',
            required: ['schedules'],
            properties: {
              schedules: {
                type: 'array',
                description: `Array of ${count} distinct alternate schedule suggestions`,
                items: {
                  type: 'object',
                  required: ['description', 'changes'],
                  properties: {
                    description: {
                      type: 'string',
                      description: 'Brief description of this variation and why it improves the schedule',
                    },
                    changes: {
                      type: 'array',
                      description: 'Events being swapped to a different time (only list events that change)',
                      items: {
                        type: 'object',
                        required: ['original_id', 'replacement_id', 'reason'],
                        properties: {
                          original_id:    { type: 'string', description: 'Game ID currently in schedule' },
                          replacement_id: { type: 'string', description: 'Game ID of the replacement timeslot' },
                          reason:         { type: 'string', description: 'Why this swap improves the schedule' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        }],
        messages: [{
          role: 'user',
          content:
            `Here is my current GenCon schedule with available alternatives:\n\n${schedDesc}\n\n` +
            `Please suggest ${count} distinct alternate schedule configurations. ` +
            `For each, swap one or more events to different available timeslots to improve flow or reduce conflicts. ` +
            `Only use Game IDs listed above. Make each suggestion meaningfully different from the others.`,
        }],
      }),
    });

    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`Worker error ${resp.status}: ${txt}`);
    }
    const data = await resp.json();
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));

    const toolUse = data.content.find(b => b.type === 'tool_use' && b.name === 'submit_schedules');
    if (!toolUse) throw new Error('No structured response received from AI');

    onDone(toolUse.input.schedules || []);
  } catch (err) {
    onError(err);
  }
}
