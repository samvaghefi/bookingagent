# Public Booking Page (/book/[slug]) — Phase 5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a public-facing 4-step booking wizard at `/book/[slug]` that captures service, date/time, and contact info, then saves a booking with the full notification stack (SMS, email, Google Calendar).

**Architecture:** A new `server/bookingPageRoutes.js` handles all public booking API routes and slug resolution. A new `public/book/index.html` is a self-contained vanilla JS 4-step wizard. Dashboard Settings gains a slug editor and per-barber Google Calendar ID field. Slug auto-generation is added to `signupService.js` on signup.

**Tech Stack:** Node.js/Express 5, Supabase (Postgres), Google Calendar API (free/busy via `googleapis`), Luxon (timezone math), vanilla JS (no bundler), Twilio SMS, SendGrid email.

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `server/bookingPageRoutes.js` | All public booking routes (`/book/:slug`, `/api/book/*`) |
| Create | `public/book/index.html` | 4-step booking wizard (vanilla JS, no framework) |
| Modify | `server/signupService.js` | Add `generateSlug()` + uniqueness loop in `createBusiness()` |
| Modify | `server/calendarService.js` | Add `getFreeBusy()` helper |
| Modify | `server/index.js` | Mount `bookingPageRoutes`, serve `public/` static |
| Modify | `server/dashboardRoutes.js` | Add `PUT /api/business/slug`; add `booking_slug` to `GET /api/business` |
| Modify | `dashboard/app.jsx` | Settings: "Your Booking Page" card + barber `calendarId` field |

---

## Task 1: Database Migration

**Files:** None (run in Supabase SQL editor)

- [ ] **Step 1: Verify existing columns first**

In Supabase Table Editor, check whether `bookings` already has `source` and `customer_email` columns (they may exist from prior phases). Only run the relevant `ALTER TABLE` statements below.

```sql
-- Unique booking URL slug per business (definitely new)
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS booking_slug text UNIQUE;

-- Source channel ('voice' | 'online' | 'walkin') — skip if already exists
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS source text DEFAULT 'voice';

-- Customer email on bookings — skip if already exists
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS customer_email text;
```

- [ ] **Step 2: Verify**

Open Supabase Table Editor → `businesses` table → confirm `booking_slug` column exists with type `text` and unique constraint. Open `bookings` → confirm `source` and `customer_email` exist.

- [ ] **Step 3: Commit**

```bash
git commit --allow-empty -m "chore: document DB migration — booking_slug, source, customer_email"
```

---

## Task 2: Slug Generation in signupService.js

**Files:**
- Modify: `server/signupService.js`
- Create: `scripts/test-phase5-slug.js`

- [ ] **Step 1: Write failing test**

Create `scripts/test-phase5-slug.js`:

```js
const assert = require('assert');

// Stub — will fail until real implementation is imported
function generateSlug(name) { return ''; }

assert.strictEqual(generateSlug("Sam's Barbershop"), 'sams-barbershop');
assert.strictEqual(generateSlug("The Hair Lounge"),   'the-hair-lounge');
assert.strictEqual(generateSlug("Cuts & More!"),      'cuts--more');
console.log('All slug tests passed');
```

- [ ] **Step 2: Run to confirm it fails**

```bash
node scripts/test-phase5-slug.js
```
Expected: `AssertionError`

- [ ] **Step 3: Implement in signupService.js**

Read `server/signupService.js` first. Add these two functions after the existing `require` statements:

```js
function generateSlug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

async function findUniqueSlug(supabase, baseName) {
  const base = generateSlug(baseName);
  let candidate = base;
  let suffix = 2;
  while (true) {
    const { data } = await supabase
      .from('businesses')
      .select('id')
      .eq('booking_slug', candidate)
      .maybeSingle();
    if (!data) return candidate;
    candidate = `${base}-${suffix++}`;
  }
}
```

In `createBusiness()`, after the Supabase insert that creates the business row, add:

```js
const slug = await findUniqueSlug(supabase, businessName);
await supabase.from('businesses').update({ booking_slug: slug }).eq('id', business.id);
```

Add `generateSlug` to `module.exports`.

- [ ] **Step 4: Update test to use real implementation**

Replace `scripts/test-phase5-slug.js` with:

```js
const { generateSlug } = require('../server/signupService');
const assert = require('assert');

assert.strictEqual(generateSlug("Sam's Barbershop"), 'sams-barbershop');
assert.strictEqual(generateSlug("The Hair Lounge"),   'the-hair-lounge');
assert.strictEqual(generateSlug("Cuts & More!"),      'cuts-more');
assert.strictEqual(generateSlug("  Studio 7  "),      'studio-7');
console.log('✅ All slug tests passed');
```

- [ ] **Step 5: Run test to confirm it passes**

```bash
node scripts/test-phase5-slug.js
```
Expected: `✅ All slug tests passed`

- [ ] **Step 6: Commit**

```bash
git add server/signupService.js scripts/test-phase5-slug.js
git commit -m "feat: add slug generation to signupService"
```

---

## Task 3: Add getFreeBusy() to calendarService.js

**Files:**
- Modify: `server/calendarService.js`

The Google Calendar free/busy API returns busy intervals for a calendar during a time window. Uses the same OAuth client pattern as the existing `createCalendarEvent()`.

- [ ] **Step 1: Add function before `module.exports`**

```js
// Returns array of { start: Date, end: Date } busy intervals for a calendarId on a date.
// Fails open — returns [] on any error so availability still works without calendar.
async function getFreeBusy(business, calendarId, date, timezone) {
  if (!business.google_access_token || !business.google_refresh_token) return [];

  try {
    const oauth2Client = getOAuthClient();
    oauth2Client.setCredentials({
      access_token:  business.google_access_token,
      refresh_token: business.google_refresh_token,
    });

    oauth2Client.on('tokens', async (tokens) => {
      await supabase.from('businesses').update({
        google_access_token: tokens.access_token,
        ...(tokens.refresh_token ? { google_refresh_token: tokens.refresh_token } : {}),
        google_token_expiry: tokens.expiry_date
          ? new Date(tokens.expiry_date).toISOString() : null,
      }).eq('id', business.id);
    });

    await oauth2Client.getAccessToken();

    const tz       = timezone || 'America/Toronto';
    const dayStart = DateTime.fromISO(date, { zone: tz }).startOf('day');
    const dayEnd   = dayStart.endOf('day');

    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const response = await calendar.freebusy.query({
      requestBody: {
        timeMin: dayStart.toISO(),
        timeMax: dayEnd.toISO(),
        items:   [{ id: calendarId }],
      },
    });

    const busy = response.data.calendars?.[calendarId]?.busy || [];
    return busy.map(b => ({ start: new Date(b.start), end: new Date(b.end) }));
  } catch (err) {
    console.warn(`⚠️  getFreeBusy failed for calendar ${calendarId}:`, err.message);
    return [];
  }
}
```

- [ ] **Step 2: Update module.exports**

```js
module.exports = { getAuthUrl, getTokensFromCode, createCalendarEvent, getFreeBusy };
```

- [ ] **Step 3: Commit**

```bash
git add server/calendarService.js
git commit -m "feat: add getFreeBusy helper to calendarService"
```

---

## Task 4: Create server/bookingPageRoutes.js

**Files:**
- Create: `server/bookingPageRoutes.js`

- [ ] **Step 1: Create the file**

```js
const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const jwt      = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const { DateTime } = require('luxon');
const { getFreeBusy }        = require('./calendarService');
const { sendCustomerSMS, sendOwnerEmail } = require('./notificationService');
const { createCalendarEvent } = require('./calendarService');
const { createDepositToken }  = require('./depositService'); // server/depositService.js already exists

const router   = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BASE_URL = process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000';

// ── GET /book/:slug ───────────────────────────────────────────────────────────
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
router.get('/api/book/:businessId/info', async (req, res) => {
  try {
    const { data: business, error } = await supabase
      .from('businesses')
      .select('id, name, address, business_hours, barbers, timezone')
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

    // Normalise barbers: support legacy string array and new object array
    const barbers = (business.barbers || []).map(b =>
      typeof b === 'string' ? { name: b, calendarId: '' } : b
    );

    res.json({
      business: {
        id:             business.id,
        name:           business.name,
        address:        business.address,
        business_hours: business.business_hours || {},
        timezone:       business.timezone || 'America/Toronto',
        barbers,
      },
      services: services || [],
    });
  } catch (err) {
    console.error('GET /api/book/:businessId/info error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── GET /api/book/:businessId/availability ────────────────────────────────────
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
      .select('id, business_hours, barbers, timezone, google_access_token, google_refresh_token')
      .eq('id', req.params.businessId)
      .single();

    if (error || !business) return res.status(404).json({ error: 'Business not found.' });

    const tz      = business.timezone || 'America/Toronto';
    const hours   = business.business_hours || {};
    const dayKey  = DateTime.fromISO(date, { zone: tz }).weekdayLong.toLowerCase();
    const dayHours = hours[dayKey];

    if (!dayHours || dayHours.closed) return res.json({ slots: [], closed: true });

    // Generate 30-min candidate slots within open hours, excluding past slots if today
    const openTime  = DateTime.fromISO(`${date}T${dayHours.open}`,  { zone: tz });
    const closeTime = DateTime.fromISO(`${date}T${dayHours.close}`, { zone: tz });
    const now = DateTime.now().setZone(tz);

    const candidates = [];
    let cursor = openTime;
    while (cursor.plus({ minutes: duration }) <= closeTime) {
      if (cursor > now) candidates.push(cursor);
      cursor = cursor.plus({ minutes: 30 });
    }

    // Fetch bookings for this date
    let q = supabase
      .from('bookings')
      .select('appointment_time, duration_minutes, preferred_barber')
      .eq('business_id', req.params.businessId)
      .eq('appointment_date', date)
      .neq('status', 'cancelled');

    if (barberName) q = q.eq('preferred_barber', barberName);

    const { data: bookings } = await q;
    const existingBookings = (bookings || []).map(b => {
      const start = DateTime.fromISO(`${date}T${b.appointment_time}`, { zone: tz });
      return { start, end: start.plus({ minutes: b.duration_minutes || 60 }) };
    });

    // Normalise barbers
    const barbers = (business.barbers || []).map(b =>
      typeof b === 'string' ? { name: b, calendarId: '' } : b
    );

    // Google Calendar free/busy
    let calendarId = 'primary';
    if (barberName) {
      const barber = barbers.find(b => b.name === barberName);
      if (barber?.calendarId) calendarId = barber.calendarId;
    }
    const busyIntervals = await getFreeBusy(business, calendarId, date, tz);
    const calConflicts = busyIntervals.map(b => ({
      start: DateTime.fromJSDate(b.start, { zone: tz }),
      end:   DateTime.fromJSDate(b.end,   { zone: tz }),
    }));

    const totalBarbers = Math.max(barbers.length, 1);

    const slots = candidates.map(slotStart => {
      const slotEnd = slotStart.plus({ minutes: duration });

      if (barberName) {
        // Specific barber: any overlap = unavailable
        const allConflicts = [...existingBookings, ...calConflicts];
        const blocked = allConflicts.some(c => c.start < slotEnd && c.end > slotStart);
        return { time: slotStart.toFormat('HH:mm'), available: !blocked };
      } else {
        // No barber: unavailable only when all barbers are simultaneously occupied
        const overlapCount = existingBookings.filter(c => c.start < slotEnd && c.end > slotStart).length;
        const calBlocked   = calConflicts.some(c => c.start < slotEnd && c.end > slotStart);
        return { time: slotStart.toFormat('HH:mm'), available: overlapCount < totalBarbers && !calBlocked };
      }
    });

    res.json({ slots, closed: false });
  } catch (err) {
    console.error('GET /api/book/:businessId/availability error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── POST /api/book/:businessId ────────────────────────────────────────────────
router.post('/api/book/:businessId', async (req, res) => {
  const {
    customerName, customerPhone, customerEmail,
    service, appointmentDate, appointmentTime,
    preferredBarber, specialRequests, duration_minutes,
  } = req.body;

  if (!customerName || !customerPhone || !service || !appointmentDate || !appointmentTime) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  try {
    const { data: business, error } = await supabase
      .from('businesses')
      .select('*')
      .eq('id', req.params.businessId)
      .single();

    if (error || !business) return res.status(404).json({ error: 'Business not found.' });

    const record = {
      business_id:      business.id,
      customer_name:    customerName,
      customer_phone:   customerPhone,
      customer_email:   customerEmail || null,
      service_ids:      [service],
      appointment_date: appointmentDate,
      appointment_time: appointmentTime + ':00',   // HH:MM → HH:MM:SS
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

    // Notifications — non-blocking
    (async () => {
      try {
        await sendCustomerSMS(business, booking);
        await sendOwnerEmail(business, booking);
        await createCalendarEvent(business, booking);
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
        success: true, bookingId: booking.id,
        deposit_required: true, deposit_url: `/deposit/${token}`,
      });
    }

    res.json({ success: true, bookingId: booking.id, deposit_required: false });
  } catch (err) {
    console.error('POST /api/book/:businessId error:', err.message);
    res.status(500).json({ error: 'Failed to create booking. Please try again.' });
  }
});

module.exports = router;
```

- [ ] **Step 2: Mount in server/index.js**

After `const intelRoutes = require('./intelRoutes');` add:
```js
const bookingPageRoutes = require('./bookingPageRoutes');
```

After `app.use(intelRoutes);` add:
```js
app.use(bookingPageRoutes);
// Note: index.html is served by the /book/:slug route handler (not statically),
// so no additional static mount is needed for the wizard page itself.
```

- [ ] **Step 3: Seed a slug for Sam's Barbershop (run once in Supabase SQL editor)**

```sql
UPDATE businesses SET booking_slug = 'sams-barbershop'
WHERE id = 'a09fdd0b-421e-479a-b4d7-120f6a72a043'
  AND booking_slug IS NULL;
```

- [ ] **Step 4: Test info endpoint**

```bash
node server/index.js &
curl http://localhost:3000/api/book/a09fdd0b-421e-479a-b4d7-120f6a72a043/info
```
Expected: JSON with `business` and `services` array.

- [ ] **Step 5: Test availability endpoint**

```bash
curl "http://localhost:3000/api/book/a09fdd0b-421e-479a-b4d7-120f6a72a043/availability?date=2026-03-25&duration=45"
```
Expected: `{ "slots": [{"time":"09:00","available":true}, ...], "closed": false }`

- [ ] **Step 6: Test booking creation**

```bash
curl -X POST http://localhost:3000/api/book/a09fdd0b-421e-479a-b4d7-120f6a72a043 \
  -H 'Content-Type: application/json' \
  -d '{"customerName":"Test","customerPhone":"+14165550001","service":"Haircut","appointmentDate":"2026-03-30","appointmentTime":"10:00","duration_minutes":45}'
```
Expected: `{ "success": true, "bookingId": "...", "deposit_required": false }`

- [ ] **Step 7: Commit**

```bash
git add server/bookingPageRoutes.js server/index.js
git commit -m "feat: add bookingPageRoutes (info, availability, booking creation, slug resolution)"
```

---

## Task 5: Build public/book/index.html — the full 4-step wizard

**Files:**
- Create: `public/book/index.html`

- [ ] **Step 1: Write the file**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Book an Appointment</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #f8fafc; min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: 24px 16px; color: #111827; }
    .card { background: #fff; border-radius: 16px; padding: 32px 28px; max-width: 520px; width: 100%; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
    .biz-name { font-size: 13px; color: #6b7280; text-align: center; margin-bottom: 4px; }
    h2 { font-size: 20px; font-weight: 700; color: #111827; text-align: center; margin-bottom: 20px; }
    .progress { display: flex; gap: 6px; margin-bottom: 24px; }
    .step-dot { flex: 1; height: 4px; border-radius: 2px; background: #e5e7eb; transition: background 0.2s; }
    .step-dot.active { background: #534AB7; }
    /* Service cards */
    .service-list { display: flex; flex-direction: column; gap: 10px; }
    .service-card { border: 2px solid #e5e7eb; border-radius: 12px; padding: 14px 16px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; transition: border-color 0.15s; }
    .service-card:hover { border-color: #534AB7; }
    .service-card.selected { border-color: #534AB7; background: #f5f4ff; }
    .service-card-name { font-size: 15px; font-weight: 600; }
    .service-card-meta { font-size: 13px; color: #6b7280; margin-top: 2px; }
    .service-card-price { font-size: 16px; font-weight: 700; color: #534AB7; white-space: nowrap; }
    /* Date + slots */
    input[type="date"] { width: 100%; padding: 10px 12px; border: 1.5px solid #e5e7eb; border-radius: 10px; font-size: 15px; color: #111827; background: #fff; margin-bottom: 4px; }
    input[type="date"]:focus { outline: none; border-color: #534AB7; }
    .slot-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-top: 12px; }
    .slot-btn { padding: 9px 4px; border: 1.5px solid #e5e7eb; border-radius: 8px; font-size: 13px; font-weight: 600; color: #374151; background: #fff; cursor: pointer; text-align: center; transition: border-color 0.1s; }
    .slot-btn:hover:not(.unavailable) { border-color: #534AB7; color: #534AB7; }
    .slot-btn.selected { border-color: #534AB7; background: #534AB7; color: #fff; }
    .slot-btn.unavailable { color: #d1d5db; cursor: default; border-color: #f3f4f6; background: #f9fafb; }
    .msg { text-align: center; padding: 16px 0; font-size: 14px; color: #6b7280; }
    .msg.err { color: #ef4444; font-weight: 600; }
    /* Form fields */
    .field { margin-bottom: 14px; }
    .field label { display: block; font-size: 13px; font-weight: 600; color: #374151; margin-bottom: 4px; }
    .field input, .field select, .field textarea { width: 100%; padding: 10px 12px; border: 1.5px solid #e5e7eb; border-radius: 10px; font-size: 15px; color: #111827; background: #fff; }
    .field input:focus, .field select:focus, .field textarea:focus { outline: none; border-color: #534AB7; }
    .field textarea { resize: vertical; }
    /* Buttons */
    .btn-primary { width: 100%; padding: 13px; background: #534AB7; color: #fff; border: none; border-radius: 10px; font-size: 16px; font-weight: 700; cursor: pointer; margin-top: 18px; transition: background 0.15s; }
    .btn-primary:hover:not(:disabled) { background: #4338ca; }
    .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-back { background: none; border: none; color: #6b7280; font-size: 14px; cursor: pointer; margin-top: 10px; display: block; text-align: center; width: 100%; }
    .btn-back:hover { color: #374151; }
    /* Confirm summary */
    .summary { background: #f8fafc; border-radius: 12px; padding: 16px 18px; font-size: 14px; line-height: 2; margin-bottom: 16px; }
    /* Banners */
    .warn-banner { background: #fef3c7; border: 1px solid #fcd34d; color: #92400e; border-radius: 8px; padding: 10px 14px; font-size: 14px; margin-bottom: 12px; }
    .err-banner  { background: #fef2f2; border: 1px solid #fecaca; color: #b91c1c;  border-radius: 8px; padding: 10px 14px; font-size: 14px; margin-bottom: 12px; }
    /* Step panels */
    .step { display: none; }
    .step.active { display: block; }
    @media (max-width: 400px) { .slot-grid { grid-template-columns: repeat(3, 1fr); } }
  </style>
</head>
<body>
<div class="card">
  <p class="biz-name" id="bizName"></p>
  <div class="progress">
    <div class="step-dot active" id="d1"></div>
    <div class="step-dot" id="d2"></div>
    <div class="step-dot" id="d3"></div>
    <div class="step-dot" id="d4"></div>
  </div>

  <!-- Step 1: Service -->
  <div class="step active" id="step1">
    <h2>Choose a service</h2>
    <div class="service-list" id="serviceList"><p class="msg">Loading services…</p></div>
    <button class="btn-primary" id="s1Next" disabled onclick="goTo(2)">Next →</button>
  </div>

  <!-- Step 2: Date + Time -->
  <div class="step" id="step2">
    <h2>Pick a date &amp; time</h2>
    <input type="date" id="dateInput" min="">
    <div id="slotContainer"><p class="msg">Select a date to see available times.</p></div>
    <button class="btn-primary" id="s2Next" disabled onclick="goTo(3)">Next →</button>
    <button class="btn-back" onclick="goTo(1)">← Back</button>
  </div>

  <!-- Step 3: Contact -->
  <div class="step" id="step3">
    <h2>Your details</h2>
    <div id="slotWarning" class="warn-banner" style="display:none"></div>
    <div class="field"><label>Name *</label><input type="text" id="custName" placeholder="Your name" autocomplete="name"></div>
    <div class="field"><label>Phone *</label><input type="tel" id="custPhone" placeholder="+1 (416) 555-0000" autocomplete="tel"></div>
    <div class="field"><label>Email (optional)</label><input type="email" id="custEmail" placeholder="you@example.com" autocomplete="email"></div>
    <div class="field" id="barberFieldWrap">
      <label>Preferred team member (optional)</label>
      <select id="barberSelect"><option value="">No preference</option></select>
    </div>
    <div class="field"><label>Special requests (optional)</label><textarea id="custRequests" rows="3" placeholder="e.g. Leave the beard, short on sides"></textarea></div>
    <button class="btn-primary" onclick="prepareConfirm()">Review booking →</button>
    <button class="btn-back" onclick="goTo(2)">← Back</button>
  </div>

  <!-- Step 4: Confirm -->
  <div class="step" id="step4">
    <h2>Confirm your booking</h2>
    <div class="summary" id="confirmSummary"></div>
    <div id="errMsg" class="err-banner" style="display:none"></div>
    <button class="btn-primary" id="confirmBtn" onclick="submitBooking()">Confirm Booking</button>
    <button class="btn-back" onclick="goTo(3)">← Back</button>
  </div>

  <!-- Success -->
  <div class="step" id="step5">
    <div style="text-align:center;padding:16px 0;">
      <div style="font-size:48px;margin-bottom:12px;">✅</div>
      <h2 style="margin-bottom:8px;">You're booked!</h2>
      <p style="color:#6b7280;font-size:14px;line-height:1.6;" id="successMsg"></p>
    </div>
  </div>
</div>

<script>
const cfg        = window.__BOOKING_CONFIG__ || {};
const businessId = cfg.businessId;

const state = { service: null, date: null, time: null, barberName: null, info: null,
                customerName: '', customerPhone: '', customerEmail: '', specialRequests: '' };

document.getElementById('bizName').textContent = cfg.businessName || '';
document.getElementById('dateInput').min = new Date().toISOString().split('T')[0];

fetch(`/api/book/${businessId}/info`)
  .then(r => r.json())
  .then(data => { state.info = data; renderServices(data.services); })
  .catch(() => { document.getElementById('serviceList').innerHTML = '<p class="msg err">Failed to load. Please refresh.</p>'; });

// ── Step management ────────────────────────────────────────────────────────────
function goTo(n) {
  if (n === 3) populateBarbers();
  [1,2,3,4,5].forEach(i => {
    document.getElementById('step' + i).classList.toggle('active', i === n);
    const dot = document.getElementById('d' + i);
    if (dot) dot.classList.toggle('active', i <= n);
  });
}

// ── Step 1: Services ──────────────────────────────────────────────────────────
function renderServices(services) {
  const list = document.getElementById('serviceList');
  if (!services || !services.length) { list.innerHTML = '<p class="msg">No services available.</p>'; return; }
  list.innerHTML = services.map(s => `
    <div class="service-card" onclick='selectService(${JSON.stringify(s)})' data-id="${s.id}">
      <div>
        <div class="service-card-name">${s.name}</div>
        <div class="service-card-meta">${s.duration_minutes || 60} min</div>
      </div>
      <div class="service-card-price">${s.price ? '$' + Math.round(s.price / 100) : ''}</div>
    </div>`).join('');
}

function selectService(s) {
  state.service = s; state.time = null;
  document.querySelectorAll('.service-card').forEach(el => el.classList.toggle('selected', el.dataset.id === String(s.id)));
  document.getElementById('s1Next').disabled = false;
}

// ── Step 2: Date + Slots ──────────────────────────────────────────────────────
document.getElementById('dateInput').addEventListener('change', function() {
  state.date = this.value; state.time = null;
  document.getElementById('s2Next').disabled = true;
  if (state.date) loadSlots();
});

function loadSlots() {
  document.getElementById('slotContainer').innerHTML = '<p class="msg">Checking availability…</p>';
  const params = new URLSearchParams({ date: state.date, duration: state.service?.duration_minutes || 60 });
  if (state.barberName) params.append('barberName', state.barberName);
  fetch(`/api/book/${businessId}/availability?${params}`)
    .then(r => r.json()).then(renderSlots)
    .catch(() => { document.getElementById('slotContainer').innerHTML = '<p class="msg err">Failed to load slots. Try again.</p>'; });
}

function renderSlots(data) {
  const c = document.getElementById('slotContainer');
  if (data.closed) { c.innerHTML = '<p class="msg err">Closed on this day.</p>'; return; }
  if (!data.slots?.length) { c.innerHTML = '<p class="msg">No available times on this day.</p>'; return; }
  c.innerHTML = '<div class="slot-grid">' + data.slots.map(s =>
    `<button class="slot-btn${s.available ? '' : ' unavailable'}" ${s.available ? `onclick="selectSlot('${s.time}',this)"` : 'disabled'}>
      ${fmt(s.time)}</button>`).join('') + '</div>';
}

function selectSlot(time, btn) {
  state.time = time;
  document.querySelectorAll('.slot-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  document.getElementById('s2Next').disabled = false;
}

function fmt(t) {
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2,'0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

// ── Step 3: Contact + barber ──────────────────────────────────────────────────
function populateBarbers() {
  const sel = document.getElementById('barberSelect');
  const barbers = state.info?.business?.barbers || [];
  while (sel.options.length > 1) sel.remove(1);
  barbers.forEach(b => { const o = new Option(b.name, b.name); sel.appendChild(o); });
  document.getElementById('barberFieldWrap').style.display = barbers.length ? '' : 'none';
}

document.addEventListener('change', function(e) {
  if (e.target.id !== 'barberSelect') return;
  const nb = e.target.value || null;
  if (nb === state.barberName) return;
  state.barberName = nb;
  if (!state.date || !state.time) return;
  const params = new URLSearchParams({ date: state.date, duration: state.service?.duration_minutes || 60 });
  if (state.barberName) params.append('barberName', state.barberName);
  fetch(`/api/book/${businessId}/availability?${params}`)
    .then(r => r.json())
    .then(data => {
      const chosen = data.slots?.find(s => s.time === state.time);
      if (chosen && !chosen.available) {
        state.time = null;
        document.getElementById('slotWarning').textContent =
          `Your selected time is no longer available${state.barberName ? ' for ' + state.barberName : ''}. Please pick a new time.`;
        document.getElementById('slotWarning').style.display = 'block';
        goTo(2); loadSlots();
      } else {
        document.getElementById('slotWarning').style.display = 'none';
      }
    }).catch(() => {});
});

function prepareConfirm() {
  const name  = document.getElementById('custName').value.trim();
  const phone = document.getElementById('custPhone').value.trim();
  if (!name || !phone) { alert('Name and phone are required.'); return; }
  state.customerName    = name;
  state.customerPhone   = phone;
  state.customerEmail   = document.getElementById('custEmail').value.trim();
  state.barberName      = document.getElementById('barberSelect').value || null;
  state.specialRequests = document.getElementById('custRequests').value.trim();
  document.getElementById('confirmSummary').innerHTML = [
    ['Service',     state.service?.name],
    ['Date',        state.date],
    ['Time',        fmt(state.time)],
    state.barberName       ? ['Team member', state.barberName]       : null,
    ['Name',        state.customerName],
    ['Phone',       state.customerPhone],
    state.specialRequests  ? ['Requests',    state.specialRequests]  : null,
  ].filter(Boolean).map(([k,v]) => `<div><strong>${k}:</strong> ${v}</div>`).join('');
  goTo(4);
}

// ── Step 4: Submit ────────────────────────────────────────────────────────────
async function submitBooking() {
  const btn = document.getElementById('confirmBtn');
  const err = document.getElementById('errMsg');
  btn.disabled = true; btn.textContent = 'Confirming…'; err.style.display = 'none';
  try {
    const res = await fetch(`/api/book/${businessId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerName:    state.customerName,
        customerPhone:   state.customerPhone,
        customerEmail:   state.customerEmail || null,
        service:         state.service?.name,
        appointmentDate: state.date,
        appointmentTime: state.time,
        preferredBarber: state.barberName || null,
        specialRequests: state.specialRequests || null,
        duration_minutes: state.service?.duration_minutes || 60,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Something went wrong.');
    if (data.deposit_required && data.deposit_url) { window.location.href = data.deposit_url; return; }
    document.getElementById('successMsg').textContent =
      `Your ${state.service?.name} is booked for ${state.date} at ${fmt(state.time)}. You'll receive a confirmation text shortly.`;
    goTo(5);
  } catch (e) {
    err.textContent = e.message; err.style.display = 'block';
    btn.disabled = false; btn.textContent = 'Confirm Booking';
  }
}
</script>
</body>
</html>
```

- [ ] **Step 2: Test end-to-end in browser**

Visit `http://localhost:3000/book/sams-barbershop`. Complete all 4 steps:
1. Select a service → Next
2. Pick a date, pick a slot → Next
3. Enter name + phone, optionally pick barber → "Review booking"
4. Confirm → success screen (or deposit redirect if enabled)

Verify in Supabase: booking row exists with `source = 'online'`.

- [ ] **Step 3: Commit**

```bash
git add public/book/index.html
git commit -m "feat: 4-step public booking wizard (public/book/index.html)"
```

---

## Task 6: Dashboard — slug API + booking_slug in GET /api/business

**Files:**
- Modify: `server/dashboardRoutes.js`

- [ ] **Step 1: Add `booking_slug` to the select in `GET /api/business`**

Find the `.select([...].join(', '))` block. Add `'booking_slug'` to the array alongside `'queue_enabled', 'queue_notify_timeout'`.

- [ ] **Step 2: Add `PUT /api/business/slug` route**

Add before `module.exports = router;` (or after the `PUT /api/business` route):

```js
// PUT /api/business/slug — update the booking page slug
router.put('/api/business/slug', async (req, res) => {
  const { slug } = req.body;
  if (!slug) return res.status(400).json({ error: 'Slug is required.' });
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return res.status(400).json({ error: 'Invalid slug format. Use lowercase letters, numbers, and hyphens only.' });
  }
  try {
    const { data: existing } = await supabase
      .from('businesses')
      .select('id')
      .eq('booking_slug', slug)
      .neq('id', req.business.id)
      .maybeSingle();

    if (existing) return res.status(409).json({ error: 'Slug already taken. Please choose another.' });

    const { data: business, error } = await supabase
      .from('businesses')
      .update({ booking_slug: slug })
      .eq('id', req.business.id)
      .select('id, booking_slug')
      .single();

    if (error) throw error;
    res.json({ business });
  } catch (err) {
    console.error('PUT /api/business/slug error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 3: Test**

```bash
# Verify booking_slug appears in business response
curl -H 'Authorization: Bearer YOUR_JWT' http://localhost:3000/api/business | grep booking_slug
```
Expected: `"booking_slug": "sams-barbershop"` (or null if not yet set)

```bash
# Get a token by logging in at /auth/dashboard/login, then:
curl -X PUT http://localhost:3000/api/business/slug \
  -H 'Authorization: Bearer YOUR_JWT' \
  -H 'Content-Type: application/json' \
  -d '{"slug":"sams-barbershop"}'
```
Expected: `{ "business": { "id": "...", "booking_slug": "sams-barbershop" } }`

```bash
curl -X PUT http://localhost:3000/api/business/slug \
  -H 'Authorization: Bearer YOUR_JWT' \
  -H 'Content-Type: application/json' \
  -d '{"slug":"INVALID SLUG!"}'
```
Expected: 400 `{ "error": "Invalid slug format..." }`

- [ ] **Step 4: Commit**

```bash
git add server/dashboardRoutes.js
git commit -m "feat: add booking_slug to GET /api/business and PUT /api/business/slug"
```

---

## Task 7: Dashboard Settings — booking page card + barber calendarId

**Files:**
- Modify: `dashboard/app.jsx`

- [ ] **Step 1: Normalise barbers to object format on load**

Find where `barbers` is set from `biz.barbers` in the onboarding and settings components. Update to:

```js
barbers: (biz.barbers || []).map(b =>
  typeof b === 'string' ? { name: b, calendarId: '' } : b
)
```

Also where a new barber is added (e.g., pushing to the barbers array), wrap the string as an object:
```js
{ name: newBarberName, calendarId: '' }
```

- [ ] **Step 2: Add Google Calendar ID field to each barber row**

In the JSX that renders each barber entry, add below the barber name:

```jsx
<input
  type="text"
  placeholder="Google Calendar ID (optional)"
  value={barber.calendarId || ''}
  onChange={e => {
    const updated = barbers.map((b, i) =>
      i === idx ? { ...b, calendarId: e.target.value } : b
    );
    setBarbers(updated);
  }}
  style={{ fontSize: '13px', padding: '6px 10px', border: '1px solid #e5e7eb', borderRadius: '6px', width: '100%', marginTop: '4px' }}
/>
```

- [ ] **Step 3: Add "Your Booking Page" card to SettingsPage JSX**

Add a new card section (before or after the business hours section). `BASE_URL` is `window.location.origin`:

```jsx
<div className="settings-card">
  <h3 className="settings-card-title">Your Booking Page</h3>
  {business.booking_slug ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: '10px', padding: '10px 14px', marginBottom: '14px' }}>
      <span style={{ flex: 1, fontSize: '14px', color: '#374151', wordBreak: 'break-all' }}>
        {window.location.origin}/book/{business.booking_slug}
      {/* window.location.origin is used here because RENDER_EXTERNAL_URL is server-side only;
          the result is correct when the dashboard is accessed from the production domain */}
      </span>
      <button
        onClick={() => navigator.clipboard.writeText(`${window.location.origin}/book/${business.booking_slug}`)}
        style={{ padding: '6px 12px', background: '#534AB7', color: '#fff', border: 'none', borderRadius: '6px', fontSize: '13px', cursor: 'pointer', whiteSpace: 'nowrap' }}
      >Copy link</button>
      <a href={`/book/${business.booking_slug}`} target="_blank" rel="noopener noreferrer"
        style={{ padding: '6px 12px', background: '#f3f4f6', color: '#374151', border: '1px solid #e5e7eb', borderRadius: '6px', fontSize: '13px', textDecoration: 'none', whiteSpace: 'nowrap' }}>
        Open ↗
      </a>
    </div>
  ) : (
    <p style={{ fontSize: '14px', color: '#6b7280', marginBottom: '14px' }}>
      Set a slug below to activate your public booking page.
    </p>
  )}
  <label style={{ display: 'block', fontSize: '13px', fontWeight: '600', color: '#374151', marginBottom: '4px' }}>Booking page slug</label>
  <div style={{ display: 'flex', gap: '8px' }}>
    <input
      type="text"
      id="slugInput"
      defaultValue={business.booking_slug || ''}
      placeholder="e.g. sams-barbershop"
      style={{ flex: 1, padding: '10px 12px', border: '1.5px solid #e5e7eb', borderRadius: '10px', fontSize: '15px' }}
    />
    <button
      onClick={async () => {
        const slug = document.getElementById('slugInput').value.trim().toLowerCase();
        const res = await fetch('/api/business/slug', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('bimbly_token')}` },
          body: JSON.stringify({ slug }),
        });
        const data = await res.json();
        if (!res.ok) { alert(data.error || 'Failed to save.'); }
        else { setBusiness(b => ({ ...b, booking_slug: data.business.booking_slug })); }
      }}
      style={{ padding: '10px 16px', background: '#534AB7', color: '#fff', border: 'none', borderRadius: '10px', fontSize: '14px', fontWeight: '700', cursor: 'pointer' }}
    >Save</button>
  </div>
  <p style={{ fontSize: '12px', color: '#9ca3af', marginTop: '4px' }}>Lowercase letters, numbers, and hyphens only.</p>
</div>
```

- [ ] **Step 4: Test in browser**

Log into dashboard → Settings.
- "Your Booking Page" card shows the link if slug is set, or prompt if not
- Copy button copies URL to clipboard
- Open ↗ button opens wizard in new tab
- Saving a new slug updates the displayed URL
- Each barber row shows Google Calendar ID field; saving persists it

- [ ] **Step 5: Commit**

```bash
git add dashboard/app.jsx
git commit -m "feat: booking page card + barber calendarId in Settings"
```

---

## Task 8: Deploy + smoke test

- [ ] **Step 1: Push to main**

```bash
git push origin main
```

Monitor Render deploy logs for errors.

- [ ] **Step 2: Smoke test**

```bash
curl https://bookingagent-gmo2.onrender.com/book/sams-barbershop
```
Expected: HTML page (not 404).

```bash
curl "https://bookingagent-gmo2.onrender.com/api/book/a09fdd0b-421e-479a-b4d7-120f6a72a043/availability?date=2026-03-25&duration=45"
```
Expected: `{ "slots": [...], "closed": false }`

- [ ] **Step 3: End-to-end booking on production**

Visit `https://bookingagent-gmo2.onrender.com/book/sams-barbershop`, complete a test booking, verify it appears in the Supabase bookings table and SMS/email are received.
