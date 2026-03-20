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
