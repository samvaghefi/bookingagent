'use strict';

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const authMiddleware = require('./authMiddleware');

const router   = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ── CSV helpers ───────────────────────────────────────────────────────────────

function escapeCell(value) {
  const str = value == null ? '' : String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function toCSV(headers, rows) {
  const lines = [headers.map(escapeCell).join(',')];
  for (const row of rows) {
    lines.push(row.map(escapeCell).join(','));
  }
  return lines.join('\n');
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// ── Plan gate ─────────────────────────────────────────────────────────────────

async function requireExportPlan(req, res, next) {
  const { data: business } = await supabase
    .from('businesses')
    .select('plan, booking_slug')
    .eq('id', req.business.id)
    .single();

  if (!business || business.plan === 'solo') {
    return res.status(403).json({ error: 'CSV export requires a Starter or Pro plan. Please upgrade.' });
  }

  req.exportBusiness = business;
  next();
}

// ── GET /api/export/bookings ──────────────────────────────────────────────────

router.get('/api/export/bookings', authMiddleware, requireExportPlan, async (req, res) => {
  try {
    const { data: bookings } = await supabase
      .from('bookings')
      .select('appointment_date, appointment_time, customer_name, customer_phone, service_ids, preferred_barber, special_requests, deposit_status, reminder_sent, created_at')
      .eq('business_id', req.business.id)
      .order('appointment_date', { ascending: false })
      .order('appointment_time', { ascending: false });

    const headers = ['Date', 'Time', 'Customer Name', 'Phone', 'Service', 'Team Member', 'Special Requests', 'Deposit Status', 'Reminder Sent', 'Created At'];

    const rows = (bookings || []).map(b => [
      b.appointment_date || '',
      (b.appointment_time || '').slice(0, 5), // HH:MM
      b.customer_name || '',
      b.customer_phone || '',
      Array.isArray(b.service_ids) ? b.service_ids.join('; ') : (b.service_ids || ''),
      b.preferred_barber || '',
      b.special_requests || '',
      b.deposit_status || '',
      b.reminder_sent ? 'Yes' : 'No',
      b.created_at ? b.created_at.slice(0, 10) : '',
    ]);

    const slug     = req.exportBusiness.booking_slug || req.business.id;
    const filename = `bookings-${slug}-${today()}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(toCSV(headers, rows));
  } catch (err) {
    console.error('GET /api/export/bookings error:', err.message);
    res.status(500).json({ error: 'Export failed.' });
  }
});

// ── GET /api/export/clients ───────────────────────────────────────────────────

router.get('/api/export/clients', authMiddleware, requireExportPlan, async (req, res) => {
  try {
    const [{ data: clients }, { data: bookings }] = await Promise.all([
      supabase.from('clients').select('*').eq('business_id', req.business.id).order('name'),
      supabase.from('bookings')
        .select('customer_phone, appointment_date, service_ids, preferred_barber')
        .eq('business_id', req.business.id),
    ]);

    // Compute per-phone stats from bookings
    const stats = {};
    for (const b of (bookings || [])) {
      const phone = b.customer_phone;
      if (!phone) continue;
      if (!stats[phone]) stats[phone] = { visits: 0, lastVisit: null, services: {}, barbers: {} };
      const s = stats[phone];
      s.visits++;
      if (!s.lastVisit || b.appointment_date > s.lastVisit) s.lastVisit = b.appointment_date;
      const svc = Array.isArray(b.service_ids) ? b.service_ids[0] : null;
      if (svc) s.services[svc] = (s.services[svc] || 0) + 1;
      if (b.preferred_barber) s.barbers[b.preferred_barber] = (s.barbers[b.preferred_barber] || 0) + 1;
    }

    const headers = ['Name', 'Phone', 'Total Visits', 'Last Visit', 'Preferred Service', 'Preferred Team Member', 'Tags', 'Notes', 'Created At'];

    const rows = (clients || []).map(c => {
      const s = stats[c.phone] || { visits: 0, lastVisit: null, services: {}, barbers: {} };
      const preferredService = Object.keys(s.services).sort((a, b) => s.services[b] - s.services[a])[0] || '';
      const preferredBarber  = Object.keys(s.barbers).sort((a, b) => s.barbers[b] - s.barbers[a])[0] || '';
      return [
        c.name || '',
        c.phone || '',
        String(s.visits),
        s.lastVisit || '',
        preferredService,
        preferredBarber,
        Array.isArray(c.tags) ? c.tags.join(';') : (c.tags || ''),
        c.notes || '',
        c.created_at ? c.created_at.slice(0, 10) : '',
      ];
    });

    const slug     = req.exportBusiness.booking_slug || req.business.id;
    const filename = `clients-${slug}-${today()}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(toCSV(headers, rows));
  } catch (err) {
    console.error('GET /api/export/clients error:', err.message);
    res.status(500).json({ error: 'Export failed.' });
  }
});

module.exports = router;
