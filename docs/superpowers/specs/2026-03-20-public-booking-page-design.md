# Public Booking Page — Phase 5 Design Spec

**Date:** 2026-03-20
**Status:** Approved

---

## Overview

A public-facing, shareable booking page at `/book/[slug]` that allows customers to book appointments online without calling. Each business gets a unique slug auto-generated from their business name, editable in dashboard Settings. The page is a 4-step wizard: pick service → pick date/time → enter contact info → confirm. Availability is checked in real-time against the bookings table and Google Calendar.

---

## 1. Data Model

### `businesses` table

**New column:**
```sql
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS booking_slug text UNIQUE;
```

- Auto-generated on signup from `businessName`: lowercase, non-alphanumeric stripped, spaces → hyphens (e.g., `"Sam's Barbershop"` → `sams-barbershop`)
- Uniqueness enforced: if taken, append `-2`, `-3`, etc.
- Editable by owner in Settings; validated for uniqueness before save
- Existing businesses without a slug: `/book/:slug` returns 404 until set in Settings

**`barbers` column change (JSONB, no migration needed):**

From array of strings:
```json
["Sam", "Alex"]
```
To array of objects:
```json
[{ "name": "Sam", "calendarId": "sam@gmail.com" }, { "name": "Alex", "calendarId": "" }]
```
`calendarId` is optional per barber. The dashboard barber editor gets a "Google Calendar ID" field per barber.

### `bookings` table

No new columns. The existing `source` field is set to `'online'` for bookings made through the public page (distinguishes from `'voice'` bookings).

### `services` table

No changes. `duration_minutes` already exists and is already editable in dashboard Settings.

---

## 2. Server Routes

### Public routes (no auth)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/book/:slug` | Resolve slug → businessId, inject `window.__BOOKING_CONFIG__` into `public/book/index.html`, serve page |
| `GET` | `/api/book/:businessId/info` | Return business name, address, services (with `duration_minutes`), barber names, business hours |
| `GET` | `/api/book/:businessId/availability` | Return available time slots. Query params: `date=YYYY-MM-DD`, `duration=N` (minutes), `barberName=Sam` (optional) |
| `POST` | `/api/book/:businessId` | Create booking, trigger notifications (SMS + email + calendar), trigger deposit flow if `deposit_enabled` |

### Auth-required routes (added to `dashboardRoutes.js`)

| Method | Path | Description |
|--------|------|-------------|
| `PUT` | `/api/business/slug` | Validate uniqueness and save `booking_slug` for the authenticated business |

### Static file

`public/book/index.html` — self-contained wizard page. No bundler. Vanilla JS only (no React — lighter than dashboard needs). Served statically; slug/businessId injected via `window.__BOOKING_CONFIG__` at request time.

---

## 3. Client-Side Wizard Flow

State is held in a plain JS `bookingState` object. Steps are show/hide divs with a progress indicator at the top. Page fetches `GET /api/book/:businessId/info` on load.

### Step 1 — Pick a Service
- Renders service cards: name, price, duration
- Selecting a service stores `{ serviceId, serviceName, price, duration_minutes }` in `bookingState` and advances to step 2

### Step 2 — Pick a Date & Time
- Native `<input type="date">` with `min` = today
- On date change: fetches `/api/book/:businessId/availability?date=...&duration={service.duration_minutes}&barberName={barberName if already chosen}`
- Renders available slots as a button grid; unavailable slots shown greyed-out and non-clickable (not hidden — showing demand density is better UX)
- Selecting a slot stores `{ date, time }` and advances to step 3

### Step 3 — Contact Info
Fields:
- Name (required)
- Phone (required)
- Email (optional)
- Preferred barber (optional dropdown, populated from `info` payload)
- Special requests (optional textarea)

When barber preference changes, re-fetches availability for the current date with the new `barberName` param. If the previously chosen slot is no longer available for the selected barber, an inline warning banner appears on Step 3 ("Your selected time is no longer available for [barber]. Please pick a new time.") with a "Change time" button. Clicking it reverts the step counter to Step 2 and clears the slot selection so the customer can re-pick. If the slot remains available, no change to the UI.

### Step 4 — Confirm
- Summary card: service, date/time, barber (if chosen), name, phone
- "Confirm Booking" button POSTs to `/api/book/:businessId`
- On success:
  - If `deposit_required: true` in response → redirect to `/deposit/:token`
  - Otherwise → show inline confirmation screen with booking details
- On error → show inline error message, allow retry

---

## 4. Availability Logic

### `GET /api/book/:businessId/availability?date=YYYY-MM-DD&duration=N&barberName=Sam`

1. Fetch business hours for the requested day of week from `business_hours` JSON
2. If business is closed that day → return `{ slots: [], closed: true }`
3. Generate candidate slots at 30-minute intervals within open hours. If `date` is today, exclude slots in the past.
4. Exclude slots where remaining open time is less than `duration` minutes.
5. Fetch existing bookings for the business on that date from `bookings` table:
   - If `barberName` param present: filter to `preferred_barber = barberName` — a slot is unavailable if that barber has a conflicting booking
   - If no `barberName`: fetch all bookings for the business that day. For each candidate slot, count how many existing bookings overlap it using the same interval formula (`booking_start < slot_end AND booking_end > slot_start`, where `booking_end = booking_start + booking_duration`). A slot is unavailable only if the overlap count equals or exceeds the total number of barbers (i.e., all barbers are occupied simultaneously). For a 3-barber shop, a slot with 2 overlapping bookings is still available.
6. **Google Calendar free/busy check:**
   - If `barberName` param present: look up that barber's `calendarId` from `businesses.barbers`; if a `calendarId` is set, call the Google Calendar free/busy API. Use the token refresh logic already in `calendarService.js` to obtain a valid access token before the call (stored tokens expire in ~1 hour). If the token cannot be refreshed, log a warning and fall back to bookings-only silently.
   - If no `barberName` (or barber has no `calendarId`): check the business's main Google Calendar free/busy using the same refreshed token path
   - If no Google token is connected for the business: skip calendar check silently
   - Merge calendar busy windows with bookings conflicts
7. For each candidate slot: mark unavailable if `slot_start < conflict_end AND slot_end > conflict_start` for any conflict
8. Return:
```json
{
  "closed": false,
  "slots": [
    { "time": "09:00", "available": true },
    { "time": "09:30", "available": false },
    ...
  ]
}
```

**Timezone:** All slot generation and "past slot" exclusion uses the business's `timezone` field (e.g., `America/Toronto`). The server converts the requested date to the business's local time before generating slots, and compares against the current time in that timezone when excluding past slots. If `timezone` is not set on the business, default to `America/Toronto`.

**Fallbacks:**
- `duration` param missing or null → default to 60 minutes
- `duration_minutes` not set on a service → default to 60 minutes
- Google Calendar API error → log warning, fall back to bookings-only check (do not surface error to customer)
- `businesses.barbers` is an array of strings (old format) → normalize to objects on read: `"Sam"` → `{ name: "Sam", calendarId: "" }`. The `PUT /api/business` endpoint writes objects only going forward; old string entries are not preserved. Dashboard barber editor always writes the object format.

---

## 5. Booking Creation

### `POST /api/book/:businessId`

Request body:
```json
{
  "customerName": "Alex Kim",
  "customerPhone": "+14165550001",
  "customerEmail": "alex@example.com",
  "service": "Haircut",
  "serviceId": "uuid",
  "appointmentDate": "2026-03-25",
  "appointmentTime": "10:00",
  "preferredBarber": "Sam",
  "specialRequests": "",
  "duration_minutes": 45
}
```

Server:
1. Validate required fields (name, phone, date, time, service)
2. Fetch the business record from Supabase (needed for `deposit_enabled`, `name`, and notification fields)
3. Call `saveBooking()` with `source: 'online'`, `deposit_status: business.deposit_enabled ? 'pending' : 'none'`
4. Run notification stack: `sendCustomerSMS`, `sendOwnerEmail`, `createCalendarEvent`
5. If `deposit_enabled`: generate deposit JWT token, include `deposit_url` in response
6. Return:
```json
{
  "success": true,
  "bookingId": "uuid",
  "deposit_required": true,
  "deposit_url": "/deposit/eyJ..."
}
```

---

## 6. Dashboard Integration

### Settings screen additions

**"Your Booking Page" card:**
- Displays full shareable URL derived from `RENDER_EXTERNAL_URL` env var (e.g., `https://bookingagent-gmo2.onrender.com/book/sams-barbershop`); falls back to `http://localhost:3000` in development
- Copy-to-clipboard button
- "Open Page" button (opens in new tab)
- Slug editor: text input + "Save" button → `PUT /api/business/slug`
  - Inline validation: slug must match `/^[a-z0-9-]+$/` (lowercase letters, numbers, hyphens only); shows error if invalid characters or already taken. `PUT /api/business/slug` returns HTTP 409 `{ error: "Slug already taken" }` for conflicts; HTTP 400 `{ error: "Invalid slug format" }` for bad characters.
  - Success state: confirms new URL

**Barber editor update:**
- Each barber row gains an optional "Google Calendar ID" text field (placeholder: `e.g. name@gmail.com`)
- Saved via the existing `PUT /api/business` endpoint (barbers array)

### Slug generation (on signup)

In `signupService.js`:
```js
function generateSlug(name) {
  return name.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}
```
Uniqueness loop: check `businesses` table; if taken, append `-2`, `-3`, etc.

---

## 7. New Files

| File | Purpose |
|------|---------|
| `public/book/index.html` | Self-contained 4-step booking wizard |
| `server/bookingPageRoutes.js` | Public booking routes (`/book/:slug`, `/api/book/*`) |

`server/index.js` mounts `bookingPageRoutes`. `server/dashboardRoutes.js` gets `PUT /api/business/slug`.

---

## 8. Out of Scope (this phase)

- Backfilling slugs for existing businesses (they set their own in Settings)
- Per-barber OAuth / individual Google Calendar connections
- Booking cancellation / rescheduling from the public page
- Email confirmation to customer (SMS only, matching voice booking behaviour)
- Captcha / bot protection
