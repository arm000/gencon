// ============================================================
//  GenCon 2026 Event Planner — shared application logic
// ============================================================

// ── Configuration ────────────────────────────────────────────
const EVENTS_JSON_URL = 'events.json';
const STORAGE_KEY     = 'gencon-schedule-2026';
const CONV_DATES      = ['07/30', '07/31', '08/01', '08/02', '08/03'];
const DAYS_MAP        = { '07/30': 'Thu', '07/31': 'Fri', '08/01': 'Sat', '08/02': 'Sun', '08/03': 'Mon' };
const DAY_DATES       = { 'Thu': '07/30', 'Fri': '07/31', 'Sat': '08/01', 'Sun': '08/02', 'Mon': '08/03' };
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
    // Day: match against "Thu" or date prefix "07/30"
    if (day) {
      const prefix   = (ev.start || '').slice(0, 5);
      const dayLabel = DAYS_MAP[prefix] || '';
      if (!dayLabel.toLowerCase().startsWith(day.toLowerCase()) &&
          !prefix.startsWith(day)) return false;
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

/**
 * Collect suggestions for all relevant convention days.
 * @param {object} filters  Passed through to eventsForGap.
 * @param {string|null} dayFilter  Optional day label or date prefix to restrict.
 * @returns {Array<{ dateKey, dayLabel, gapStart, gapEnd, gapHours, events }>}
 */
function getSuggestions(filters = {}, dayFilter = null) {
  const ids           = getIds();
  const scheduledEvs  = getScheduledEvents();
  const results       = [];

  for (const dateKey of CONV_DATES) {
    if (dayFilter) {
      const label = DAYS_MAP[dateKey] || '';
      if (!label.toLowerCase().startsWith(dayFilter.toLowerCase()) &&
          !dateKey.startsWith(dayFilter)) continue;
    }

    const gaps = getGapsForDay(dateKey, scheduledEvs);
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
