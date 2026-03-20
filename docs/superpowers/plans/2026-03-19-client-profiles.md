# Client Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Clients tab to the dashboard with auto-populated client profiles, per-client stats, notes, tags, and full booking history — backed by a new `clients` Supabase table.

**Architecture:** A new `clients` table uses `(business_id, phone)` as its unique key. The booking webhook upserts a client row on every call. Five new `/api/clients` routes serve the dashboard. Stats (visit count, last visit, preferred service/barber) are computed in JavaScript from a second bookings fetch — matching the existing analytics pattern. Two new React screens (`ClientsPage`, `ClientProfilePage`) are added to `app.jsx`; the client list is loaded on app mount into top-level `App` state.

**Tech Stack:** Node.js + Express 5, Supabase JS client (`@supabase/supabase-js`), React 18 + Babel standalone (no bundler, no JSX transpile step — write JSX directly as the CDN handles it), existing `apiFetch` helper.

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `scripts/migrations/add-clients-table.sql` | DB migration — run once in Supabase SQL editor |
| Modify | `server/bookingService.js` | Add client upsert after booking insert in `saveBooking()` |
| Modify | `server/dashboardRoutes.js` | Add 5 new `/api/clients` routes |
| Modify | `dashboard/app.jsx` | Add `clients` state to `App`, update `Sidebar`, add `ClientsPage` + `ClientProfilePage`, update `BookingsTable` |
| Create | `scripts/backfill-clients.js` | One-time backfill of existing bookings → clients table |
| Create | `scripts/test-client-profiles.js` | Manual end-to-end QA script for all client API routes |

---

## Task 1: Database Migration

**Files:**
- Create: `scripts/migrations/add-clients-table.sql`

- [ ] **Step 1: Create the migrations directory and SQL file**

```bash
mkdir -p scripts/migrations
```

Create `scripts/migrations/add-clients-table.sql`:

```sql
-- Phase 2: Client Profiles
-- Run in Supabase SQL Editor (Dashboard → SQL Editor → New query)

CREATE TABLE IF NOT EXISTS clients (
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
```

- [ ] **Step 2: Run the migration in Supabase**

Go to Supabase Dashboard → SQL Editor → paste the contents of `scripts/migrations/add-clients-table.sql` → Run.

Expected: "Success. No rows returned."

Verify the table exists: run `SELECT * FROM clients LIMIT 1;` — should return an empty result, not an error.

- [ ] **Step 3: Commit**

```bash
git add scripts/migrations/add-clients-table.sql
git commit -m "feat: add clients table migration"
```

---

## Task 2: Booking Webhook — Client Upsert

**Files:**
- Modify: `server/bookingService.js` (the `saveBooking` function, after the booking insert)

- [ ] **Step 1: Locate the insertion point**

Open `server/bookingService.js`. Find the end of the successful booking insert block — just after:
```js
console.log('Booking saved successfully:', data.id);
return data;
```
...but still inside `saveBooking`, before the closing `}`.

- [ ] **Step 2: Add the client upsert**

Insert the following block immediately before the `return data;` line inside the main try block (after the booking insert succeeds). Note: `business` is already a parameter of `saveBooking()`, so both fields are available here. The guard `if (bookingData.customerPhone && bookingData.name)` protects against null phone (possible in the end-of-call-report fallback path):

```js
  // Upsert client record — fire-and-forget, must never block the booking response
  if (bookingData.customerPhone && bookingData.name) {
    try {
      await supabase
        .from('clients')
        .upsert(
          {
            business_id: business.id,
            phone: bookingData.customerPhone,
            name: bookingData.name,  // extractFromToolCall() maps customerName → name
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
  }
```

- [ ] **Step 3: Verify the retry path is covered**

`saveBooking` has a retry block for when optional columns don't exist. The retry path calls `return retry.data` — insert the same client upsert block (with the null-phone guard) before that `return` as well, so clients are upserted regardless of which path completes the booking.

- [ ] **Step 4: Smoke test — deploy and place a test booking**

Deploy to Render (push to main). Use the existing `scripts/qa-test.sh` or Vapi test call to trigger a booking. Then in Supabase SQL Editor run:
```sql
SELECT * FROM clients ORDER BY created_at DESC LIMIT 5;
```
Expected: a row for the test booking's customer phone.

- [ ] **Step 5: Commit**

```bash
git add server/bookingService.js
git commit -m "feat: upsert client record on booking save"
```

---

## Task 3: API Routes — List and Create

**Files:**
- Modify: `server/dashboardRoutes.js` (add before `module.exports`)

Stats for `GET /api/clients` are computed in JavaScript (two Supabase queries + in-memory aggregation), matching the pattern used in `GET /api/analytics`. This avoids raw SQL / RPC calls.

- [ ] **Step 1: Add the clients section to dashboardRoutes.js**

Find the comment `// ── Billing` near the bottom of `dashboardRoutes.js`. Insert the following block **above** it:

```js
// ── Clients ───────────────────────────────────────────────────────────────────

// Helper: compute per-phone stats from a bookings array
function computeClientStats(bookings) {
  const stats = {};
  for (const b of bookings) {
    const phone = b.customer_phone;
    if (!phone) continue;
    if (!stats[phone]) {
      stats[phone] = { visit_count: 0, last_visit: null, services: {}, barbers: {} };
    }
    const s = stats[phone];
    s.visit_count++;
    if (!s.last_visit || b.appointment_date > s.last_visit) {
      s.last_visit = b.appointment_date;
    }
    const svc = Array.isArray(b.service_ids) ? b.service_ids[0] : b.service_ids;
    if (svc) s.services[svc] = (s.services[svc] || 0) + 1;
    if (b.preferred_barber) s.barbers[b.preferred_barber] = (s.barbers[b.preferred_barber] || 0) + 1;
  }
  // Reduce to preferred values
  const result = {};
  for (const [phone, s] of Object.entries(stats)) {
    result[phone] = {
      visit_count: s.visit_count,
      last_visit: s.last_visit,
      preferred_service: Object.keys(s.services).sort((a, b) => s.services[b] - s.services[a])[0] || null,
      preferred_barber: Object.keys(s.barbers).sort((a, b) => s.barbers[b] - s.barbers[a])[0] || null,
    };
  }
  return result;
}

// GET /api/clients — list all clients with computed stats
router.get('/api/clients', async (req, res) => {
  try {
    const [{ data: clients, error: cErr }, { data: bookings, error: bErr }] = await Promise.all([
      supabase.from('clients').select('*').eq('business_id', req.business.id).order('name'),
      supabase.from('bookings')
        .select('customer_phone, appointment_date, service_ids, preferred_barber')
        .eq('business_id', req.business.id)
    ]);

    if (cErr) throw cErr;
    if (bErr) throw bErr;

    const stats = computeClientStats(bookings || []);

    const enriched = (clients || []).map(c => ({
      ...c,
      ...(stats[c.phone] || { visit_count: 0, last_visit: null, preferred_service: null, preferred_barber: null })
    }));

    res.json({ clients: enriched });
  } catch (err) {
    console.error('GET /api/clients error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/clients — manually create a client
router.post('/api/clients', async (req, res) => {
  const { name, phone, notes, tags } = req.body;
  if (!name || !phone) {
    return res.status(400).json({ error: 'name and phone are required.' });
  }

  try {
    const { data: client, error } = await supabase
      .from('clients')
      .insert({ business_id: req.business.id, name, phone, notes: notes || null, tags: tags || [] })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'A client with this phone number already exists.' });
      }
      throw error;
    }

    res.status(201).json({ client });
  } catch (err) {
    console.error('POST /api/clients error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 2: Restart the server locally and test**

```bash
node server/index.js
# In another terminal — replace TOKEN with your JWT from localStorage:
curl -H "Authorization: Bearer TOKEN" http://localhost:3000/api/clients
```

Expected: `{ "clients": [] }` (or populated if backfill has run).

```bash
curl -X POST -H "Authorization: Bearer TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Test Client","phone":"+16475550001"}' \
  http://localhost:3000/api/clients
```

Expected: `{ "client": { "id": "...", "name": "Test Client", ... } }`

- [ ] **Step 3: Commit**

```bash
git add server/dashboardRoutes.js
git commit -m "feat: add GET /api/clients and POST /api/clients routes"
```

---

## Task 4: API Routes — Get, Update, Delete

**Files:**
- Modify: `server/dashboardRoutes.js` (continue after Task 3 additions)

- [ ] **Step 1: Add the single-client routes**

Immediately after the `POST /api/clients` block added in Task 3, add:

```js
// GET /api/clients/:id — single client with stats + booking history
router.get('/api/clients/:id', async (req, res) => {
  try {
    const { data: client, error: cErr } = await supabase
      .from('clients')
      .select('*')
      .eq('id', req.params.id)
      .eq('business_id', req.business.id)
      .single();

    if (cErr || !client) return res.status(404).json({ error: 'Client not found.' });

    const [{ data: bookings, error: bErr }, { data: allBookings, error: abErr }] = await Promise.all([
      supabase.from('bookings')
        .select('*')
        .eq('business_id', req.business.id)
        .eq('customer_phone', client.phone)
        .order('appointment_date', { ascending: false })
        .order('appointment_time', { ascending: false }),
      supabase.from('bookings')
        .select('customer_phone, appointment_date, service_ids, preferred_barber')
        .eq('business_id', req.business.id)
        .eq('customer_phone', client.phone)
    ]);

    if (bErr) throw bErr;
    if (abErr) throw abErr;

    const stats = computeClientStats(allBookings || []);
    const enriched = { ...client, ...(stats[client.phone] || { visit_count: 0, last_visit: null, preferred_service: null, preferred_barber: null }) };

    res.json({ client: enriched, bookings: bookings || [] });
  } catch (err) {
    console.error('GET /api/clients/:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/clients/:id — update name, notes, tags (phone is not updatable)
router.put('/api/clients/:id', async (req, res) => {
  if (req.body.phone !== undefined) {
    return res.status(400).json({ error: 'Phone number cannot be changed. Delete and re-add this client to change their number.' });
  }

  const allowed = ['name', 'notes', 'tags'];
  const updates = { updated_at: new Date().toISOString() };
  allowed.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });

  if (Object.keys(updates).length === 1) {
    return res.status(400).json({ error: 'No valid fields to update.' });
  }

  try {
    const { data: client, error } = await supabase
      .from('clients')
      .update(updates)
      .eq('id', req.params.id)
      .eq('business_id', req.business.id)
      .select()
      .single();

    if (error || !client) return res.status(404).json({ error: 'Client not found.' });
    res.json({ client });
  } catch (err) {
    console.error('PUT /api/clients/:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/clients/:id — delete client only (bookings preserved)
router.delete('/api/clients/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('clients')
      .delete()
      .eq('id', req.params.id)
      .eq('business_id', req.business.id)
      .select()
      .single();

    if (error || !data) return res.status(404).json({ error: 'Client not found.' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/clients/:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 2: Test each route manually**

```bash
# Use the client ID from the POST in Task 3
CLIENT_ID="<id from task 3>"

# GET single client
curl -H "Authorization: Bearer TOKEN" http://localhost:3000/api/clients/$CLIENT_ID
# Expected: { client: {..., visit_count: 0, ...}, bookings: [] }

# PUT - update notes and tags
curl -X PUT -H "Authorization: Bearer TOKEN" -H "Content-Type: application/json" \
  -d '{"notes":"VIP customer","tags":["VIP"]}' \
  http://localhost:3000/api/clients/$CLIENT_ID
# Expected: { client: {..., notes: "VIP customer", tags: ["VIP"] } }

# PUT - attempt phone update (should fail)
curl -X PUT -H "Authorization: Bearer TOKEN" -H "Content-Type: application/json" \
  -d '{"phone":"+16475559999"}' \
  http://localhost:3000/api/clients/$CLIENT_ID
# Expected: 400 + "Phone number cannot be changed..."

# DELETE
curl -X DELETE -H "Authorization: Bearer TOKEN" \
  http://localhost:3000/api/clients/$CLIENT_ID
# Expected: { success: true }
```

- [ ] **Step 3: Commit**

```bash
git add server/dashboardRoutes.js
git commit -m "feat: add GET/PUT/DELETE /api/clients/:id routes"
```

---

## Task 5: Backfill Script

**Files:**
- Create: `scripts/backfill-clients.js`

Run this once after deploying to populate the `clients` table from existing bookings.

- [ ] **Step 1: Create the script**

Create `scripts/backfill-clients.js`:

```js
#!/usr/bin/env node
// One-time backfill: creates client records from all existing bookings.
// Usage: node scripts/backfill-clients.js
// Requires SUPABASE_URL and SUPABASE_KEY env vars (or a .env file loaded via dotenv).

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function backfill() {
  console.log('Fetching all bookings...');
  const { data: bookings, error } = await supabase
    .from('bookings')
    .select('business_id, customer_name, customer_phone, appointment_date')
    .not('customer_phone', 'is', null)
    .order('appointment_date', { ascending: false }); // newest first so most recent name wins

  if (error) { console.error('Failed to fetch bookings:', error.message); process.exit(1); }
  console.log(`Found ${bookings.length} bookings with a phone number.`);

  // Build map: "business_id:phone" → most recent name (first seen = most recent due to sort)
  const seen = new Map();
  for (const b of bookings) {
    const key = `${b.business_id}:${b.customer_phone}`;
    if (!seen.has(key)) {
      seen.set(key, { business_id: b.business_id, phone: b.customer_phone, name: b.customer_name || 'Unknown' });
    }
  }

  const clients = Array.from(seen.values());
  console.log(`Upserting ${clients.length} unique clients...`);

  let success = 0, failed = 0;
  for (const c of clients) {
    const { error: uErr } = await supabase
      .from('clients')
      .upsert(
        { business_id: c.business_id, phone: c.phone, name: c.name, updated_at: new Date().toISOString() },
        { onConflict: 'business_id,phone', ignoreDuplicates: true } // don't overwrite if already exists
      );
    if (uErr) { console.error(`  ❌ ${c.phone}: ${uErr.message}`); failed++; }
    else { console.log(`  ✅ ${c.phone} — ${c.name}`); success++; }
  }

  console.log(`\nDone. ${success} upserted, ${failed} failed.`);
}

backfill().catch(err => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Run the backfill**

```bash
node scripts/backfill-clients.js
```

Expected output: a list of ✅ lines for each unique client phone, then "Done. N upserted, 0 failed."

Verify in Supabase:
```sql
SELECT COUNT(*) FROM clients;
```

- [ ] **Step 3: Commit**

```bash
git add scripts/backfill-clients.js
git commit -m "feat: add client backfill script"
```

---

## Task 6: QA Test Script

**Files:**
- Create: `scripts/test-client-profiles.js`

- [ ] **Step 1: Create the script**

Create `scripts/test-client-profiles.js`:

```js
#!/usr/bin/env node
// Manual QA script for the /api/clients endpoints.
// Usage: TOKEN=<jwt> node scripts/test-client-profiles.js [base_url]
// Example: TOKEN=eyJ... node scripts/test-client-profiles.js http://localhost:3000

const BASE = process.argv[2] || 'https://bookingagent-gmo2.onrender.com';
const TOKEN = process.env.TOKEN;
if (!TOKEN) { console.error('Set TOKEN env var to your dashboard JWT'); process.exit(1); }

const headers = { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
let pass = 0, fail = 0;

function check(label, condition, got) {
  if (condition) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}\n     Got: ${JSON.stringify(got)}`); fail++; }
}

async function run() {
  const f = (path, opts = {}) => fetch(`${BASE}${path}`, { headers, ...opts }).then(r => r.json().then(b => ({ status: r.status, body: b })));

  console.log(`\n🧪 Client Profiles QA — ${BASE}\n`);

  // 1. List (empty or populated)
  console.log('1. GET /api/clients');
  const list1 = await f('/api/clients');
  check('status 200', list1.status === 200, list1);
  check('clients array', Array.isArray(list1.body.clients), list1.body);

  // 2. Create
  console.log('\n2. POST /api/clients');
  const created = await f('/api/clients', { method: 'POST', body: JSON.stringify({ name: 'QA Test Client', phone: '+16470000001' }) });
  check('status 201', created.status === 201, created);
  check('has id', !!created.body.client?.id, created.body);
  const id = created.body.client?.id;

  // 3. Duplicate → 409
  console.log('\n3. POST /api/clients (duplicate phone)');
  const dup = await f('/api/clients', { method: 'POST', body: JSON.stringify({ name: 'QA Dup', phone: '+16470000001' }) });
  check('status 409', dup.status === 409, dup);
  check('error message', dup.body.error?.includes('already exists'), dup.body);

  // 4. GET single
  console.log('\n4. GET /api/clients/:id');
  const got = await f(`/api/clients/${id}`);
  check('status 200', got.status === 200, got);
  check('bookings array', Array.isArray(got.body.bookings), got.body);

  // 5. PUT - update notes + tags
  console.log('\n5. PUT /api/clients/:id (notes + tags)');
  const updated = await f(`/api/clients/${id}`, { method: 'PUT', body: JSON.stringify({ notes: 'QA note', tags: ['VIP'] }) });
  check('status 200', updated.status === 200, updated);
  check('notes saved', updated.body.client?.notes === 'QA note', updated.body);
  check('tags saved', updated.body.client?.tags?.includes('VIP'), updated.body);

  // 6. PUT - phone update blocked
  console.log('\n6. PUT /api/clients/:id (phone change → 400)');
  const phoneUpd = await f(`/api/clients/${id}`, { method: 'PUT', body: JSON.stringify({ phone: '+16470000099' }) });
  check('status 400', phoneUpd.status === 400, phoneUpd);

  // 7. DELETE
  console.log('\n7. DELETE /api/clients/:id');
  const del = await f(`/api/clients/${id}`, { method: 'DELETE' });
  check('status 200', del.status === 200, del);
  check('success true', del.body.success === true, del.body);

  // 8. GET after delete → 404
  console.log('\n8. GET /api/clients/:id (after delete → 404)');
  const gone = await f(`/api/clients/${id}`);
  check('status 404', gone.status === 404, gone);

  console.log(`\n${'─'.repeat(40)}`);
  console.log(`Results: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Run it**

```bash
TOKEN=<your-jwt> node scripts/test-client-profiles.js http://localhost:3000
```

Expected: all 8 checks ✅, "8 passed, 0 failed".

**Note:** The QA script uses `+16470000001` as the test phone. If you run the backfill script (Task 5) first, it won't create a record for this number since it's not in real bookings data — so the duplicate-409 test remains accurate.

- [ ] **Step 3: Commit**

```bash
git add scripts/test-client-profiles.js
git commit -m "feat: add client profiles QA test script"
```

---

## Task 7: Dashboard — App State, Sidebar, ClientsPage

**Files:**
- Modify: `dashboard/app.jsx`

This is the largest task. Work through it section by section.

**Key patterns to follow in `app.jsx`:**
- State lives in the component that owns it; pass down as props.
- `apiFetch(path)` returns a `fetch` Promise — always `.then(r => r.json())`.
- No bundler — JSX works directly, no imports needed.
- Inline styles for one-offs; use existing CSS classes (`card`, `data-table`, `filter-btn`, `page-content`, etc.) from `dashboard/style.css`.

- [ ] **Step 1: Add `clients` state to the `App` component**

Find the `App` function. After the existing state declarations (`authed`, `page`, `business`), add:

```js
const [clients, setClients] = useState([]);
```

Inside the `useEffect` where `apiFetch('/api/business')` is called, add a parallel fetch for clients:

```js
apiFetch('/api/clients')
  .then(r => r.json())
  .then(d => setClients(d.clients || []))
  .catch(() => {});
```

- [ ] **Step 2: Add "Clients" to the titles map and page routing**

In the `titles` object inside `App`, add:
```js
clients: 'Clients',
```

In the JSX return, add the ClientsPage render (ClientProfilePage will be registered in Task 8 once the component exists):
```jsx
{page === 'clients' && <ClientsPage clients={clients} setClients={setClients} setPage={setPage} />}
```

Update the BookingsPage render to accept future props (Task 9 will use them):
```jsx
{page === 'bookings' && <BookingsPage clients={clients} setPage={setPage} />}
```

**Note:** `BookingsPage` will not use `clients` or `setPage` until Task 9 wires up the click handler. For now just update the JSX — the component can accept but ignore unknown props.

- [ ] **Step 3: Add "Clients" to the Sidebar**

Find the `navItems` array in `Sidebar`. Add the Clients entry between Bookings and Settings:
```js
{ id: 'clients', label: 'Clients', icon: '👤' },
```

- [ ] **Step 4: Add ClientsPage component**

Add the following new component before the `App` function:

```jsx
function ClientsPage({ clients, setClients, setPage }) {
  const [search, setSearch]       = useState('');
  const [tagFilter, setTagFilter] = useState(null);
  const [showForm, setShowForm]   = useState(false);
  const [form, setForm]           = useState({ name: '', phone: '', notes: '', tags: '' });
  const [saving, setSaving]       = useState(false);
  const [error, setError]         = useState('');

  // Collect all unique tags across all clients
  const allTags = [...new Set(clients.flatMap(c => c.tags || []))].sort();

  const filtered = clients.filter(c => {
    const q = search.toLowerCase();
    const matchSearch = !q || c.name.toLowerCase().includes(q) || (c.phone || '').includes(q);
    const matchTag = !tagFilter || (c.tags || []).includes(tagFilter);
    return matchSearch && matchTag;
  });

  async function handleCreate(e) {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      const r = await apiFetch('/api/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name,
          phone: form.phone,
          notes: form.notes || undefined,
          tags: form.tags ? form.tags.split(',').map(t => t.trim()).filter(Boolean) : []
        })
      });
      const d = await r.json();
      if (!r.ok) { setError(d.error || 'Failed to create client.'); return; }
      setClients(prev => [d.client, ...prev]);
      setShowForm(false);
      setForm({ name: '', phone: '', notes: '', tags: '' });
    } catch (err) {
      setError('Network error.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page-content">
      <div className="filter-bar" style={{ gap: '8px', flexWrap: 'wrap' }}>
        <input
          placeholder="Search by name or phone..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ padding: '6px 12px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', minWidth: '220px' }}
        />
        {allTags.map(tag => (
          <button
            key={tag}
            className={`filter-btn ${tagFilter === tag ? 'active' : ''}`}
            onClick={() => setTagFilter(tagFilter === tag ? null : tag)}
          >
            {tag}
          </button>
        ))}
        <button className="filter-btn" style={{ marginLeft: 'auto' }} onClick={() => setShowForm(s => !s)}>
          + Add Client
        </button>
      </div>

      {showForm && (
        <div className="card" style={{ marginBottom: '16px' }}>
          <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: '10px', maxWidth: '480px' }}>
            <input required placeholder="Name *" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              style={{ padding: '8px', border: '1px solid #e2e8f0', borderRadius: '6px' }} />
            <input required placeholder="Phone * (e.g. +16471234567)" value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
              style={{ padding: '8px', border: '1px solid #e2e8f0', borderRadius: '6px' }} />
            <textarea placeholder="Notes (optional)" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              style={{ padding: '8px', border: '1px solid #e2e8f0', borderRadius: '6px', resize: 'vertical', minHeight: '60px' }} />
            <input placeholder="Tags (comma-separated, e.g. VIP, regular)" value={form.tags} onChange={e => setForm(f => ({ ...f, tags: e.target.value }))}
              style={{ padding: '8px', border: '1px solid #e2e8f0', borderRadius: '6px' }} />
            {error && <div style={{ color: '#e53e3e', fontSize: '13px' }}>{error}</div>}
            <div style={{ display: 'flex', gap: '8px' }}>
              <button type="submit" className="filter-btn active" disabled={saving}>{saving ? 'Saving...' : 'Add Client'}</button>
              <button type="button" className="filter-btn" onClick={() => { setShowForm(false); setError(''); }}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      <div className="card">
        {filtered.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">👤</div>
            <div className="empty-title">No clients yet</div>
            <div className="empty-sub">Clients are created automatically when bookings come in</div>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th><th>Phone</th><th>Last Visit</th><th>Visits</th>
                  <th>Preferred Service</th><th>Preferred Barber</th><th>Tags</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(c => (
                  <tr key={c.id} style={{ cursor: 'pointer' }}
                    onClick={() => { window._clientProfileId = c.id; setPage('client-profile'); }}>
                    <td><div className="cell-name" style={{ color: '#6366f1', textDecoration: 'underline' }}>{c.name}</div></td>
                    <td>{c.phone || '—'}</td>
                    <td>{c.last_visit ? new Date(c.last_visit + 'T00:00:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}</td>
                    <td>{c.visit_count || 0}</td>
                    <td>{c.preferred_service || '—'}</td>
                    <td>{c.preferred_barber || '—'}</td>
                    <td>{(c.tags || []).join(', ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
```

**Note on navigation:** `window._clientProfileId` is a simple, zero-dependency way to pass the selected client ID to the profile screen. This follows the existing pattern where the app uses a single `page` string for routing.

- [ ] **Step 5: Verify locally**

Open the dashboard. Confirm "Clients" appears in the sidebar. Click it — should show the empty state or client list. "Add Client" button should open the inline form.

- [ ] **Step 6: Commit**

```bash
git add dashboard/app.jsx
git commit -m "feat: add Clients sidebar tab and ClientsPage"
```

---

## Task 8: Dashboard — ClientProfilePage

**Files:**
- Modify: `dashboard/app.jsx` (add before `App` function)

- [ ] **Step 1: Add ClientProfilePage component**

```jsx
function ClientProfilePage({ clients, setClients, setPage }) {
  const clientId = window._clientProfileId;
  const [client, setClient]   = useState(null);
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [form, setForm]       = useState({ name: '', notes: '', tags: '' });
  const [saving, setSaving]   = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [error, setError]     = useState('');

  useEffect(() => {
    if (!clientId) { setPage('clients'); return; }
    apiFetch(`/api/clients/${clientId}`)
      .then(r => r.json())
      .then(d => {
        if (d.client) {
          setClient(d.client);
          setBookings(d.bookings || []);
          setForm({ name: d.client.name, notes: d.client.notes || '', tags: (d.client.tags || []).join(', ') });
        } else {
          setPage('clients');
        }
      })
      .catch(() => setPage('clients'))
      .finally(() => setLoading(false));
  }, [clientId]);

  async function handleSave() {
    setSaving(true); setError('');
    try {
      const r = await apiFetch(`/api/clients/${clientId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name,
          notes: form.notes || null,
          tags: form.tags ? form.tags.split(',').map(t => t.trim()).filter(Boolean) : []
        })
      });
      const d = await r.json();
      if (!r.ok) { setError(d.error); return; }
      setClient(d.client);
      setClients(prev => prev.map(c => c.id === clientId ? { ...c, ...d.client } : c));
      setEditing(false);
    } catch { setError('Network error.'); }
    finally { setSaving(false); }
  }

  async function handleDelete() {
    try {
      await apiFetch(`/api/clients/${clientId}`, { method: 'DELETE' });
      setClients(prev => prev.filter(c => c.id !== clientId));
      setPage('clients');
    } catch { setError('Delete failed.'); }
  }

  if (loading) return <div className="page-content"><Spinner /></div>;
  if (!client) return null;

  return (
    <div className="page-content">
      <button className="filter-btn" onClick={() => setPage('clients')} style={{ marginBottom: '16px' }}>← Back to Clients</button>

      <div className="card" style={{ marginBottom: '16px' }}>
        {editing ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', maxWidth: '480px' }}>
            <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              style={{ padding: '8px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '16px', fontWeight: 600 }} />
            <textarea placeholder="Notes" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              style={{ padding: '8px', border: '1px solid #e2e8f0', borderRadius: '6px', resize: 'vertical', minHeight: '80px' }} />
            <input placeholder="Tags (comma-separated)" value={form.tags} onChange={e => setForm(f => ({ ...f, tags: e.target.value }))}
              style={{ padding: '8px', border: '1px solid #e2e8f0', borderRadius: '6px' }} />
            {error && <div style={{ color: '#e53e3e', fontSize: '13px' }}>{error}</div>}
            <div style={{ display: 'flex', gap: '8px' }}>
              <button className="filter-btn active" onClick={handleSave} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
              <button className="filter-btn" onClick={() => { setEditing(false); setError(''); }}>Cancel</button>
            </div>
          </div>
        ) : (
          <div>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' }}>
              <div>
                <h2 style={{ margin: 0, fontSize: '22px' }}>{client.name}</h2>
                <div style={{ color: '#64748b', marginTop: '4px' }}>{client.phone}</div>
                {(client.tags || []).length > 0 && (
                  <div style={{ marginTop: '8px', display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    {client.tags.map(tag => (
                      <span key={tag} style={{ background: '#ede9fe', color: '#6d28d9', padding: '2px 10px', borderRadius: '12px', fontSize: '12px' }}>{tag}</span>
                    ))}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
                <button className="filter-btn" onClick={() => setEditing(true)}>Edit</button>
                <button className="filter-btn" style={{ color: '#e53e3e' }} onClick={() => setConfirmDel(true)}>Delete</button>
              </div>
            </div>

            {client.notes && (
              <div style={{ marginTop: '16px', padding: '12px', background: '#f8fafc', borderRadius: '8px', fontSize: '14px', color: '#475569' }}>
                {client.notes}
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '12px', marginTop: '20px' }}>
              {[
                { label: 'Total Visits', value: client.visit_count ?? 0 },
                { label: 'Last Visit', value: client.last_visit ? new Date(client.last_visit + 'T00:00:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' }) : '—' },
                { label: 'Preferred Service', value: client.preferred_service || '—' },
                { label: 'Preferred Barber', value: client.preferred_barber || '—' },
              ].map(stat => (
                <div key={stat.label} style={{ background: '#f8fafc', borderRadius: '8px', padding: '12px', textAlign: 'center' }}>
                  <div style={{ fontSize: '11px', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{stat.label}</div>
                  <div style={{ fontSize: '18px', fontWeight: 700, marginTop: '4px' }}>{stat.value}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {confirmDel && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div style={{ background: '#fff', borderRadius: '12px', padding: '24px', maxWidth: '380px', width: '90%' }}>
            <h3 style={{ margin: '0 0 8px' }}>Delete {client.name}?</h3>
            <p style={{ color: '#64748b', fontSize: '14px', margin: '0 0 20px' }}>
              The client record will be removed. Their booking history will be preserved.
            </p>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button className="filter-btn" onClick={() => setConfirmDel(false)}>Cancel</button>
              <button className="filter-btn" style={{ background: '#fee2e2', color: '#e53e3e', border: 'none' }} onClick={handleDelete}>Delete</button>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <h3 style={{ margin: '0 0 16px', fontSize: '16px' }}>Booking History</h3>
        {bookings.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">📅</div>
            <div className="empty-title">No bookings yet</div>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr><th>Date</th><th>Time</th><th>Service</th><th>Team Member</th><th>Special Requests</th></tr>
              </thead>
              <tbody>
                {bookings.map(b => (
                  <tr key={b.id}>
                    <td>{b.appointment_date ? new Date(b.appointment_date + 'T00:00:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}</td>
                    <td>{b.appointment_time || '—'}</td>
                    <td>{Array.isArray(b.service_ids) ? b.service_ids.join(', ') : b.service_ids || '—'}</td>
                    <td>{b.preferred_barber || '—'}</td>
                    <td className="cell-requests">{b.special_requests || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify locally**

Click a client in `ClientsPage` → should navigate to their profile. Verify:
- Stats strip shows correct data
- Booking history table is populated (if client has bookings)
- Edit saves and updates the sidebar client list
- Delete shows confirmation modal, then navigates back to Clients

- [ ] **Step 3: Commit**

```bash
git add dashboard/app.jsx
git commit -m "feat: add ClientProfilePage with stats, booking history, edit, delete"
```

---

## Task 9: Bookings Table Click-Through

**Files:**
- Modify: `dashboard/app.jsx` (`BookingsTable` component and `BookingsPage`)

- [ ] **Step 1: Update BookingsTable to accept props and make names clickable**

Find `function BookingsTable({ bookings })`. Change the signature to:
```jsx
function BookingsTable({ bookings, clients = [], onClientClick }) {
```

Find the customer name cell:
```jsx
<td>
  <div className="cell-name">{String(b.customer_name || '—')}</div>
</td>
```

Replace with:
```jsx
<td>
  <div
    className="cell-name"
    style={onClientClick && b.customer_phone ? { color: '#6366f1', textDecoration: 'underline', cursor: 'pointer' } : {}}
    onClick={() => {
      if (!onClientClick || !b.customer_phone) return;
      const match = clients.find(c => c.phone === b.customer_phone);
      onClientClick(match ? match.id : null, b.customer_phone);
    }}
  >
    {String(b.customer_name || '—')}
  </div>
</td>
```

- [ ] **Step 2: Wire up BookingsPage to pass clients and handler**

Find `function BookingsPage()`. Change the signature to:
```jsx
function BookingsPage({ clients = [], setPage }) {
```

Update the `BookingsTable` render inside `BookingsPage`:
```jsx
<BookingsTable
  bookings={bookings}
  clients={clients}
  onClientClick={(clientId, phone) => {
    if (clientId) {
      window._clientProfileId = clientId;
      setPage('client-profile');
    } else {
      // No client record yet — go to Clients page with phone pre-filled in search
      window._clientsSearch = phone;  // ClientsPage reads this on mount
      setPage('clients');
    }
  }}
/>
```

- [ ] **Step 3: Handle pre-filled search in ClientsPage**

In `ClientsPage`, update the `useState` for `search`:
```jsx
const [search, setSearch] = useState(window._clientsSearch || '');
```

Add a `useEffect` to clear the global after reading it:
```jsx
useEffect(() => { window._clientsSearch = null; }, []);
```

- [ ] **Step 4: Verify locally**

Go to Bookings. Click a customer name:
- If they have a client record → navigates to `ClientProfilePage`
- If no client record (edge case) → navigates to `ClientsPage` with their phone pre-filled in search

- [ ] **Step 5: Commit**

```bash
git add dashboard/app.jsx
git commit -m "feat: make booking customer names clickable links to client profiles"
```

---

## Task 10: Deploy and Full QA

- [ ] **Step 1: Push to production**

```bash
git push origin main
```

Wait ~2 minutes for Render to deploy. Check Render dashboard for successful deploy.

- [ ] **Step 2: Run the QA script against production**

Get your JWT token from the dashboard (browser DevTools → Application → Local Storage → `bimbly_token`).

```bash
TOKEN=<your-jwt> node scripts/test-client-profiles.js https://bookingagent-gmo2.onrender.com
```

Expected: 8 passed, 0 failed.

- [ ] **Step 3: Run the backfill script against production**

```bash
SUPABASE_URL=<your-url> SUPABASE_KEY=<your-key> node scripts/backfill-clients.js
```

Or if you have a `.env` file:
```bash
node scripts/backfill-clients.js
```

- [ ] **Step 4: Manual smoke test in the dashboard**

1. Open https://bookingagent-gmo2.onrender.com/dashboard
2. Click "Clients" in sidebar → should see list of backfilled clients
3. Click a client → profile page loads with stats and booking history
4. Edit notes and tags → saves correctly
5. Go to Bookings → click a customer name → navigates to their profile
6. Confirm delete modal works (cancel it — don't actually delete)

- [ ] **Step 5: Final commit tag**

```bash
git tag phase-2-client-profiles
git push origin --tags
```

