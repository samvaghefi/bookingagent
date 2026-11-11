'use strict';

/**
 * availabilityService — one source of truth for "is this time free?"
 *
 * Used by phone calls (Vapi checkAvailability / bookAppointment), the public
 * booking page, and the dashboard calendar. A time is free when it is:
 *   - inside the opening hours from Settings → Hours
 *   - not in the past
 *   - not covered by blocked time (Settings → Calendar)
 *   - not busy in Google Calendar (when connected)
 *   - and a team member is free once existing bookings are counted
 *
 * The decision logic (computeDay) is pure and unit-tested. The loaders around
 * it fetch data and fail open on Google errors, so a calendar outage never
 * stops a shop from taking bookings.
 */

const { createClient } = require('@supabase/supabase-js');
const { DateTime } = require('luxon');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const DAY_KEYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const DEFAULT_TZ = 'America/Toronto';
const DEFAULT_DURATION = 30;
const SLOT_STEP = 30;
// What Settings → Hours shows (and saves) for a day with nothing stored yet.
// Must match DEFAULT_HOURS in dashboard/app.jsx so the owner, the AI and the
// booking page all agree.
const DEFAULT_DAY_HOURS = { open: '09:00', close: '18:00', closed: false };

// ── Small helpers ─────────────────────────────────────────────────────────────

function norm(name) {
  return String(name || '').trim().toLowerCase();
}

// "14:30", "14:30:00", "2:30 PM", "2pm", "9 am" → minutes since midnight (or null)
function parseTime(input) {
  if (input == null) return null;
  const s = String(input).trim().toLowerCase().replace(/\./g, '');
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(am|pm|a|p)?$/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const ap = m[3];
  if (min > 59) return null;
  if (ap) {
    if (h < 1 || h > 12) return null;
    if (ap.startsWith('p') && h < 12) h += 12;
    if (ap.startsWith('a') && h === 12) h = 0;
  } else if (h > 23) return null;
  return h * 60 + min;
}

function toHHMM(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// 870 → "2:30 PM"
function spokenTime(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const ap = h >= 12 && h < 24 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return m ? `${h12}:${String(m).padStart(2, '0')} ${ap}` : `${h12} ${ap}`;
}

function spokenDate(date, tz) {
  return DateTime.fromISO(date, { zone: tz }).setLocale('en-CA').toFormat('cccc, LLLL d');
}

// "2026-11-14", "today", "tomorrow" → ISO date in the shop's time zone (or null)
function parseDate(input, tz) {
  const now = DateTime.now().setZone(tz);
  const s = String(input || '').trim().toLowerCase();
  if (s === 'today') return now.toISODate();
  if (s === 'tomorrow') return now.plus({ days: 1 }).toISODate();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s) && DateTime.fromISO(s).isValid) return s;
  return null;
}

function normalizeMembers(business) {
  const raw = business.team_members || business.barbers || [];
  return raw
    .map(m => (typeof m === 'string' ? { name: m, calendarId: '' } : { calendarId: '', ...m }))
    .filter(m => m && m.name);
}

function findMember(members, name) {
  if (!name) return null;
  const n = norm(name);
  if (!n || ['anyone', 'any', 'no preference', 'none', 'whoever'].includes(n)) return null;
  return members.find(m => norm(m.name) === n)
    || members.find(m => norm(m.name).split(/\s+/)[0] === n.split(/\s+/)[0])
    || null;
}

// Service length from the shop's menu (exact name first, then partial match)
function serviceDuration(services, serviceName) {
  if (!serviceName) return DEFAULT_DURATION;
  const n = norm(Array.isArray(serviceName) ? serviceName[0] : serviceName);
  const list = services || [];
  const hit = list.find(s => norm(s.name) === n)
    || list.find(s => n && (norm(s.name).includes(n) || n.includes(norm(s.name))));
  const d = hit && parseInt(hit.duration_minutes, 10);
  return d > 0 ? d : DEFAULT_DURATION;
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

// ── Blocked time: expand stored rules onto one date ──────────────────────────
// Returns [{ start, end, member }] in minutes for that date (member null = whole shop)
function blocksForDate(blockRows, date, tz) {
  const weekday = DateTime.fromISO(date, { zone: tz }).weekday; // 1=Mon..7=Sun
  const out = [];
  for (const b of blockRows || []) {
    if (b.start_date && date < b.start_date) continue;
    if (b.end_date && date > b.end_date) continue;
    if (b.repeat === 'weekly' && !(b.weekdays || []).map(Number).includes(weekday)) continue;
    const allDay = !b.start_time || !b.end_time;
    out.push({
      id: b.id,
      start: allDay ? 0 : parseTime(b.start_time),
      end: allDay ? 24 * 60 : parseTime(b.end_time),
      member: b.team_member || null,
      note: b.note || '',
      allDay,
    });
  }
  return out;
}

// ── The decision (pure) ───────────────────────────────────────────────────────
/**
 * @param {object} p
 * @param {object} p.dayHours      { open:'09:00', close:'18:00', closed:false } or undefined
 * @param {Array}  p.members       [{ name }]  (empty = single-person shop)
 * @param {Array}  p.bookings      [{ start, end, member }] minutes; member null = anyone
 * @param {Array}  p.blocks        [{ start, end, member }] minutes; member null = whole shop
 * @param {Array}  p.busy          [{ start, end, member }] Google busy; member null = whole shop
 * @param {number|null} p.nowMinutes  minutes now if the date is today, -1 if in the past, null if future
 * @param {number} p.duration      minutes needed
 * @param {string} [p.teamMember]  requested member name
 * @param {number} [p.step]        slot spacing in minutes
 * @param {number} [p.at]          check only this start time (minutes)
 */
function computeDay(p) {
  const dayHours = p.dayHours;
  if (!dayHours || dayHours.closed || !dayHours.open || !dayHours.close) {
    return { closed: true, slots: [] };
  }
  const open = parseTime(dayHours.open);
  const close = parseTime(dayHours.close);
  if (open == null || close == null || close <= open) return { closed: true, slots: [] };

  const duration = Math.max(5, p.duration || DEFAULT_DURATION);
  const members = (p.members && p.members.length) ? p.members : [{ name: null }];
  const memberKey = m => norm(m.name);
  const known = new Set(members.map(memberKey));
  const requested = p.teamMember ? findMember(members, p.teamMember) : null;

  const shopWide = [...(p.blocks || []), ...(p.busy || [])].filter(x => !x.member);
  const perMember = [...(p.blocks || []), ...(p.busy || [])].filter(x => x.member);

  const evaluate = start => {
    const end = start + duration;
    if (start < open || end > close) return { available: false, reason: 'outside_hours' };
    if (p.nowMinutes === -1 || (p.nowMinutes != null && start <= p.nowMinutes)) return { available: false, reason: 'past' };
    if (shopWide.some(x => overlaps(start, end, x.start, x.end))) return { available: false, reason: 'blocked' };

    const free = members.filter(m => {
      const key = memberKey(m);
      if (perMember.some(x => norm(x.member) === key && overlaps(start, end, x.start, x.end))) return false;
      if ((p.bookings || []).some(b => b.member && norm(b.member) === key && overlaps(start, end, b.start, b.end))) return false;
      return true;
    });
    // Bookings with no team member (or one no longer on the team) each need someone
    const unassigned = (p.bookings || []).filter(b =>
      (!b.member || !known.has(norm(b.member))) && overlaps(start, end, b.start, b.end)).length;

    if (requested) {
      const isFree = free.some(m => memberKey(m) === memberKey(requested));
      if (!isFree) return { available: false, reason: 'member_busy' };
      if (free.length - 1 < unassigned) return { available: false, reason: 'busy' };
      return { available: true, freeMembers: [requested.name] };
    }
    if (free.length <= unassigned) return { available: false, reason: 'busy' };
    return { available: true, freeMembers: free.map(m => m.name).filter(Boolean) };
  };

  if (p.at != null) {
    return { closed: false, open, close, duration, check: { time: toHHMM(p.at), minutes: p.at, ...evaluate(p.at) } };
  }

  const step = p.step || SLOT_STEP;
  const slots = [];
  for (let t = open; t + duration <= close; t += step) {
    slots.push({ time: toHHMM(t), minutes: t, ...evaluate(t) });
  }
  return { closed: false, open, close, duration, slots };
}

// ── Google Calendar busy times ────────────────────────────────────────────────
// Busy times from the shop's connected Google account, for a date range.
// Events Bimbly created for its own bookings are skipped (the booking already
// counts). Returns [{ start: DateTime, end: DateTime, member }]. Fails open.
async function loadGoogleBusy(business, members, fromDate, toDate, tz) {
  if (!business.google_access_token || !business.google_refresh_token) return [];
  const { getCalendarClient } = require('./calendarService');
  const timeMin = DateTime.fromISO(fromDate, { zone: tz }).startOf('day');
  const timeMax = DateTime.fromISO(toDate, { zone: tz }).endOf('day');

  const memberCals = members.filter(m => m.calendarId && m.calendarId !== 'primary');
  // The connected (primary) calendar belongs to the owner. If nobody on the
  // team has their own calendar, treat it as the whole shop's calendar.
  const primaryMember = memberCals.length ? (members[0] ? members[0].name : null) : null;

  const out = [];
  try {
    const calendar = await getCalendarClient(business);

    const { data: bookingRows } = await supabase
      .from('bookings')
      .select('google_calendar_event_id')
      .eq('business_id', business.id)
      .gte('appointment_date', fromDate)
      .lte('appointment_date', toDate)
      .not('google_calendar_event_id', 'is', null);
    const ownEvents = new Set((bookingRows || []).map(r => r.google_calendar_event_id));

    let pageToken;
    do {
      const res = await calendar.events.list({
        calendarId: 'primary',
        timeMin: timeMin.toISO(),
        timeMax: timeMax.toISO(),
        singleEvents: true,
        maxResults: 250,
        pageToken,
        fields: 'nextPageToken,items(id,status,transparency,start,end,extendedProperties)',
      });
      for (const ev of res.data.items || []) {
        if (ev.status === 'cancelled' || ev.transparency === 'transparent') continue;
        if (ownEvents.has(ev.id) || ev.extendedProperties?.private?.bimblyBookingId) continue;
        const start = ev.start?.dateTime
          ? DateTime.fromISO(ev.start.dateTime).setZone(tz)
          : DateTime.fromISO(ev.start?.date, { zone: tz }).startOf('day');
        const end = ev.end?.dateTime
          ? DateTime.fromISO(ev.end.dateTime).setZone(tz)
          : DateTime.fromISO(ev.end?.date, { zone: tz }).startOf('day');
        if (start.isValid && end.isValid) out.push({ start, end, member: primaryMember });
      }
      pageToken = res.data.nextPageToken;
    } while (pageToken);

    if (memberCals.length) {
      const fb = await calendar.freebusy.query({
        requestBody: { timeMin: timeMin.toISO(), timeMax: timeMax.toISO(), items: memberCals.map(m => ({ id: m.calendarId })) },
      });
      for (const m of memberCals) {
        for (const b of fb.data.calendars?.[m.calendarId]?.busy || []) {
          out.push({ start: DateTime.fromISO(b.start).setZone(tz), end: DateTime.fromISO(b.end).setZone(tz), member: m.name });
        }
      }
    }
  } catch (err) {
    console.warn(`⚠️  Google Calendar check failed for ${business.id} (continuing without it):`, err.message);
  }
  return out;
}

// Clip DateTime intervals to one date → minutes on that date
function intervalsForDate(intervals, date, tz) {
  const dayStart = DateTime.fromISO(date, { zone: tz }).startOf('day');
  const dayEnd = dayStart.plus({ days: 1 });
  const out = [];
  for (const iv of intervals) {
    if (iv.end <= dayStart || iv.start >= dayEnd) continue;
    const s = iv.start < dayStart ? 0 : Math.round(iv.start.diff(dayStart, 'minutes').minutes);
    const e = iv.end > dayEnd ? 24 * 60 : Math.round(iv.end.diff(dayStart, 'minutes').minutes);
    if (e > s) out.push({ start: s, end: e, member: iv.member || null });
  }
  return out;
}

// ── Loader: everything needed for a date range, fetched once ──────────────────
async function loadContext(business, fromDate, toDate, { includeGoogle = true } = {}) {
  const tz = business.timezone || DEFAULT_TZ;
  const members = normalizeMembers(business);

  const [{ data: services }, { data: bookings, error: bookingsErr }, blocksRes] = await Promise.all([
    supabase.from('services').select('name, duration_minutes').eq('business_id', business.id),
    supabase.from('bookings')
      .select('id, customer_name, appointment_date, appointment_time, duration_minutes, preferred_barber, service_ids, status')
      .eq('business_id', business.id)
      .gte('appointment_date', fromDate)
      .lte('appointment_date', toDate),
    supabase.from('calendar_blocks')
      .select('*')
      .eq('business_id', business.id)
      .lte('start_date', toDate),
  ]);
  if (bookingsErr) throw bookingsErr;
  // Table may not exist yet (migration not applied) — carry on without blocks
  const blockRows = blocksRes.error ? [] : (blocksRes.data || []).filter(b => !b.end_date || b.end_date >= fromDate);

  const active = (bookings || []).filter(b => !['cancelled', 'canceled', 'no-show', 'no_show'].includes(norm(b.status)));
  const google = includeGoogle ? await loadGoogleBusy(business, members, fromDate, toDate, tz) : [];

  return { business, tz, members, services: services || [], bookings: active, blockRows, google };
}

function dayInputs(ctx, date) {
  const { tz, business } = ctx;
  const weekday = DateTime.fromISO(date, { zone: tz }).weekday;
  const now = DateTime.now().setZone(tz);
  const today = now.toISODate();
  const nowMinutes = date < today ? -1 : date === today ? now.hour * 60 + now.minute : null;

  const bookings = ctx.bookings
    .filter(b => b.appointment_date === date && b.appointment_time)
    .map(b => {
      const start = parseTime(String(b.appointment_time).slice(0, 5));
      const dur = parseInt(b.duration_minutes, 10) > 0 ? parseInt(b.duration_minutes, 10) : serviceDuration(ctx.services, b.service_ids);
      return { id: b.id, start, end: start + dur, member: b.preferred_barber || null, name: b.customer_name, service: Array.isArray(b.service_ids) ? b.service_ids.join(', ') : b.service_ids };
    })
    .filter(b => b.start != null);

  return {
    dayHours: (business.business_hours || {})[DAY_KEYS[weekday - 1]] || DEFAULT_DAY_HOURS,
    members: ctx.members,
    bookings,
    blocks: blocksForDate(ctx.blockRows, date, tz),
    busy: intervalsForDate(ctx.google, date, tz),
    nowMinutes,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

// All slots for one date. opts: { durationMinutes, service, teamMember, step }
async function getDayAvailability(business, date, opts = {}) {
  const ctx = opts.ctx || await module.exports.loadContext(business, date, date);
  const duration = opts.durationMinutes || serviceDuration(ctx.services, opts.service);
  return { date, timezone: ctx.tz, ...computeDay({ ...dayInputs(ctx, date), duration, teamMember: opts.teamMember, step: opts.step }) };
}

// Check one start time. Returns { available, reason, duration, alternatives }
async function checkSlot(business, { date, time, service, teamMember, durationMinutes }) {
  const tz = business.timezone || DEFAULT_TZ;
  const at = parseTime(time);
  const ctx = await module.exports.loadContext(business, date, DateTime.fromISO(date, { zone: tz }).plus({ days: 7 }).toISODate());
  const duration = durationMinutes || serviceDuration(ctx.services, service);
  const day = computeDay({ ...dayInputs(ctx, date), duration, teamMember, at: at == null ? -9999 : at });
  const check = day.closed ? { available: false, reason: 'closed' } : day.check;
  const alternatives = check.available ? [] : findAlternatives(ctx, date, at, duration, teamMember);
  return { date, time: at == null ? null : toHHMM(at), duration, timezone: tz, ...check, alternatives };
}

// Nearest free times on the same day, else the first free times in the next 7 days
function findAlternatives(ctx, date, at, duration, teamMember, count = 3) {
  const same = computeDay({ ...dayInputs(ctx, date), duration, teamMember });
  const free = (same.slots || []).filter(s => s.available);
  if (free.length) {
    const target = at == null ? 0 : at;
    return free
      .sort((a, b) => Math.abs(a.minutes - target) - Math.abs(b.minutes - target))
      .slice(0, count)
      .sort((a, b) => a.minutes - b.minutes)
      .map(s => ({ date, time: s.time, minutes: s.minutes }));
  }
  for (let i = 1; i <= 7; i++) {
    const d = DateTime.fromISO(date, { zone: ctx.tz }).plus({ days: i }).toISODate();
    const day = computeDay({ ...dayInputs(ctx, d), duration, teamMember });
    const open = (day.slots || []).filter(s => s.available);
    if (open.length) return open.slice(0, count).map(s => ({ date: d, time: s.time, minutes: s.minutes }));
  }
  return [];
}

// Group free start times into spoken ranges: "9 AM to 11:30 AM, and 2 PM to 5 PM"
function describeRanges(slots, step = SLOT_STEP) {
  const free = slots.filter(s => s.available).map(s => s.minutes);
  if (!free.length) return '';
  const ranges = [];
  let start = free[0];
  let prev = free[0];
  for (const m of free.slice(1)) {
    if (m - prev > step) { ranges.push([start, prev]); start = m; }
    prev = m;
  }
  ranges.push([start, prev]);
  const parts = ranges.map(([a, b]) => (a === b ? spokenTime(a) : `${spokenTime(a)} to ${spokenTime(b)}`));
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}` : parts[0];
}

module.exports = {
  // pure
  computeDay, blocksForDate, intervalsForDate, parseTime, parseDate, toHHMM, spokenTime, spokenDate,
  serviceDuration, findMember, normalizeMembers, describeRanges, DAY_KEYS, DEFAULT_TZ, DEFAULT_DAY_HOURS,
  // data
  loadContext, dayInputs, getDayAvailability, checkSlot, findAlternatives,
};
