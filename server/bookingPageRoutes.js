const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const { createClient } = require('@supabase/supabase-js');
const { DateTime } = require('luxon');
const { createCalendarEvent } = require('./calendarService');
const availability = require('./availabilityService');
const { sendCustomerSMS, sendOwnerEmail }  = require('./notificationService');
const { maybeScheduleReminder }            = require('./reminderService');
const { createDepositToken }               = require('./depositService');
const { ensureClient }                     = require('./clientService'); // already exists at server/depositService.js

const router   = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ── GET /book/:slug ───────────────────────────────────────────────────────────
// Resolves slug → businessId, injects window.__BOOKING_CONFIG__, serves wizard HTML.
router.get('/book/:slug', async (req, res) => {
  try {
    const { data: business, error } = await supabase
      .from('businesses')
      .select('id, name, is_active')
      .eq('booking_slug', req.params.slug)
      .single();

    if (error || !business) return res.status(404).send('Booking page not found.');
    if (!business.is_active)  return res.status(404).send('This booking page is not available.');

    const htmlPath = path.join(__dirname, '..', 'public', 'book', 'index.html');
    let html = fs.readFileSync(htmlPath, 'utf8');
    const config = JSON.stringify({ businessId: business.id, businessName: business.name });
    html = html.replace('</head>', `<script>window.__BOOKING_CONFIG__ = ${config};</script>\n</head>`);
    res.send(html);
  } catch (err) {
    console.error('GET /book/:slug error:', err.message);
    res.status(500).send('Server error.');
  }
});

// ── GET /api/book/:businessId/info ────────────────────────────────────────────
// Public: returns business info + services needed to render the booking wizard.
router.get('/api/book/:businessId/info', async (req, res) => {
  try {
    const { data: business, error } = await supabase
      .from('businesses')
      .select('id, name, address, business_hours, barbers, team_members, timezone, business_type, logo_url, deposit_enabled')
      .eq('id', req.params.businessId)
      .eq('is_active', true)
      .single();

    if (error || !business) return res.status(404).json({ error: 'Business not found.' });

    const { data: services } = await supabase
      .from('services')
      .select('id, name, price, duration_minutes, description')
      .eq('business_id', req.params.businessId)
      .eq('is_active', true)
      .order('name');

    // Normalise team members: prefer team_members column, fall back to barbers
    const rawMembers = business.team_members || business.barbers || [];
    const teamMembers = rawMembers.map(m =>
      typeof m === 'string' ? { name: m, role: '', calendarId: '' } : { role: '', calendarId: '', ...m }
    ).filter(m => m.name);

    res.json({
      business: {
        id:              business.id,
        name:            business.name,
        address:         business.address,
        business_hours:  business.business_hours || {},
        timezone:        business.timezone || 'America/Toronto',
        business_type:   business.business_type || '',
        barbers:         teamMembers,
        team_members:    teamMembers,
        logo_url:        business.logo_url || null,
        deposit_enabled: business.deposit_enabled || false,
      },
      services: services || [],
    });
  } catch (err) {
    console.error('GET /api/book/:businessId/info error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── GET /api/book/:businessId/availability ────────────────────────────────────
// Public: returns time slots for a given date blocking booked slots + calendar busy times.
// Query params: date (YYYY-MM-DD), duration (minutes, default 60), barberName (optional)
router.get('/api/book/:businessId/availability', async (req, res) => {
  const { date, barberName } = req.query;
  const duration = parseInt(req.query.duration) || 60;

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date param required (YYYY-MM-DD).' });
  }

  try {
    const { data: business, error } = await supabase
      .from('businesses')
      .select('id, business_hours, barbers, team_members, timezone, google_access_token, google_refresh_token')
      .eq('id', req.params.businessId)
      .single();

    if (error || !business) return res.status(404).json({ error: 'Business not found.' });

    // Same rules as phone bookings: hours, bookings, blocked time, Google Calendar
    const day = await availability.getDayAvailability(business, date, {
      durationMinutes: duration,
      teamMember: barberName || undefined,
    });
    if (day.closed) return res.json({ slots: [], closed: true });

    // Past times aren't shown at all (as before); the rest come with available true/false
    const slots = day.slots
      .filter(s => s.reason !== 'past')
      .map(s => ({ time: s.time, available: s.available }));
    res.json({ slots, closed: false });
  } catch (err) {
    console.error('GET /api/book/:businessId/availability error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── POST /api/book/:businessId ────────────────────────────────────────────────
// Create a booking from the public wizard and trigger notifications.
router.post('/api/book/:businessId', async (req, res) => {
  const {
    customerName, customerPhone, customerEmail,
    service, appointmentDate, appointmentTime,
    preferredBarber, specialRequests, duration_minutes,
  } = req.body;

  if (!customerName || !customerPhone || !service || !appointmentDate || !appointmentTime) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  // Validate field formats
  if (typeof customerName !== 'string' || customerName.trim().length < 1 || customerName.trim().length > 100) {
    return res.status(400).json({ error: 'Invalid customer name.' });
  }
  if (!/^\+?[\d\s\-().]{7,20}$/.test(customerPhone)) {
    return res.status(400).json({ error: 'Invalid phone number.' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(appointmentDate)) {
    return res.status(400).json({ error: 'Invalid date format (YYYY-MM-DD).' });
  }
  if (!/^\d{2}:\d{2}$/.test(appointmentTime)) {
    return res.status(400).json({ error: 'Invalid time format (HH:MM).' });
  }
  if (customerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
    return res.status(400).json({ error: 'Invalid email address.' });
  }
  const safeDuration = parseInt(duration_minutes);
  if (duration_minutes !== undefined && (isNaN(safeDuration) || safeDuration < 5 || safeDuration > 480)) {
    return res.status(400).json({ error: 'Invalid duration.' });
  }

  try {
    const { data: business, error } = await supabase
      .from('businesses')
      .select('*')
      .eq('id', req.params.businessId)
      .single();

    if (error || !business) return res.status(404).json({ error: 'Business not found.' });

    // Re-check the time right before saving (someone may have just taken it)
    try {
      const slot = await availability.checkSlot(business, {
        date: appointmentDate, time: appointmentTime, service,
        durationMinutes: duration_minutes ? safeDuration : undefined,
        teamMember: preferredBarber || undefined,
      });
      if (!slot.available) {
        return res.status(409).json({ error: 'Sorry, that time was just taken. Please pick another time.', reason: slot.reason });
      }
    } catch (checkErr) {
      console.error('Availability re-check failed, booking anyway:', checkErr.message);
    }

    const record = {
      business_id:      business.id,
      customer_name:    customerName,
      customer_phone:   customerPhone,
      customer_email:   customerEmail || null,
      service_ids:      [service],
      appointment_date: appointmentDate,
      appointment_time: appointmentTime + ':00',  // HH:MM → HH:MM:SS
      special_requests: specialRequests || null,
      preferred_barber: preferredBarber || null,
      duration_minutes: duration_minutes || 60,
      source:           'online',
      status:           'confirmed',
      deposit_status:   business.deposit_enabled ? 'pending' : 'none',
    };

    const { data: booking, error: insertErr } = await supabase
      .from('bookings')
      .insert(record)
      .select()
      .single();

    if (insertErr) throw insertErr;

    // Add the customer to the shop's client list (never blocks the booking)
    await ensureClient(business.id, { name: booking.customer_name, phone: booking.customer_phone });

    // Notifications — non-blocking
    (async () => {
      try {
        await sendCustomerSMS(business, booking);
        await sendOwnerEmail(business, booking);
        await createCalendarEvent(business, booking);
        await maybeScheduleReminder(business, booking);
        await supabase.from('bookings')
          .update({ sms_sent: true, email_sent: true })
          .eq('id', booking.id);
      } catch (e) {
        console.error('⚠️  Online booking notification error:', e.message);
      }
    })();

    if (business.deposit_enabled) {
      const token = createDepositToken(booking);
      return res.json({
        success: true,
        bookingId: booking.id,
        deposit_required: true,
        deposit_url: `/deposit/${token}`,
      });
    }

    res.json({ success: true, bookingId: booking.id, deposit_required: false });
  } catch (err) {
    console.error('POST /api/book/:businessId error:', err.message);
    res.status(500).json({ error: 'Failed to create booking. Please try again.' });
  }
});

module.exports = router;
