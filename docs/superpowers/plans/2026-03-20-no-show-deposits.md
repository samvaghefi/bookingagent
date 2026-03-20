# No-Show Deposits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a no-show deposit system where businesses can optionally require a flat card-on-file deposit that is only charged if a customer no-shows.

**Architecture:** After booking, an SMS with a signed JWT link sends the customer to a lazily-created Stripe Checkout Session (setup mode). The stored payment method is only charged when the owner clicks "No-Show" in the dashboard. All deposit Stripe logic lives in `server/depositService.js`. The existing billing webhook is updated to dispatch to the deposit handler when `session.metadata.booking_id` is present.

**Tech Stack:** Node.js + Express 5, Supabase JS client, Stripe v20 (setup mode + PaymentIntents), Twilio SMS, React 18 + Babel standalone, `jsonwebtoken` (already installed).

**Spec:** `docs/superpowers/specs/2026-03-20-no-show-deposits-design.md`

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `scripts/migrations/add-deposit-columns.sql` | DB migration — run once in Supabase SQL editor |
| Create | `server/depositService.js` | `createDepositToken`, `handleDepositCheckoutComplete`, `chargeNoShow`; TEST_MODE Stripe init |
| Modify | `server/notificationService.js` | Add `sendDepositSMS()` |
| Modify | `server/bookingService.js` | Accept `depositStatus` param in `saveBooking()`; trigger deposit token + SMS after insert |
| Modify | `server/dashboardRoutes.js` | Add `deposit_enabled`/`deposit_amount` to GET + PUT `/api/business`; add no-show and waive routes |
| Modify | `server/index.js` | Add `/deposit/success`, `/deposit/cancel`, `/deposit/:token` routes; update webhook |
| Modify | `dashboard/app.jsx` | Settings deposit section; deposit badges + action buttons in Bookings + Client Profile |
| Modify | `vapi-system-prompt.txt` | Add `{{depositPolicy}}` variable |
| Create | `scripts/test-no-show-deposits.js` | Manual end-to-end QA script |

---

## Task 1: Database Migration

**Files:**
- Create: `scripts/migrations/add-deposit-columns.sql`

- [ ] **Step 1: Create the migration file**

```sql
-- Phase 3: No-Show Deposits
-- Run in Supabase SQL Editor (Dashboard → SQL Editor → New query)

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS deposit_enabled boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS deposit_amount  integer DEFAULT 2500; -- cents (CA$25)

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS deposit_status           text DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS stripe_setup_intent_id   text,
  ADD COLUMN IF NOT EXISTS stripe_payment_method_id text,
  ADD COLUMN IF NOT EXISTS stripe_customer_id       text;
```

Save to: `scripts/migrations/add-deposit-columns.sql`

- [ ] **Step 2: Run the migration in Supabase**

Go to Supabase Dashboard → SQL Editor → New query. Paste the SQL and click Run.

Expected: "Success. No rows returned." for each ALTER TABLE statement.

- [ ] **Step 3: Verify columns exist**

In Supabase SQL Editor, run:
```sql
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name IN ('businesses', 'bookings')
  AND column_name IN ('deposit_enabled', 'deposit_amount', 'deposit_status',
                      'stripe_setup_intent_id', 'stripe_payment_method_id', 'stripe_customer_id')
ORDER BY table_name, column_name;
```

Expected: 6 rows — 2 on businesses, 4 on bookings.

- [ ] **Step 4: Commit**

```bash
git add scripts/migrations/add-deposit-columns.sql
git commit -m "feat: add deposit columns migration (Phase 3)"
```

---

## Task 2: Create `server/depositService.js`

**Files:**
- Create: `server/depositService.js`

- [ ] **Step 1: Create the file**

```js
// server/depositService.js
// Stripe deposit logic: token generation, webhook handler, no-show charge.
//
// IMPORTANT: Deposit checkout sessions use ONLY booking_id in metadata.
// Billing sessions use ONLY business_id. Never mix — the webhook
// dispatcher checks booking_id first to route to this handler.

const jwt = require('jsonwebtoken');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(
  process.env.TEST_MODE === 'true'
    ? process.env.STRIPE_TEST_SECRET_KEY
    : process.env.STRIPE_SECRET_KEY
);

const BASE_URL = process.env.BASE_URL || 'https://bookingagent-gmo2.onrender.com';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ── createDepositToken ────────────────────────────────────────────────────────
// Creates a signed 24h JWT containing the bookingId.
// The caller builds the SMS URL: `${BASE_URL}/deposit/${token}`
// Does NOT call Stripe — session is created lazily when the customer taps the link.
function createDepositToken(booking) {
  return jwt.sign(
    { bookingId: booking.id },
    process.env.JWT_SECRET,
    { expiresIn: '24h' }
  );
}

// ── handleDepositCheckoutComplete ─────────────────────────────────────────────
// Called by the Stripe webhook when session.metadata.booking_id is present.
// Saves payment method, customer ID, and setup intent ID to the booking row.
async function handleDepositCheckoutComplete(session) {
  const bookingId = session.metadata.booking_id;

  // Retrieve the setup intent to get the payment method ID
  const setupIntent = await stripe.setupIntents.retrieve(session.setup_intent);

  const { error } = await supabase
    .from('bookings')
    .update({
      deposit_status:           'secured',
      stripe_customer_id:       session.customer,
      stripe_payment_method_id: setupIntent.payment_method,
      stripe_setup_intent_id:   session.setup_intent,
    })
    .eq('id', bookingId);

  if (error) {
    console.error('❌ handleDepositCheckoutComplete — failed to update booking:', error.message);
    throw error;
  }

  console.log(`💳 Deposit secured for booking ${bookingId}`);
}

// ── chargeNoShow ──────────────────────────────────────────────────────────────
// Creates and immediately captures a PaymentIntent against the stored card.
// Throws a descriptive error on Stripe failure — caller returns HTTP 402.
async function chargeNoShow(booking, business) {
  if (!booking.stripe_customer_id || !booking.stripe_payment_method_id) {
    throw new Error('No payment method on file for this booking.');
  }

  const paymentIntent = await stripe.paymentIntents.create({
    amount:               business.deposit_amount,
    currency:             'cad',
    customer:             booking.stripe_customer_id,
    payment_method:       booking.stripe_payment_method_id,
    payment_method_types: ['card'],   // required — automatic_payment_methods does not support off_session
    confirm:              true,
    off_session:          true,
  });

  if (paymentIntent.status !== 'succeeded') {
    throw new Error(`Payment did not succeed. Status: ${paymentIntent.status}`);
  }

  const { error } = await supabase
    .from('bookings')
    .update({ deposit_status: 'charged' })
    .eq('id', booking.id);

  if (error) throw error;

  console.log(`💸 No-show deposit charged for booking ${booking.id} — CA$${business.deposit_amount / 100}`);
}

module.exports = { createDepositToken, handleDepositCheckoutComplete, chargeNoShow };
```

- [ ] **Step 2: Smoke-test the module loads**

```bash
node -e "const d = require('./server/depositService'); console.log(Object.keys(d))"
```

Expected output:
```
[ 'createDepositToken', 'handleDepositCheckoutComplete', 'chargeNoShow' ]
```

- [ ] **Step 3: Commit**

```bash
git add server/depositService.js
git commit -m "feat: add depositService (createDepositToken, handleDepositCheckoutComplete, chargeNoShow)"
```

---

## Task 3: Add `sendDepositSMS` to `server/notificationService.js`

**Files:**
- Modify: `server/notificationService.js`

- [ ] **Step 1: Add the function before `module.exports`**

Find the line `module.exports = {` near the bottom of `server/notificationService.js`.
Insert this function directly above it:

```js
// ── sendDepositSMS ────────────────────────────────────────────────────────────
async function sendDepositSMS(customerPhone, customerName, businessName, depositAmountDollars, depositUrl, fromPhone) {
  const message = `Hi ${customerName}, your ${businessName} appointment is confirmed! To secure your spot with a $${depositAmountDollars} deposit, tap: ${depositUrl}\n(Only charged if you miss your appointment.)`;

  try {
    await twilioClient.messages.create({
      body: message,
      from: fromPhone,
      to: customerPhone,
    });
    console.log(`💳 Deposit SMS sent to ${customerPhone}`);
    return true;
  } catch (error) {
    console.error('Deposit SMS error:', error);
    return false;
  }
}
```

Then add `sendDepositSMS` to the `module.exports` object:

```js
module.exports = {
  sendCustomerSMS,
  sendOwnerEmail,
  sendWelcomeEmail,
  sendInternalSignupNotification,
  sendPaymentFailedEmail,
  sendDepositSMS,   // ← add this line
};
```

- [ ] **Step 2: Verify the module loads**

```bash
node -e "const n = require('./server/notificationService'); console.log(typeof n.sendDepositSMS)"
```

Expected: `function`

- [ ] **Step 3: Commit**

```bash
git add server/notificationService.js
git commit -m "feat: add sendDepositSMS to notificationService"
```

---

## Task 4: Update `server/bookingService.js`

**Files:**
- Modify: `server/bookingService.js`

This task has two parts: (A) accept `depositStatus` in `saveBooking`, and (B) trigger the deposit token + SMS after a successful insert.

- [ ] **Step 1: Add depositService import at the top of bookingService.js**

After the existing `createClient` require (line 1), add:

```js
const depositService    = require('./depositService');
const notificationService = require('./notificationService');
```

Note: There is no circular dependency here — `depositService` does not require `bookingService`.

- [ ] **Step 2: Update `saveBooking()` to accept `depositStatus`**

Find the `saveBooking` function signature (currently `async function saveBooking(business, bookingData, vapiCallId)`).

Change it to:

```js
async function saveBooking(business, bookingData, vapiCallId, depositStatus = 'none') {
```

Then find the record object construction (the `const record = {` block). After the `status: 'confirmed'` line, add:

```js
    deposit_status: depositStatus,
```

The record object should now look like:
```js
  const record = {
    business_id:      business.id,
    customer_name:    bookingData.name,
    customer_phone:   bookingData.customerPhone,
    service_ids:      [bookingData.service],
    appointment_date: convertToISODate(bookingData.date),
    appointment_time: convertTo24HourTime(bookingData.time),
    special_requests: bookingData.specialRequests,
    vapi_call_id:     vapiCallId,
    status:           'confirmed',
    deposit_status:   depositStatus,
  };
```

- [ ] **Step 3: Add deposit SMS trigger after successful insert**

Find the two places where `saveBooking` returns after a successful insert. Both are after the `upsertClient` call:

**First return** (inside the retry block, ~line 279):
```js
      console.log('Booking saved successfully:', retry.data.id);
      await upsertClient(business, bookingData);
      return retry.data;
```

**Second return** (main path, ~line 293):
```js
  console.log('Booking saved successfully:', data.id);
  await upsertClient(business, bookingData);
  return data;
```

Add the following code after `await upsertClient(...)` and before each `return`. The two paths use different variable names for the saved booking — use the correct one for each:

**In the retry block** (first return, uses `retry.data`):
```js
      // Send deposit SMS if deposits are enabled for this business
      if (depositStatus === 'pending' && business.deposit_enabled) {
        try {
          const token = depositService.createDepositToken(retry.data);
          const depositUrl = `${process.env.BASE_URL || 'https://bookingagent-gmo2.onrender.com'}/deposit/${token}`;
          const amountDollars = Math.round(business.deposit_amount / 100);
          await notificationService.sendDepositSMS(
            bookingData.customerPhone,
            bookingData.name,
            business.name,
            amountDollars,
            depositUrl,
            business.twilio_phone
          );
        } catch (depositErr) {
          console.warn('⚠️  Deposit SMS failed (non-blocking):', depositErr.message);
        }
      }
      return retry.data;
```

**In the main path** (second return, uses `data`):
```js
  // Send deposit SMS if deposits are enabled for this business
  if (depositStatus === 'pending' && business.deposit_enabled) {
    try {
      const token = depositService.createDepositToken(data);
      const depositUrl = `${process.env.BASE_URL || 'https://bookingagent-gmo2.onrender.com'}/deposit/${token}`;
      const amountDollars = Math.round(business.deposit_amount / 100);
      await notificationService.sendDepositSMS(
        bookingData.customerPhone,
        bookingData.name,
        business.name,
        amountDollars,
        depositUrl,
        business.twilio_phone
      );
    } catch (depositErr) {
      console.warn('⚠️  Deposit SMS failed (non-blocking):', depositErr.message);
    }
  }
  return data;
```

- [ ] **Step 4: Update the callers in `server/index.js`**

In `server/index.js`, find the two calls to `saveBooking`. Both are in the Vapi webhook handler.

Change each from:
```js
const booking = await saveBooking(business, bookingData, vapiCallId);
```
to:
```js
const depositStatus = business.deposit_enabled ? 'pending' : 'none';
const booking = await saveBooking(business, bookingData, vapiCallId, depositStatus);
```

Search for `saveBooking(business` to find both call sites.

- [ ] **Step 5: Verify the module loads**

```bash
node -e "const b = require('./server/bookingService'); console.log(typeof b.saveBooking)"
```

Expected: `function`

- [ ] **Step 6: Commit**

```bash
git add server/bookingService.js server/index.js
git commit -m "feat: pass depositStatus through saveBooking and trigger deposit SMS"
```

---

## Task 5: Update `server/dashboardRoutes.js`

**Files:**
- Modify: `server/dashboardRoutes.js`

Three sub-tasks: (A) add deposit fields to GET/PUT business, (B) add no-show route, (C) add waive-deposit route. Also import depositService.

- [ ] **Step 1: Add depositService import**

Near the top of `dashboardRoutes.js`, after the existing `const stripe = require('stripe')(...)` line, add:

```js
const depositService = require('./depositService');
```

- [ ] **Step 2: Add `deposit_enabled` and `deposit_amount` to GET /api/business column select**

Find the `router.get('/api/business'` block (around line 18). The `.select([...].join(', '))` call has an explicit column list. Add `'deposit_enabled'` and `'deposit_amount'` to the array:

```js
    const { data: business, error } = await supabase
      .from('businesses')
      .select([
        'id', 'name', 'owner_name', 'email', 'phone', 'address',
        'business_hours', 'ai_name', 'business_type', 'billing_email',
        'subscription_status', 'trial_ends_at', 'stripe_customer_id',
        'stripe_subscription_id', 'is_active', 'created_at', 'call_recording_enabled', 'supported_languages',
        'twilio_phone', 'timezone', 'barbers', 'plan',
        'deposit_enabled', 'deposit_amount'   // ← add these two
      ].join(', '))
```

- [ ] **Step 3: Add `deposit_enabled` and `deposit_amount` to PUT /api/business allowlist**

Find the `router.put('/api/business'` block (around line 41). The `const allowed = [...]` array currently has 8 fields. Add the two deposit fields:

```js
  const allowed = ['name', 'phone', 'address', 'business_hours', 'ai_name', 'business_type', 'timezone', 'barbers',
                   'deposit_enabled', 'deposit_amount'];
```

- [ ] **Step 4: Add POST /api/bookings/:id/no-show**

Find the end of the existing clients routes section (the last `router.*` call in the file). Add the new routes after it, before `module.exports`:

```js
// ── Deposit: No-Show ──────────────────────────────────────────────────────────

// POST /api/bookings/:id/no-show — charge no-show deposit
router.post('/api/bookings/:id/no-show', async (req, res) => {
  try {
    // Fetch booking and verify ownership
    const { data: booking, error: bErr } = await supabase
      .from('bookings')
      .select('*')
      .eq('id', req.params.id)
      .eq('business_id', req.business.id)
      .single();

    if (bErr || !booking) return res.status(404).json({ error: 'Booking not found.' });
    if (booking.deposit_status !== 'secured') {
      return res.status(400).json({ error: 'Deposit must be in "secured" state to charge.' });
    }

    // Fetch business for deposit_amount
    const { data: business, error: bizErr } = await supabase
      .from('businesses')
      .select('deposit_amount')
      .eq('id', req.business.id)
      .single();

    if (bizErr || !business) return res.status(500).json({ error: 'Failed to fetch business.' });

    await depositService.chargeNoShow(booking, business);

    const { data: updated } = await supabase
      .from('bookings')
      .select('*')
      .eq('id', req.params.id)
      .single();

    res.json({ booking: updated });
  } catch (err) {
    console.error('POST /api/bookings/:id/no-show error:', err.message);
    // Use 402 for Stripe charge failures, 500 for everything else
    const status = err.message?.toLowerCase().includes('card') ||
                   err.message?.toLowerCase().includes('payment') ? 402 : 500;
    res.status(status).json({ error: err.message || 'Failed to charge no-show deposit.' });
  }
});

// POST /api/bookings/:id/waive-deposit — mark deposit as waived (no charge)
router.post('/api/bookings/:id/waive-deposit', async (req, res) => {
  try {
    const { data: booking, error: bErr } = await supabase
      .from('bookings')
      .select('id, deposit_status, business_id')
      .eq('id', req.params.id)
      .eq('business_id', req.business.id)
      .single();

    if (bErr || !booking) return res.status(404).json({ error: 'Booking not found.' });

    const waiveable = ['pending', 'secured'];
    if (!waiveable.includes(booking.deposit_status)) {
      return res.status(400).json({
        error: `Cannot waive a deposit in "${booking.deposit_status}" state. Only pending or secured deposits can be waived.`
      });
    }

    const { data: updated, error: uErr } = await supabase
      .from('bookings')
      .update({ deposit_status: 'waived' })
      .eq('id', req.params.id)
      .select('*')
      .single();

    if (uErr) throw uErr;
    res.json({ booking: updated });
  } catch (err) {
    console.error('POST /api/bookings/:id/waive-deposit error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 5: Verify the module loads**

```bash
node -e "const dr = require('./server/dashboardRoutes'); console.log('OK')"
```

Expected: `OK`

- [ ] **Step 6: Commit**

```bash
git add server/dashboardRoutes.js
git commit -m "feat: add deposit fields to business API and no-show/waive-deposit routes"
```

---

## Task 6: Update `server/index.js` — deposit routes + webhook

**Files:**
- Modify: `server/index.js`

Three sub-tasks: (A) import depositService, (B) add the three deposit routes in the right order, (C) update the webhook dispatcher.

- [ ] **Step 1: Import depositService in server/index.js**

Find the block of `require()` calls at the top (around lines 19-35). Add:

```js
const { handleDepositCheckoutComplete } = require('./depositService');
```

- [ ] **Step 2: Add deposit routes**

Find the line `app.use(express.json());` (around line 224 — right after the Stripe webhook block). Add the following block directly above that line. The position relative to `app.use(express.json())` is not significant (deposit routes do not parse a request body) — the only ordering constraint is within the deposit block itself: `/deposit/success` and `/deposit/cancel` MUST be registered before `/deposit/:token` so Express doesn't match the literal strings as token values.

Also add `const BASE_URL = process.env.BASE_URL || 'https://bookingagent-gmo2.onrender.com';` at the very start of this block — it is NOT already defined in `index.js` (it lives in `billingService.js`).

```js
// ── Deposit routes (public — no auth required) ────────────────────────────────
// BASE_URL is NOT defined elsewhere in index.js — define it here.
const BASE_URL = process.env.BASE_URL || 'https://bookingagent-gmo2.onrender.com';
// Declare these once at block scope — not inside each handler.
const jwt          = require('jsonwebtoken');
const depositStripe = require('stripe')(
  process.env.TEST_MODE === 'true'
    ? process.env.STRIPE_TEST_SECRET_KEY
    : process.env.STRIPE_SECRET_KEY
);

// IMPORTANT: /deposit/success and /deposit/cancel MUST be registered before
// /deposit/:token, or Express will match the literal strings as token values.

app.get('/deposit/success', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Deposit Confirmed</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f8fafc;}
.card{background:#fff;border-radius:12px;padding:40px 32px;max-width:420px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,0.08);}
.icon{font-size:48px;margin-bottom:16px;}.title{font-size:22px;font-weight:700;color:#111827;margin:0 0 12px;}
.sub{font-size:15px;color:#6b7280;line-height:1.6;}</style>
</head>
<body><div class="card">
  <div class="icon">✅</div>
  <div class="title">Your spot is secured!</div>
  <div class="sub">Your deposit has been saved. It will only be charged if you miss your appointment without cancelling.<br><br>We look forward to seeing you!</div>
</div></body></html>`);
});

app.get('/deposit/cancel', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>No Problem</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f8fafc;}
.card{background:#fff;border-radius:12px;padding:40px 32px;max-width:420px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,0.08);}
.icon{font-size:48px;margin-bottom:16px;}.title{font-size:22px;font-weight:700;color:#111827;margin:0 0 12px;}
.sub{font-size:15px;color:#6b7280;line-height:1.6;}</style>
</head>
<body><div class="card">
  <div class="icon">💬</div>
  <div class="title">No problem!</div>
  <div class="sub">Your booking is still confirmed. To secure your spot, tap the link in the text message we sent you.</div>
</div></body></html>`);
});

app.get('/deposit/:token', async (req, res) => {
  // jwt and depositStripe are declared at the top of this block — do not re-declare.

  // 1. Validate JWT
  let bookingId;
  try {
    const payload = jwt.verify(req.params.token, process.env.JWT_SECRET);
    bookingId = payload.bookingId;
  } catch (err) {
    return res.status(400).send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Link Expired</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f8fafc;}
.card{background:#fff;border-radius:12px;padding:40px 32px;max-width:420px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,0.08);}
.icon{font-size:48px;margin-bottom:16px;}.title{font-size:22px;font-weight:700;color:#111827;margin:0 0 12px;}
.sub{font-size:15px;color:#6b7280;line-height:1.6;}</style>
</head><body><div class="card">
  <div class="icon">⏰</div>
  <div class="title">This link has expired</div>
  <div class="sub">Deposit links are valid for 24 hours. Please call us to arrange your deposit.</div>
</div></body></html>`);
  }

  try {
    // 2. Fetch booking and business
    const { data: booking } = await supabase.from('bookings').select('*').eq('id', bookingId).single();
    if (!booking) return res.status(404).send('Booking not found.');

    const { data: business } = await supabase.from('businesses').select('*').eq('id', booking.business_id).single();
    if (!business) return res.status(404).send('Business not found.');

    // 3. Create or reuse Stripe Customer
    // On repeated link taps, reuse the existing customer to avoid orphaned records.
    let customerId = booking.stripe_customer_id;
    if (!customerId) {
      const customer = await depositStripe.customers.create({
        name:     booking.customer_name,
        phone:    booking.customer_phone,
        metadata: { booking_id: booking.id },
      });
      customerId = customer.id;
    }

    // 4. Create Stripe Checkout Session (setup mode)
    // IMPORTANT: do NOT include business_id in metadata — only booking_id.
    // The webhook dispatcher checks booking_id first to route deposit vs billing.
    const session = await depositStripe.checkout.sessions.create({
      mode:        'setup',
      customer:    customerId,
      metadata:    { booking_id: booking.id },
      success_url: `${BASE_URL}/deposit/success`,
      cancel_url:  `${BASE_URL}/deposit/cancel`,
    });

    // 5. Redirect
    res.redirect(session.url);
  } catch (err) {
    console.error('❌ GET /deposit/:token error:', err.message);
    res.status(500).send('Something went wrong. Please try again or call us directly.');
  }
});
```

**Note:** `supabase` is already defined at the top of `server/index.js`. `BASE_URL` was defined at the top of this deposit block above — do not redeclare it inside the route handler.

- [ ] **Step 3: Update the Stripe webhook dispatcher**

Find the `checkout.session.completed` handler inside the webhook block (currently around line 170):

```js
    if (event.type === 'checkout.session.completed') {
      await handleCheckoutCompleted(event.data.object);
    }
```

Replace it with:

```js
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      if (session.metadata?.booking_id) {
        // Deposit flow — booking_id present, business_id absent
        await handleDepositCheckoutComplete(session);
      } else {
        // Billing flow — business_id present, booking_id absent
        await handleCheckoutCompleted(session);
      }
    }
```

- [ ] **Step 4: Verify server starts without errors**

```bash
node -e "
process.env.SUPABASE_URL='https://example.supabase.co';
process.env.SUPABASE_KEY='test';
process.env.JWT_SECRET='test';
process.env.STRIPE_SECRET_KEY='sk_test_placeholder';
const idx = require('./server/index');
console.log('OK');
" 2>&1 | head -5
```

(If you see module-not-found errors rather than missing env errors, fix them before continuing.)

- [ ] **Step 5: Commit**

```bash
git add server/index.js
git commit -m "feat: add /deposit routes and update Stripe webhook for deposit sessions"
```

---

## Task 7: Update `dashboard/app.jsx` — Settings deposit section

**Files:**
- Modify: `dashboard/app.jsx`

- [ ] **Step 1: Add deposit state to SettingsPage**

In `SettingsPage` (around line 323), find the existing state declarations:
```js
  const [recordSaving, setRecordSaving] = useState(false);
  const [recordMsg, setRecordMsg]       = useState('');
```

Add after them:
```js
  const [depositEnabled, setDepositEnabled] = useState(false);
  const [depositAmount, setDepositAmount]   = useState('25');
  const [depositSaving, setDepositSaving]   = useState(false);
  const [depositMsg, setDepositMsg]         = useState('');
```

- [ ] **Step 2: Populate deposit state from API response**

In the `.then(([b, s]) => { ... })` block (around line 341), after `setBarbers(biz.barbers || [])`, add:

```js
        setDepositEnabled(!!biz.deposit_enabled);
        setDepositAmount(biz.deposit_amount != null ? String(Math.round(biz.deposit_amount / 100)) : '25');
```

- [ ] **Step 3: Add handleDepositSave function**

After the `handleRecordingToggle` function definition, add:

```js
  const handleDepositSave = async () => {
    setDepositSaving(true);
    setDepositMsg('');
    try {
      await apiFetch('/api/business', {
        method: 'PUT',
        body: JSON.stringify({
          deposit_enabled: depositEnabled,
          deposit_amount:  Math.round(parseFloat(depositAmount || '0') * 100),
        }),
      });
      setDepositMsg('Saved!');
      setTimeout(() => setDepositMsg(''), 2500);
    } catch {
      setDepositMsg('Failed to save.');
    } finally {
      setDepositSaving(false);
    }
  };
```

- [ ] **Step 4: Add the No-Show Deposits card to the Settings JSX**

Find the Team Members card section (around line 585). The deposit card goes immediately after the closing `}` of the Team Members section (after the `</div>` or `</div>}` that ends it), and before the `{/* ── AI Agent Settings ── */}` comment.

Add:

```jsx
      {/* ── No-Show Deposits ── */}
      <div className="card">
        <div className="card-header">No-Show Deposits</div>
        <p className="card-note">
          When enabled, customers receive a text with a secure link to save a card on file after booking.
          The deposit is only charged if you mark them as a no-show.
        </p>

        <div className="settings-grid">
          <div className="form-group full-width">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <input
                type="checkbox"
                id="depositToggle"
                checked={depositEnabled}
                onChange={e => setDepositEnabled(e.target.checked)}
                style={{ width: 16, height: 16, cursor: 'pointer', accentColor: '#534AB7' }}
              />
              <label htmlFor="depositToggle" style={{ margin: 0, fontWeight: 400, fontSize: 14, color: '#374151', cursor: 'pointer' }}>
                Require a deposit to secure bookings
              </label>
            </div>

            {depositEnabled && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <label style={{ fontSize: 14, color: '#374151', minWidth: 130 }}>Deposit amount (CA$)</label>
                  <input
                    type="number"
                    min="1"
                    value={depositAmount}
                    onChange={e => setDepositAmount(e.target.value)}
                    style={{ width: 90, padding: '6px 10px', border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 14 }}
                  />
                </div>
                <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6, padding: '10px 14px', fontSize: 13, color: '#92400e', marginBottom: 8 }}>
                  ⚠️ Remember to update your Vapi assistant prompt to mention the deposit policy.
                </div>
              </>
            )}
          </div>
        </div>

        <div className="save-row">
          <button className="btn-primary" onClick={handleDepositSave} disabled={depositSaving}>
            {depositSaving ? 'Saving...' : 'Save Deposit Settings'}
          </button>
          {depositMsg && (
            <span className={`save-msg ${depositMsg === 'Saved!' ? 'success' : 'error'}`}>{depositMsg}</span>
          )}
        </div>
      </div>
```

- [ ] **Step 5: Quick browser test**

Start the server locally (or push to Render), open the dashboard, go to Settings, and verify:
- "No-Show Deposits" card appears
- Toggling the checkbox shows/hides the amount input and warning
- Saving calls `PUT /api/business` and returns "Saved!"

- [ ] **Step 6: Commit**

```bash
git add dashboard/app.jsx
git commit -m "feat: add No-Show Deposits section to Settings"
```

---

## Task 8: Update `dashboard/app.jsx` — BookingsTable deposit badges + actions

**Files:**
- Modify: `dashboard/app.jsx`

- [ ] **Step 1: Add DepositBadge helper component**

Find the `function BookingsTable` definition (line 143). Directly above it, add:

```jsx
// ── DepositBadge ──────────────────────────────────────────────────────────────
function DepositBadge({ status }) {
  if (!status || status === 'none') return null;
  const styles = {
    pending:  { background: '#fef9c3', color: '#854d0e', border: '1px solid #fde68a' },
    secured:  { background: '#dcfce7', color: '#166534', border: '1px solid #bbf7d0' },
    charged:  { background: '#fee2e2', color: '#991b1b', border: '1px solid #fecaca' },
    waived:   { background: '#f3f4f6', color: '#6b7280', border: '1px solid #e5e7eb' },
  };
  const labels = { pending: 'Deposit Pending', secured: 'Secured', charged: 'Charged', waived: 'Waived' };
  const s = styles[status] || styles.waived;
  return (
    <span style={{ ...s, fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 10, whiteSpace: 'nowrap' }}>
      {labels[status] || status}
    </span>
  );
}
```

- [ ] **Step 2: Update BookingsTable to accept onDepositAction prop and show deposit column**

The `BookingsTable` function signature currently is:
```js
function BookingsTable({ bookings, clients = [], onClientClick }) {
```

Change to:
```js
function BookingsTable({ bookings, clients = [], onClientClick, onDepositAction }) {
```

In the `<thead>` row, find the `<th>Status</th>` header. After it, add:
```jsx
            <th>Deposit</th>
```

In the `<tbody>`, find the Status `<td>`:
```jsx
              <td>{String(b.status || '—')}</td>
```

After it, add:
```jsx
              <td>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <DepositBadge status={b.deposit_status} />
                  {b.deposit_status === 'secured' && onDepositAction && (
                    <div style={{ display: 'flex', gap: 4, marginTop: 2 }}>
                      <button
                        className="filter-btn"
                        style={{ fontSize: 11, padding: '2px 8px', color: '#991b1b', background: '#fee2e2', border: 'none' }}
                        onClick={() => {
                          if (window.confirm(`Charge no-show deposit for ${b.customer_name}?`)) {
                            onDepositAction(b.id, 'no-show');
                          }
                        }}
                      >No-Show</button>
                      <button
                        className="filter-btn"
                        style={{ fontSize: 11, padding: '2px 8px' }}
                        onClick={() => onDepositAction(b.id, 'waive')}
                      >Waive</button>
                    </div>
                  )}
                </div>
              </td>
```

- [ ] **Step 3: Add handleDepositAction to BookingsPage**

In `BookingsPage` (around line 259), add the deposit action handler and wire it to BookingsTable.

After the existing state declarations, add:

```js
  const handleDepositAction = async (bookingId, action) => {
    const endpoint = action === 'no-show'
      ? `/api/bookings/${bookingId}/no-show`
      : `/api/bookings/${bookingId}/waive-deposit`;
    try {
      const r = await apiFetch(endpoint, { method: 'POST' });
      const d = await r.json();
      if (!r.ok) { alert(d.error || 'Action failed.'); return; }
      setBookings(prev => prev.map(b => b.id === bookingId ? d.booking : b));
    } catch { alert('Network error.'); }
  };
```

Find all `<BookingsTable` renders in `BookingsPage` and add the `onDepositAction` prop:
```jsx
<BookingsTable
  bookings={bookings}
  clients={clients}
  setPage={setPage}
  onClientClick={...}
  onDepositAction={handleDepositAction}
/>
```

(There may be multiple renders of BookingsTable in BookingsPage — add the prop to all of them.)

- [ ] **Step 4: Browser test**

In Supabase, manually set `deposit_status = 'secured'` on a test booking row. Reload the Bookings page and verify:
- Green "Secured" badge appears
- "No-Show" and "Waive" buttons appear
- Clicking "No-Show" shows a confirm dialog
- Clicking "Waive" updates the badge to grey "Waived" immediately

- [ ] **Step 5: Commit**

```bash
git add dashboard/app.jsx
git commit -m "feat: add deposit badges and no-show/waive actions to BookingsTable"
```

---

## Task 9: Update `dashboard/app.jsx` — ClientProfilePage deposit badges + actions

**Files:**
- Modify: `dashboard/app.jsx`

- [ ] **Step 1: Add handleDepositAction to ClientProfilePage**

In `ClientProfilePage` (around line 1452), after the existing state declarations and before the `useEffect`, add:

```js
  const handleDepositAction = async (bookingId, action) => {
    const endpoint = action === 'no-show'
      ? `/api/bookings/${bookingId}/no-show`
      : `/api/bookings/${bookingId}/waive-deposit`;
    try {
      const r = await apiFetch(endpoint, { method: 'POST' });
      const d = await r.json();
      if (!r.ok) { alert(d.error || 'Action failed.'); return; }
      setBookings(prev => prev.map(b => b.id === bookingId ? d.booking : b));
    } catch { alert('Network error.'); }
  };
```

- [ ] **Step 2: Update the booking history table in ClientProfilePage**

Find the booking history table thead (around line 1604):
```jsx
              <thead>
                <tr><th>Date</th><th>Time</th><th>Service</th><th>Team Member</th><th>Special Requests</th></tr>
              </thead>
```

Change to:
```jsx
              <thead>
                <tr><th>Date</th><th>Time</th><th>Service</th><th>Team Member</th><th>Special Requests</th><th>Deposit</th></tr>
              </thead>
```

Find the tbody row (around line 1608):
```jsx
                  <tr key={b.id}>
                    <td>{...}</td>
                    <td>{b.appointment_time || '—'}</td>
                    <td>{...}</td>
                    <td>{b.preferred_barber || '—'}</td>
                    <td className="cell-requests">{b.special_requests || '—'}</td>
                  </tr>
```

Add a deposit cell after `<td className="cell-requests">...`:
```jsx
                    <td>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <DepositBadge status={b.deposit_status} />
                        {b.deposit_status === 'secured' && (
                          <div style={{ display: 'flex', gap: 4, marginTop: 2 }}>
                            <button
                              className="filter-btn"
                              style={{ fontSize: 11, padding: '2px 8px', color: '#991b1b', background: '#fee2e2', border: 'none' }}
                              onClick={() => {
                                if (window.confirm(`Charge no-show deposit for ${client.name}?`)) {
                                  handleDepositAction(b.id, 'no-show');
                                }
                              }}
                            >No-Show</button>
                            <button
                              className="filter-btn"
                              style={{ fontSize: 11, padding: '2px 8px' }}
                              onClick={() => handleDepositAction(b.id, 'waive')}
                            >Waive</button>
                          </div>
                        )}
                      </div>
                    </td>
```

- [ ] **Step 3: Browser test**

Navigate to a client profile. Find a booking with `deposit_status = 'secured'` (set manually in Supabase if needed). Verify badges and action buttons appear and work correctly.

- [ ] **Step 4: Commit**

```bash
git add dashboard/app.jsx
git commit -m "feat: add deposit badges and actions to ClientProfilePage booking history"
```

---

## Task 10: Update `vapi-system-prompt.txt`

**Files:**
- Modify: `vapi-system-prompt.txt`

- [ ] **Step 1: Add the {{depositPolicy}} variable**

Open `vapi-system-prompt.txt`. Find the section that describes calling `bookAppointment`:

```
When you have collected the customer's name, desired service, preferred date and time, phone number, and callback number, you MUST call the bookAppointment function with all the collected information.
Do not end the call without calling this function if a booking was made.
```

Insert the `{{depositPolicy}}` variable on a new line between those two lines:

```
When you have collected the customer's name, desired service, preferred date and time, phone number, and callback number, you MUST call the bookAppointment function with all the collected information.
{{depositPolicy}}
Do not end the call without calling this function if a booking was made.
```

- [ ] **Step 2: Document the deposit policy template values**

Add a comment block at the top of the file (or in a new `vapi-system-prompt-notes.txt`) explaining what to paste when deposits are enabled:

> When `deposit_enabled = true`, replace `{{depositPolicy}}` with:
> "Before calling bookAppointment, let the customer know: 'Just so you know, a $[amount] deposit is required to secure your appointment. You'll receive a text message with a secure link to submit your card — the deposit is only charged if you miss your appointment without cancelling.' Then proceed with calling bookAppointment."
>
> When `deposit_enabled = false`, replace `{{depositPolicy}}` with nothing (empty string or delete the line).

- [ ] **Step 3: Commit**

```bash
git add vapi-system-prompt.txt
git commit -m "docs: add {{depositPolicy}} variable to Vapi system prompt template"
```

---

## Task 11: QA Test Script

**Files:**
- Create: `scripts/test-no-show-deposits.js`

- [ ] **Step 1: Create the test script**

```js
// scripts/test-no-show-deposits.js
// Manual end-to-end QA script for the No-Show Deposits feature.
// Usage: JWT_SECRET=<secret> SUPABASE_URL=<url> SUPABASE_KEY=<key> node scripts/test-no-show-deposits.js
//
// Run against the production Render URL or a local server.

const BASE_URL = process.env.TEST_BASE_URL || 'https://bookingagent-gmo2.onrender.com';
const TOKEN    = process.env.TEST_JWT;  // dashboard auth token

if (!TOKEN) {
  console.error('Set TEST_JWT to a valid dashboard auth token. Get one by logging into the dashboard and copying the token from localStorage.');
  process.exit(1);
}

const headers = {
  'Authorization': `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
};

async function api(path, opts = {}) {
  const r = await fetch(`${BASE_URL}${path}`, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok, body };
}

async function run() {
  console.log('=== No-Show Deposits QA ===\n');

  // 1. GET /api/business — verify deposit fields are returned
  console.log('1. GET /api/business — checking deposit fields...');
  const { body: bizBody } = await api('/api/business');
  const biz = bizBody.business;
  console.assert('deposit_enabled' in biz, '❌ deposit_enabled missing from GET /api/business');
  console.assert('deposit_amount'  in biz, '❌ deposit_amount missing from GET /api/business');
  console.log('   deposit_enabled:', biz.deposit_enabled, '  deposit_amount:', biz.deposit_amount);
  console.log('   ✅ deposit fields present\n');

  // 2. PUT /api/business — enable deposits
  console.log('2. PUT /api/business — enabling deposits at CA$25...');
  const { ok: putOk, body: putBody } = await api('/api/business', {
    method: 'PUT',
    body: JSON.stringify({ deposit_enabled: true, deposit_amount: 2500 }),
  });
  console.assert(putOk, `❌ PUT /api/business failed: ${JSON.stringify(putBody)}`);
  console.log('   ✅ Deposits enabled\n');

  // 3. Find a booking with deposit_status = 'pending' or 'secured' to test waive/no-show
  console.log('3. GET /api/bookings — looking for a test booking...');
  const { body: bookBody } = await api('/api/bookings?limit=20');
  const bookings = bookBody.bookings || [];
  const secured  = bookings.find(b => b.deposit_status === 'secured');
  const pending  = bookings.find(b => b.deposit_status === 'pending');

  if (secured) {
    console.log(`   Found secured booking: ${secured.id} (${secured.customer_name})`);

    // 4. Test waive
    console.log('\n4. POST /api/bookings/:id/waive-deposit...');
    const { ok: waiveOk, body: waiveBody } = await api(`/api/bookings/${secured.id}/waive-deposit`, { method: 'POST' });
    console.assert(waiveOk, `❌ Waive failed: ${JSON.stringify(waiveBody)}`);
    console.assert(waiveBody.booking?.deposit_status === 'waived', '❌ deposit_status not updated to waived');
    console.log('   ✅ Booking waived\n');

    // 5. Test waive a second time — should return 400
    console.log('5. Attempting to waive again (should 400)...');
    const { status: waive2Status } = await api(`/api/bookings/${secured.id}/waive-deposit`, { method: 'POST' });
    console.assert(waive2Status === 400, `❌ Expected 400, got ${waive2Status}`);
    console.log('   ✅ Double-waive correctly rejected\n');

  } else {
    console.log('   ⚠️  No secured booking found — skipping waive/no-show tests.');
    console.log('   To test: manually set deposit_status = "secured" on a booking in Supabase, then re-run.\n');
  }

  if (pending) {
    console.log(`   Found pending booking: ${pending.id} (${pending.customer_name})`);
    // 6. Verify no-show fails on pending (no payment method)
    console.log('\n6. POST no-show on pending booking (should 400)...');
    const { status: noShowStatus, body: noShowBody } = await api(`/api/bookings/${pending.id}/no-show`, { method: 'POST' });
    console.assert(noShowStatus === 400, `❌ Expected 400, got ${noShowStatus}: ${JSON.stringify(noShowBody)}`);
    console.log('   ✅ No-show on pending correctly rejected\n');
  }

  // 7. Test deposit link with invalid token → expect 400 HTML
  console.log('7. GET /deposit/invalid-token (should return 400)...');
  const linkRes = await fetch(`${BASE_URL}/deposit/this-is-not-a-valid-token`);
  console.assert(linkRes.status === 400, `❌ Expected 400, got ${linkRes.status}`);
  console.log('   ✅ Invalid token returns 400\n');

  // 8. Test /deposit/success and /deposit/cancel static pages
  console.log('8. GET /deposit/success and /deposit/cancel...');
  const successRes = await fetch(`${BASE_URL}/deposit/success`);
  const cancelRes  = await fetch(`${BASE_URL}/deposit/cancel`);
  console.assert(successRes.status === 200, `❌ /deposit/success returned ${successRes.status}`);
  console.assert(cancelRes.status  === 200, `❌ /deposit/cancel returned ${cancelRes.status}`);
  console.log('   ✅ Static pages reachable\n');

  // 9. Disable deposits to clean up
  console.log('9. Disabling deposits (cleanup)...');
  await api('/api/business', {
    method: 'PUT',
    body: JSON.stringify({ deposit_enabled: false }),
  });
  console.log('   ✅ Deposits disabled\n');

  console.log('=== QA Complete ===');
  console.log('\nManual steps still needed:');
  console.log('  • Make a real test booking with deposit_enabled=true and verify the deposit SMS is received');
  console.log('  • Tap the SMS link and complete the Stripe Checkout flow');
  console.log('  • Verify booking shows "Secured" badge in dashboard');
  console.log('  • Click No-Show → verify charge in Stripe dashboard');
}

run().catch(err => { console.error('Script error:', err); process.exit(1); });
```

- [ ] **Step 2: Run the script against the deployed server**

First get a dashboard auth token:
1. Log into the dashboard
2. Open browser DevTools → Application → Local Storage → `bimbly_token`
3. Copy the token

Then run:
```bash
TEST_JWT=<your_token> TEST_BASE_URL=https://bookingagent-gmo2.onrender.com node scripts/test-no-show-deposits.js
```

Expected: All assertions pass with `✅` marks. The only `⚠️` should be for missing secured/pending test bookings.

- [ ] **Step 3: Commit and push**

```bash
git add scripts/test-no-show-deposits.js
git commit -m "feat: add no-show deposits QA test script"
git push origin main
```

---

## Final Checklist

Before calling Phase 3 complete:

- [ ] DB migration applied in Supabase (verify 6 new columns exist)
- [ ] `GET /deposit/success` and `GET /deposit/cancel` return 200
- [ ] `GET /deposit/<invalid>` returns 400 HTML
- [ ] Settings page shows No-Show Deposits card; toggle + save works
- [ ] QA script passes all automated assertions
- [ ] Manual deposit flow tested end-to-end:
  - Booking made via voice call (or manually insert test booking with `deposit_status='pending'`)
  - Deposit SMS received with valid link
  - Stripe Checkout completed → booking shows "Secured" badge
  - "No-Show" clicked → confirm dialog → Stripe charge visible in dashboard
  - "Waive" tested from both Bookings page and Client Profile
- [ ] `vapi-system-prompt.txt` updated in Vapi dashboard for Sam's Barbershop (if deposits enabled)
