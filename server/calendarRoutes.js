'use strict';

// Dashboard calendar: Google Calendar connection, blocked time, and the week view.
// All routes require a signed-in shop (authMiddleware).

const express = require('express');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const { DateTime } = require('luxon');
const authMiddleware = require('./authMiddleware');
const { getAuthUrl, revokeTokens } = require('./calendarService');
const availability = require('./availabilityService');

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const NOT_MIGRATED = 'Blocked time is being set up. Please try again in a few minutes.';
const isMissingTable = err => err && /calendar_blocks|relation .* does not exist|schema cache/i.test(err.message || '');

// ── Google Calendar connection ────────────────────────────────────────────────

router.get('/api/calendar/status', authMiddleware, (req, res) => {
  const b = req.business;
  res.json({
    connected: !!(b.google_access_token && b.google_refresh_token),
    email: b.google_calendar_email || null,
  });
});

// Returns the Google consent URL. The state is signed and expires, so the
// callback knows which shop is connecting and nobody can forge it.
router.post('/api/calendar/connect', authMiddleware, (req, res) => {
  if (!process.env.JWT_SECRET || !process.env.GOOGLE_CLIENT_ID) {
    return res.status(500).json({ error: 'Google Calendar is not available right now.' });
  }
  const token = jwt.sign({ businessId: req.business.id, purpose: 'calendar-connect' }, process.env.JWT_SECRET, { expiresIn: '15m' });
  res.json({ url: getAuthUrl(`cal.${token}`, { loginHint: req.business.email }) });
});

router.delete('/api/calendar/connection', authMiddleware, async (req, res) => {
  try {
    await revokeTokens(req.business);
    const cleared = { google_access_token: null, google_refresh_token: null, google_token_expiry: null };
    let { error } = await supabase.from('businesses').update({ ...cleared, google_calendar_email: null }).eq('id', req.business.id);
    if (error && /google_calendar_email/.test(error.message || '')) {
      ({ error } = await supabase.from('businesses').update(cleared).eq('id', req.business.id));
    }
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/calendar/connection error:', err.message);
    res.status(500).json({ error: 'Could not disconnect Google Calendar. Please try again.' });
  }
});

// ── Blocked time ──────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// Validate a block from the dashboard. Returns { error } or { values }.
function validateBlock(body, members) {
  const b = body || {};
  const repeat = b.repeat === 'weekly' ? 'weekly' : 'none';
  if (!DATE_RE.test(b.start_date || '')) return { error: 'Choose a start date.' };
  let endDate = b.end_date || null;
  if (repeat === 'none' && !endDate) endDate = b.start_date;
  if (endDate && !DATE_RE.test(endDate)) return { error: 'Choose a valid end date.' };
  if (endDate && endDate < b.start_date) return { error: 'The end date must be on or after the start date.' };
  if (endDate && DateTime.fromISO(endDate).diff(DateTime.fromISO(b.start_date), 'days').days > 366) {
    return { error: 'Blocked time can cover up to a year.' };
  }

  const allDay = !!b.all_day || (!b.start_time && !b.end_time);
  let startTime = null;
  let endTime = null;
  if (!allDay) {
    if (!TIME_RE.test(b.start_time || '') || !TIME_RE.test(b.end_time || '')) return { error: 'Choose a start and end time.' };
    if (b.end_time <= b.start_time) return { error: 'The end time must be after the start time.' };
    startTime = b.start_time;
    endTime = b.end_time;
  }

  let weekdays = [];
  if (repeat === 'weekly') {
    weekdays = [...new Set((Array.isArray(b.weekdays) ? b.weekdays : []).map(Number))].filter(d => d >= 1 && d <= 7).sort();
    if (!weekdays.length) return { error: 'Pick at least one day of the week.' };
  }

  let teamMember = null;
  if (b.team_member) {
    const m = availability.findMember(members, b.team_member);
    if (!m) return { error: 'That team member is not on your team.' };
    teamMember = m.name;
  }

  const note = b.note ? String(b.note).trim().slice(0, 120) : null;
  return {
    values: { repeat, start_date: b.start_date, end_date: endDate, weekdays, start_time: startTime, end_time: endTime, team_member: teamMember, note },
  };
}

router.get('/api/calendar/blocks', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('calendar_blocks')
    .select('*')
    .eq('business_id', req.business.id)
    .order('start_date', { ascending: true });
  if (error) {
    if (isMissingTable(error)) return res.json({ blocks: [], setupPending: true });
    console.error('GET /api/calendar/blocks error:', error.message);
    return res.status(500).json({ error: 'Could not load blocked time.' });
  }
  res.json({ blocks: data || [] });
});

router.post('/api/calendar/blocks', authMiddleware, async (req, res) => {
  const { error: invalid, values } = validateBlock(req.body, availability.normalizeMembers(req.business));
  if (invalid) return res.status(400).json({ error: invalid });
  const { data, error } = await supabase
    .from('calendar_blocks')
    .insert({ ...values, business_id: req.business.id })
    .select()
    .single();
  if (error) {
    console.error('POST /api/calendar/blocks error:', error.message);
    return res.status(isMissingTable(error) ? 503 : 500).json({ error: isMissingTable(error) ? NOT_MIGRATED : 'Could not save blocked time.' });
  }
  res.status(201).json({ block: data });
});

router.put('/api/calendar/blocks/:id', authMiddleware, async (req, res) => {
  const { error: invalid, values } = validateBlock(req.body, availability.normalizeMembers(req.business));
  if (invalid) return res.status(400).json({ error: invalid });
  const { data, error } = await supabase
    .from('calendar_blocks')
    .update(values)
    .eq('id', req.params.id)
    .eq('business_id', req.business.id)
    .select()
    .maybeSingle();
  if (error) {
    console.error('PUT /api/calendar/blocks error:', error.message);
    return res.status(500).json({ error: 'Could not save blocked time.' });
  }
  if (!data) return res.status(404).json({ error: 'Blocked time not found.' });
  res.json({ block: data });
});

router.delete('/api/calendar/blocks/:id', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('calendar_blocks')
    .delete()
    .eq('id', req.params.id)
    .eq('business_id', req.business.id)
    .select('id');
  if (error) {
    console.error('DELETE /api/calendar/blocks error:', error.message);
    return res.status(500).json({ error: 'Could not remove blocked time.' });
  }
  if (!data || !data.length) return res.status(404).json({ error: 'Blocked time not found.' });
  res.json({ success: true });
});

// ── Week view ─────────────────────────────────────────────────────────────────
// GET /api/calendar/week?start=YYYY-MM-DD → 7 days of hours, bookings, blocks, Google busy
router.get('/api/calendar/week', authMiddleware, async (req, res) => {
  const business = req.business;
  const tz = business.timezone || availability.DEFAULT_TZ;
  const start = DATE_RE.test(req.query.start || '')
    ? req.query.start
    : DateTime.now().setZone(tz).startOf('week').toISODate();
  const end = DateTime.fromISO(start, { zone: tz }).plus({ days: 6 }).toISODate();

  try {
    const ctx = await availability.loadContext(business, start, end);
    const days = [];
    for (let i = 0; i < 7; i++) {
      const date = DateTime.fromISO(start, { zone: tz }).plus({ days: i }).toISODate();
      const d = availability.dayInputs(ctx, date);
      const h = d.dayHours || {};
      days.push({
        date,
        hours: { open: h.open || null, close: h.close || null, closed: !!h.closed || !h.open || !h.close },
        bookings: d.bookings.map(b => ({ id: b.id, start: b.start, end: b.end, member: b.member, name: b.name, service: b.service })),
        blocks: d.blocks,
        busy: d.busy,
      });
    }
    res.json({
      start,
      timezone: tz,
      today: DateTime.now().setZone(tz).toISODate(),
      google: { connected: !!(business.google_access_token && business.google_refresh_token) },
      members: ctx.members.map(m => m.name),
      days,
    });
  } catch (err) {
    console.error('GET /api/calendar/week error:', err.message);
    res.status(500).json({ error: 'Could not load your calendar.' });
  }
});

module.exports = router;
module.exports.validateBlock = validateBlock;
