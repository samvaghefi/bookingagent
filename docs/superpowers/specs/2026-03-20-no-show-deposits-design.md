# No-Show Deposits — Design Spec

**Date:** 2026-03-20
**Project:** BookingAgent (Bimbly)
**Status:** Approved for implementation

---

## Overview

Add a no-show deposit system to BookingAgent. When a business enables deposits, the AI voice agent mentions the deposit policy during the call. After booking, the customer receives an SMS with a Stripe Checkout link to submit their card (stored as a payment method — not charged upfront). If the customer no-shows, the business owner triggers a charge from the dashboard. If they show up, the stored payment method is never used.

---

## Goals

- Allow business owners to enable a flat deposit fee in Settings
- After booking (when deposits enabled), SMS the customer a Stripe Checkout link to store their card
- Display deposit status on booking rows in the Bookings table and Client Profile page
- Let owners mark a booking as no-show (triggers charge) or waive the deposit from both locations
- Update the Vapi system prompt template to mention the deposit policy when enabled

## Non-Goals (this phase)

- Per-service deposit amounts (flat fee only)
- Auto-cancellation of bookings where customer ignores the deposit SMS
- Automated reminders to customers who haven't submitted their card
- Refund flow (customer showed up but was accidentally charged)
- Vapi live tool lookup of deposit status during a call

---

## Data Model

### Migration: `scripts/migrations/add-deposit-columns.sql`

**`businesses` table:**
```sql
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS deposit_enabled boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS deposit_amount  integer DEFAULT 2500; -- cents (CA$25)
```

**`bookings` table:**
```sql
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS deposit_status           text DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS stripe_setup_intent_id   text,
  ADD COLUMN IF NOT EXISTS stripe_payment_method_id text,
  ADD COLUMN IF NOT EXISTS stripe_customer_id       text;
```

### Deposit status values

| Value     | Meaning |
|-----------|---------|
| `none`    | Deposits not enabled for this business when booking was made |
| `pending` | SMS sent, customer has not yet submitted card |
| `secured` | Customer submitted card; payment method stored in Stripe |
| `charged` | Owner triggered no-show charge; customer was charged |
| `waived`  | Owner manually cleared the deposit (no charge) |

---

## Backend

### New file: `server/depositService.js`

Initialize Stripe using the same TEST_MODE-aware pattern as `billingService.js`:

```js
const stripe = require('stripe')(
  process.env.TEST_MODE === 'true'
    ? process.env.STRIPE_TEST_SECRET_KEY
    : process.env.STRIPE_SECRET_KEY
);
```

Three exported functions:

**`createDepositToken(booking, business)`**
- Creates a signed 24h JWT `{ bookingId }` using `JWT_SECRET`
- Returns the token string — caller builds the SMS URL: `${BASE_URL}/deposit/${token}`
- Does NOT call Stripe — the Stripe session is created lazily when the customer taps the link

**`handleDepositCheckoutComplete(session)`**
- Called from Stripe webhook when `session.metadata.booking_id` is present
- Saves `stripe_payment_method_id`, `stripe_customer_id` (from `session.customer`), and `stripe_setup_intent_id` (from `session.setup_intent`) to the booking row
- Updates `deposit_status → secured`

**`chargeNoShow(booking, business)`**
- Creates and immediately captures a PaymentIntent against the stored payment method and customer:
  ```js
  stripe.paymentIntents.create({
    amount: business.deposit_amount,
    currency: 'cad',
    customer: booking.stripe_customer_id,       // required — set during Checkout
    payment_method: booking.stripe_payment_method_id,
    confirm: true,
    off_session: true,
  })
  ```
- `booking.stripe_customer_id` is always non-null for `secured` bookings (guaranteed by the customer creation step in `GET /deposit/:token`)
- Updates `deposit_status → charged` on success
- Throws a descriptive error on Stripe failure (card declined etc.) — caller returns `{ error: "Card declined. Please contact the customer." }` with HTTP 402 to dashboard

### Changes to `server/bookingService.js`

Modify `saveBooking()` to accept an optional `depositStatus` parameter (default `'none'`). Include it directly in the INSERT record so the initial row is created with the correct status — no follow-up UPDATE needed.

Caller sets `depositStatus: business.deposit_enabled ? 'pending' : 'none'` before calling `saveBooking()`.

After the insert succeeds, if `business.deposit_enabled`:
1. Call `depositService.createDepositToken(booking, business)` to get the signed token
2. Build the deposit URL: `${BASE_URL}/deposit/${token}`
3. Call `notificationService.sendDepositSMS(...)` with the URL
4. The existing booking confirmation SMS is still sent as normal

### Changes to `server/notificationService.js`

New function `sendDepositSMS(customerPhone, customerName, businessName, depositAmountDollars, depositUrl)`:

```
Hi [name], your [businessName] appointment is confirmed!
To secure your spot with a $[amount] deposit, tap: [url]
(Only charged if you miss your appointment.)
```

### Changes to `server/dashboardRoutes.js`

**`GET /api/business`** — add `deposit_enabled` and `deposit_amount` to the explicit column select list so the Settings UI can read current values on load.

**`PUT /api/business`** — add `deposit_enabled` and `deposit_amount` to the explicit allowlist of updatable fields.

**New routes:**

```
POST /api/bookings/:id/no-show
```
- Verifies booking belongs to `req.business.id`
- Checks `deposit_status === 'secured'`; returns 400 if not
- Calls `depositService.chargeNoShow(booking, business)`
- Returns updated booking

```
POST /api/bookings/:id/waive-deposit
```
- Verifies ownership
- Checks `deposit_status` is `pending` or `secured`; returns 400 if already `charged`, `waived`, or `none`
- Sets `deposit_status → waived`
- Returns updated booking

### Changes to `server/index.js`

**Route registration order (critical):** Static deposit pages must be registered BEFORE the dynamic token route. If registered after, Express will match `"success"` and `"cancel"` as token values, JWT validation will fail, and users will see a 400 error.

```
GET /deposit/success   ← registered first
GET /deposit/cancel    ← registered second
GET /deposit/:token    ← registered third
```

**`GET /deposit/success`** — static HTML: "Your spot is secured! We look forward to seeing you."

**`GET /deposit/cancel`** — static HTML: "No problem — your link is still valid. Tap the link in your text message to submit your deposit."

**`GET /deposit/:token`** (public, no auth required):
1. Validate JWT (signed with `JWT_SECRET`); respond with user-friendly 400 HTML page if expired or invalid
2. Look up booking and business by `bookingId` from token payload
3. Create or reuse a Stripe Customer for this booking:
   ```js
   // Reuse existing customer if this link was tapped before (e.g. back button, double-tap)
   let customerId = booking.stripe_customer_id;
   if (!customerId) {
     const customer = await stripe.customers.create({
       name: booking.customer_name,
       phone: booking.customer_phone,
       metadata: { booking_id: booking.id },
     });
     customerId = customer.id;
   }
   ```
   On first tap, `booking.stripe_customer_id` is null so a new customer is created. On repeated taps before checkout completes, the existing customer is reused — preventing orphaned Stripe Customer objects. After checkout completes, `handleDepositCheckoutComplete()` saves the customer ID to the booking, so any further taps also reuse it.
4. Create a Stripe Checkout Session in setup mode:
   ```js
   stripe.checkout.sessions.create({
     mode: 'setup',
     customer: customer.id,
     metadata: { booking_id: booking.id },
     // IMPORTANT: do NOT include business_id — deposit and billing sessions
     // are disambiguated by the presence of booking_id (see webhook section)
     success_url: `${BASE_URL}/deposit/success`,
     cancel_url: `${BASE_URL}/deposit/cancel`,
   })
   ```
5. Redirect to `session.url`

**Stripe webhook (`POST /billing/webhook`) — updated `checkout.session.completed` handler:**

Check `booking_id` first. The two flows are mutually exclusive by metadata design:

```js
if (session.metadata?.booking_id) {
  // deposit flow — booking_id present, business_id absent
  await depositService.handleDepositCheckoutComplete(session);
  return;
}
// billing flow — business_id present, booking_id absent
await handleCheckoutCompleted(session);
```

**Invariant:** Deposit checkout sessions contain ONLY `booking_id` in metadata. Billing (subscription) checkout sessions contain ONLY `business_id`. Never mix the two. This prevents the billing handler from accidentally re-provisioning an already-active business.

---

## Frontend (`dashboard/app.jsx`)

### Settings screen — new "No-Show Deposits" section

Below the existing services section, add:
- Toggle: "Require a deposit to secure bookings" → `deposit_enabled`
- Number input: "Deposit amount (CA$)" → `deposit_amount` (displayed in dollars; saved as cents via ×100)
- Amount input only shown when toggle is on
- Reminder notice when toggle is on: "Remember to update your Vapi assistant prompt to mention the deposit policy."
- Saves via `PUT /api/business`

### Bookings table — deposit status column

Each booking row with a non-`none` deposit status shows a badge:

| Status    | Badge |
|-----------|-------|
| `pending` | Yellow "Deposit Pending" |
| `secured` | Green "Secured" |
| `charged` | Red "Charged" |
| `waived`  | Grey "Waived" |

When `deposit_status === 'secured'`, the row shows:
- **"No-Show"** button → `confirm("Charge $X deposit for no-show?")` dialog → `POST /api/bookings/:id/no-show` → updates row in place
- **"Waive"** button → `POST /api/bookings/:id/waive-deposit` → updates row in place

### Client Profile page — booking history table

Same deposit badge column and confirm-gated "No-Show" / "Waive" action buttons on booking history rows (identical logic to Bookings table).

---

## Vapi System Prompt

Add a `{{depositPolicy}}` template variable to `vapi-system-prompt.txt`, inserted after the `bookAppointment` call instructions.

When `deposit_enabled = true`, the injected value is:
> "Before calling bookAppointment, let the customer know: 'Just so you know, a $[amount] deposit is required to secure your appointment. You'll receive a text message with a secure link to submit your card — the deposit is only charged if you miss your appointment without cancelling.' Then proceed with calling bookAppointment."

When `deposit_enabled = false`: empty string.

The business owner updates their Vapi assistant prompt manually (copy-paste into Vapi dashboard) after toggling deposits — consistent with current prompt management. The Settings screen reminder (described above) prompts them to do this.

---

## End-to-End Flow

### Happy path (customer shows up)
1. Customer calls → AI collects booking info → AI reads deposit policy → `bookAppointment` fires
2. Webhook: `saveBooking()` inserts booking with `deposit_status: 'pending'`
3. `createDepositToken()` generates signed 24h JWT; `sendDepositSMS()` sends Stripe link alongside confirmation SMS
4. Customer taps link → `GET /deposit/:token`: validates JWT, creates Stripe Customer, creates Checkout Session (setup mode), redirects
5. Customer enters card → Stripe fires `checkout.session.completed`
6. Webhook: checks `metadata.booking_id` → `handleDepositCheckoutComplete()` → saves payment method + customer ID → `deposit_status: secured`
7. Appointment day: customer shows up → owner does nothing → payment method never charged

### No-show path
1. Steps 1–6 same as above
2. Customer no-shows → owner clicks "No-Show" → confirm dialog → `POST /api/bookings/:id/no-show`
3. `chargeNoShow()` → PaymentIntent created + captured against stored customer + payment method
4. `deposit_status: charged`

### Edge cases

| Scenario | Behaviour |
|----------|-----------|
| Customer ignores SMS | Booking stays confirmed, `deposit_status` stays `pending`, owner decides manually |
| Customer taps link after 24h | JWT expired → user-friendly 400 HTML: "This link has expired. Please call us to arrange your deposit." |
| Charge fails (card declined) | `chargeNoShow()` throws; API returns 402 with Stripe error message; `deposit_status` unchanged |
| Business disables deposits mid-flight | Existing `pending`/`secured` bookings retain their status; new bookings get `none` |
| Booking has no stored card (`pending`) | "No-Show" button not shown; "Waive" still available to clear status |
| Billing/deposit webhook collision | Impossible by design — deposit sessions contain only `booking_id`; billing sessions contain only `business_id` |

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `scripts/migrations/add-deposit-columns.sql` | DB migration — run once in Supabase SQL editor |
| Create | `server/depositService.js` | `createDepositToken`, `handleDepositCheckoutComplete`, `chargeNoShow`; TEST_MODE-aware Stripe init |
| Modify | `server/bookingService.js` | Accept `depositStatus` param in `saveBooking()`; trigger token + deposit SMS after insert when deposits enabled |
| Modify | `server/notificationService.js` | Add `sendDepositSMS()` |
| Modify | `server/index.js` | Add `/deposit/success`, `/deposit/cancel`, `/deposit/:token` (in that order); update webhook disambiguation |
| Modify | `server/dashboardRoutes.js` | Add `deposit_enabled`/`deposit_amount` to GET + PUT `/api/business`; add `no-show` and `waive-deposit` booking routes |
| Modify | `dashboard/app.jsx` | Deposit toggle + amount input + reminder in Settings; deposit badges + confirm-gated action buttons in Bookings + Client Profile |
| Modify | `vapi-system-prompt.txt` | Add `{{depositPolicy}}` variable |
