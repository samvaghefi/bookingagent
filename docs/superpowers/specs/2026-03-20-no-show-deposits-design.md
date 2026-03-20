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
- After booking (when deposits are enabled), SMS the customer a Stripe Checkout link to store their card
- Display deposit status on booking rows in the Bookings table and Client Profile page
- Let owners mark a booking as no-show (triggers charge) or waive the deposit from both locations
- Update the Vapi system prompt template to mention the deposit policy when enabled

## Non-Goals (this phase)

- Per-service deposit amounts (flat fee only)
- Auto-cancellation of bookings where customer ignores the deposit SMS
- Refund flow (customer showed up but was accidentally charged)
- Automated reminders to customers who haven't submitted their card
- Vapi live tool lookup of deposit status during a call

---

## Data Model

### Migration: `scripts/migrations/add-deposit-columns.sql`

**`businesses` table — new columns:**
```sql
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS deposit_enabled boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS deposit_amount  integer DEFAULT 2500; -- cents (CA$25)
```

**`bookings` table — new columns:**
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

Three exported functions, all Stripe-related:

**`createDepositCheckoutSession(booking, business)`**
- Creates a signed 24h JWT (`{ bookingId }`) — the deposit token
- Returns the token (caller builds the SMS URL: `${BASE_URL}/deposit/${token}`)
- Does NOT call Stripe yet — the Stripe session is created lazily when the customer taps the link

**`handleDepositCheckoutComplete(session)`**
- Called from the Stripe webhook on `checkout.session.completed` when `session.metadata.booking_id` is present
- Saves `stripe_payment_method_id`, `stripe_customer_id` to the booking row
- Updates `deposit_status → secured`

**`chargeNoShow(booking, business)`**
- Creates and immediately captures a `PaymentIntent` against the stored `stripe_payment_method_id`
- Amount = `business.deposit_amount`; currency = `cad`
- Updates `deposit_status → charged` on success
- Throws a descriptive error on Stripe failure (card declined, etc.) — caller returns 402 to dashboard

### Changes to `server/bookingService.js`

After `saveBooking()` succeeds, if `business.deposit_enabled`:
1. Generate deposit token via `depositService.createDepositCheckoutSession()`
2. Set `deposit_status: pending` on the booking (via a follow-up Supabase update)
3. Call `notificationService.sendDepositSMS()` with the token URL
4. Existing booking confirmation SMS is still sent as normal

### Changes to `server/notificationService.js`

New function `sendDepositSMS(customerPhone, customerName, businessName, depositAmountDollars, depositUrl)`:
```
Hi [name], your [businessName] appointment is confirmed!
To secure your spot with a $[amount] deposit, tap: [url]
(Only charged if you miss your appointment.)
```

### Changes to `server/index.js`

**New public route (no auth):**
```
GET /deposit/:token
```
- Validates the JWT token; 400 if expired/invalid
- Looks up the booking and business
- Creates a Stripe Checkout Session (`mode: 'setup'`) with:
  - `metadata: { booking_id }`
  - `success_url: ${BASE_URL}/deposit/success`
  - `cancel_url: ${BASE_URL}/deposit/cancel`
- Redirects to `session.url`

**New static pages:**
```
GET /deposit/success  → simple "Your spot is secured!" HTML page
GET /deposit/cancel   → simple "No problem, link is still valid." HTML page
```

**Stripe webhook (`POST /billing/webhook`) — new event branch:**
- `checkout.session.completed`: check `session.metadata.booking_id`
  - If present → `depositService.handleDepositCheckoutComplete(session)`
  - If absent → existing billing flow (subscription activation)

### New routes in `server/dashboardRoutes.js`

```
POST /api/bookings/:id/no-show
```
- Verifies booking belongs to `req.business.id`
- Checks `deposit_status === 'secured'`; 400 if not
- Calls `depositService.chargeNoShow(booking, business)`
- Returns updated booking

```
POST /api/bookings/:id/waive-deposit
```
- Verifies ownership
- Sets `deposit_status → waived`
- Returns updated booking

---

## Frontend (`dashboard/app.jsx`)

### Settings screen — new "No-Show Deposits" section

Below the existing services section, add:
- Toggle: "Require a deposit to secure bookings" → `deposit_enabled`
- Number input: "Deposit amount (CA$)" → `deposit_amount` (displayed in dollars; stored in cents)
- Shown only when toggle is on
- Saves via existing `PUT /api/business`

### Bookings table — deposit status column

Each row with a non-`none` deposit status shows a badge:

| Status    | Badge |
|-----------|-------|
| `pending` | Yellow "Deposit Pending" |
| `secured` | Green "Secured" |
| `charged` | Red "Charged" |
| `waived`  | Grey "Waived" |

When `deposit_status === 'secured'`, the row also shows:
- **"No-Show"** button → `POST /api/bookings/:id/no-show` → updates row in place
- **"Waive"** button → `POST /api/bookings/:id/waive-deposit` → updates row in place

### Client Profile page — booking history table

Same deposit badge column and "No-Show" / "Waive" action buttons as the Bookings table, added to the existing booking history rows.

---

## Vapi System Prompt

Add a `{{depositPolicy}}` template variable to `vapi-system-prompt.txt`, inserted after the `bookAppointment` call instructions:

```
{{depositPolicy}}
```

**When `deposit_enabled = true`**, the injected value is:
> "Before calling bookAppointment, let the customer know: 'Just so you know, a $[amount] deposit is required to secure your appointment. You'll receive a text message with a secure link to submit your card — the deposit is only charged if you miss your appointment without cancelling.' Then proceed with calling bookAppointment."

**When `deposit_enabled = false`**: empty string (no mention).

The business owner updates their Vapi assistant prompt manually (copy-paste into Vapi dashboard) after toggling deposits — consistent with current prompt management.

---

## End-to-End Flow

### Happy path (customer shows up)
1. Customer calls → AI collects booking info → AI reads deposit policy → `bookAppointment` fires
2. Webhook saves booking (`deposit_status: pending`), generates signed token, SMSes deposit link + confirmation
3. Customer taps link → `GET /deposit/:token` creates Stripe Checkout Session → redirects
4. Customer enters card → Stripe fires `checkout.session.completed`
5. Webhook: `handleDepositCheckoutComplete()` → `deposit_status: secured`
6. Customer shows up → owner does nothing → payment method never charged

### No-show path
1. Steps 1–5 same as above
2. Customer no-shows → owner clicks "No-Show" in Bookings table or Client Profile
3. `POST /api/bookings/:id/no-show` → `chargeNoShow()` → PaymentIntent created + captured
4. `deposit_status: charged`

### Edge cases

| Scenario | Behaviour |
|----------|-----------|
| Customer ignores SMS | Booking stays confirmed, `deposit_status` stays `pending`, owner decides manually |
| Customer taps link after 24h | JWT expired → 400 page: "This link has expired. Please call us to arrange your deposit." |
| Charge fails (card declined) | `chargeNoShow()` throws; API returns 402 with Stripe error message; `deposit_status` unchanged |
| Business disables deposits mid-flight | Existing `pending`/`secured` bookings retain their status; new bookings get `none` |
| Booking has no stored card | "No-Show" button not shown; "Waive" still available to clear `pending` status |

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `scripts/migrations/add-deposit-columns.sql` | DB migration — run once in Supabase SQL editor |
| Create | `server/depositService.js` | All Stripe deposit logic (session, webhook handler, charge) |
| Modify | `server/bookingService.js` | Trigger deposit SMS after `saveBooking()` when deposits enabled |
| Modify | `server/notificationService.js` | Add `sendDepositSMS()` |
| Modify | `server/index.js` | Add `GET /deposit/:token` route + success/cancel pages; update Stripe webhook |
| Modify | `server/dashboardRoutes.js` | Add `POST /api/bookings/:id/no-show` and `waive-deposit` routes |
| Modify | `dashboard/app.jsx` | Deposit toggle in Settings; deposit badges + action buttons in Bookings + Client Profile |
| Modify | `vapi-system-prompt.txt` | Add `{{depositPolicy}}` variable |
