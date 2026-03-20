# Client Profiles — Phase 2 Design Spec

**Date:** 2026-03-19
**Project:** BookingAgent (Bimbly)
**Status:** Approved for implementation

---

## Overview

Add a first-class Client Profiles feature to the BookingAgent platform. Every business gets a CRM-lite view of their customers: auto-built from incoming bookings, manually editable, searchable, and filterable by tags. The AI voice agent data layer is designed to support future profile lookup but the Vapi tool integration is out of scope for this phase.

---

## Goals

- Auto-create and upsert client records from booking webhook data
- Allow manual creation, editing, and deletion of client records in the dashboard
- Surface per-client stats (visit count, last visit, preferred service/barber) computed from bookings
- Add a "Clients" sidebar tab and a client profile detail screen
- Make customer names in the Bookings table clickable links to their profile
- Provide a backfill script to populate clients from existing bookings

## Non-Goals (this phase)

- Vapi tool to look up client profiles during a live call
- `name_locked` flag to protect manually-edited names from webhook overwrites
- Marketing or messaging features (SMS blasts, etc.)
- Automated test suite

---

## Data Model

### New table: `clients`

```sql
CREATE TABLE clients (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name        text NOT NULL,
  phone       text NOT NULL,
  notes       text,
  tags        text[] DEFAULT '{}',
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now(),
  UNIQUE (business_id, phone)
);

CREATE INDEX idx_clients_business_phone ON clients (business_id, phone);
```

**Key decisions:**
- `(business_id, phone)` is the natural unique identity — phone is the primary identifier for call-in/walk-in clients.
- `tags` stored as a Postgres `text[]` array — sufficient at current scale, no join table needed.
- Stats (visit count, last visit, preferred service/barber) are computed at query time from the `bookings` table — not denormalized onto the row.
- `updated_at` is refreshed on every upsert and manual edit — reserved for future AI lookup freshness checks.

**Migration file:** `/database/migrations/add-clients-table.sql`
Run manually in the Supabase SQL editor before deploying.

---

## Booking Webhook Integration

**File:** `server/bookingService.js → saveBooking()`

After successfully inserting a booking row, upsert the client record:

```js
try {
  await supabase
    .from('clients')
    .upsert(
      {
        business_id: business.id,
        phone: bookingData.customerPhone,
        name: bookingData.name,
        updated_at: new Date().toISOString()
      },
      {
        onConflict: 'business_id,phone',
        ignoreDuplicates: false
      }
    );
} catch (upsertErr) {
  console.warn('⚠️  Client upsert failed (non-blocking):', upsertErr.message);
}
```

**Failure isolation:** The upsert is wrapped in its own try/catch. A failure logs a warning but never throws — booking creation and the Vapi tool response are unaffected.

**Name policy:** On conflict, `name` is overwritten with the incoming booking value. A future `name_locked` boolean can protect manually-edited names; deferred to a later phase.

---

## API Endpoints

All routes added to `server/dashboardRoutes.js`. All require JWT auth (existing middleware).

### `GET /api/clients`

Returns all clients for the authenticated business with computed stats.

**Response:**
```json
{
  "clients": [
    {
      "id": "uuid",
      "name": "John Smith",
      "phone": "+16475551234",
      "notes": "Prefers morning slots",
      "tags": ["VIP"],
      "visit_count": 12,
      "last_visit": "2026-03-15",
      "preferred_service": "Haircut",
      "preferred_barber": "Mike",
      "created_at": "2025-11-01T10:00:00Z",
      "updated_at": "2026-03-15T14:30:00Z"
    }
  ]
}
```

Stats computed via a single SQL join: `bookings GROUP BY customer_phone` joined to `clients`.

### `POST /api/clients`

Manually create a client. Body: `{ name, phone, notes?, tags? }`.
Returns 409 with user-facing message if `(business_id, phone)` already exists.

### `GET /api/clients/:id`

Single client profile with full booking history.

**Response:** client object (with stats) + `bookings: []` ordered newest first.

### `PUT /api/clients/:id`

Update `name`, `phone`, `notes`, `tags`. Ownership verified (`client.business_id === req.business.id`). Returns 404 if not found/not owned.

### `DELETE /api/clients/:id`

Delete the client record. Bookings are preserved (no cascade). Returns 404 if not found/not owned.

### `GET /api/clients/:id/bookings`

Paginated booking history for a client. Supports `?limit=` and `?offset=` query params.

---

## Dashboard UI

### Sidebar

Add "Clients" tab between Bookings and Settings in the `Sidebar` component (`dashboard/app.jsx`).

### `ClientsPage` (new screen)

- **Search bar** — real-time client-side filter by name or phone over the fetched list
- **Tag filter chips** — click a tag to filter to matching clients
- **Sortable table** — columns: Name, Phone, Last Visit, Visit Count, Preferred Service, Preferred Barber, Tags
- **"Add Client" button** — inline form: name + phone (required), notes + tags (optional)
- **Row click** → navigates to `ClientProfilePage`

### `ClientProfilePage` (new screen)

- **Header** — name, phone, tags (editable inline), Edit and Delete buttons
- **Notes section** — textarea, auto-saved on blur
- **Stats strip** — Total Visits, Last Visit, Preferred Service, Preferred Barber
- **Booking history table** — date, time, service, barber, special requests; newest first
- **Delete** — confirmation modal; deletes client record only (bookings preserved)
- **Back button** → `ClientsPage`

### Bookings table change

`customer_name` becomes a clickable link. On click:
1. Match the client by phone from the already-fetched client list (or fetch `GET /api/clients` if not loaded).
2. Navigate to `ClientProfilePage` for that client.
3. If no matching client record exists (edge case during rollout), navigate to `ClientsPage` with the phone pre-filled in the search bar.

**State management:** `useState` + `apiFetch` — no new libraries. Follows existing patterns in `app.jsx`.

---

## Error Handling

| Scenario | Behaviour |
|---|---|
| Client upsert fails during booking | Log warning, do not throw — booking proceeds normally |
| `POST /api/clients` with duplicate phone | 409 + "A client with this phone number already exists." |
| `GET/PUT/DELETE /api/clients/:id` — wrong business | 404 |
| Any unhandled server error | 500 + `{ error: err.message }` |

---

## Scripts

### `/scripts/backfill-clients.js`

One-time script. Groups all existing bookings by `(business_id, customer_phone)`, upserts a client row for each unique phone using the most recent booking's `customer_name`. Logs progress. Run manually after migration.

### `/scripts/test-client-profiles.js`

Manual QA script. Hits each API endpoint in sequence: create, list, get by ID, update notes/tags, delete. Follows the pattern of existing scripts in `/scripts`.

---

## Future Considerations (not in scope)

- **Vapi lookup tool** — `GET /api/clients/lookup?phone=+1xxx` for in-call profile retrieval; data layer is ready.
- **`name_locked` flag** — prevent webhook from overwriting manually-edited names.
- **Marketing features** — SMS campaigns, re-engagement messages.
- **Loyalty tracking** — visit milestones, reward flags.
