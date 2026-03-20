/**
 * QA script for No-Show Deposits feature
 * Usage: BASE_URL=https://bookingagent-gmo2.onrender.com TOKEN=<jwt> node scripts/test-no-show-deposits.js
 *
 * What it tests:
 * 1. GET /api/business includes deposit_enabled and deposit_amount
 * 2. PUT /api/business can toggle deposit_enabled and set deposit_amount
 * 3. POST /api/bookings/:id/waive-deposit on a 'pending' booking works
 * 4. POST /api/bookings/:id/no-show on a 'pending' booking returns 400 (no card)
 * 5. GET /deposit/success returns 200
 * 6. GET /deposit/cancel returns 200
 * 7. GET /deposit/invalid-token returns 400
 */

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TOKEN = process.env.TOKEN;

if (!TOKEN) {
  console.error('❌  Set TOKEN env var to a valid dashboard JWT');
  process.exit(1);
}

const headers = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${TOKEN}`,
};

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌  ${name}: ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

async function api(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, body };
}

async function apiPublic(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  const text = await res.text();
  return { status: res.status, ok: res.ok, text };
}

(async () => {
  console.log(`\n🧪  No-Show Deposits QA — ${BASE_URL}\n`);

  // ── 1. GET /api/business includes deposit fields ──────────────────────────
  let businessId;
  await test('GET /api/business includes deposit_enabled and deposit_amount', async () => {
    const { ok, body } = await api('/api/business');
    assert(ok, `HTTP ${body}`);
    const biz = body.business;
    assert(biz, 'No business in response');
    businessId = biz.id;
    assert('deposit_enabled' in biz, 'deposit_enabled missing from business');
    assert('deposit_amount' in biz, 'deposit_amount missing from business');
    console.log(`     deposit_enabled=${biz.deposit_enabled}, deposit_amount=${biz.deposit_amount}`);
  });

  // ── 2. PUT /api/business enables deposit ─────────────────────────────────
  await test('PUT /api/business can set deposit_enabled=true and deposit_amount=2500', async () => {
    const { ok, body } = await api('/api/business', {
      method: 'PUT',
      body: JSON.stringify({ deposit_enabled: true, deposit_amount: 2500 }),
    });
    assert(ok, `HTTP error: ${JSON.stringify(body)}`);
  });

  // ── 3. PUT /api/business disables deposit ────────────────────────────────
  await test('PUT /api/business can set deposit_enabled=false', async () => {
    const { ok, body } = await api('/api/business', {
      method: 'PUT',
      body: JSON.stringify({ deposit_enabled: false }),
    });
    assert(ok, `HTTP error: ${JSON.stringify(body)}`);
  });

  // ── 4. Find a booking with deposit_status='pending' ──────────────────────
  let pendingBookingId;
  await test('GET /api/bookings — look for a pending deposit booking', async () => {
    const { ok, body } = await api('/api/bookings');
    assert(ok, 'Failed to fetch bookings');
    const pending = (body.bookings || []).find(b => b.deposit_status === 'pending');
    if (pending) {
      pendingBookingId = pending.id;
      console.log(`     Found pending booking: ${pendingBookingId}`);
    } else {
      console.log('     No pending deposit bookings found — skipping action tests');
    }
  });

  if (pendingBookingId) {
    // ── 5. no-show on pending (no card) returns 400 ─────────────────────────
    await test('POST /api/bookings/:id/no-show on pending returns 400', async () => {
      const { status } = await api(`/api/bookings/${pendingBookingId}/no-show`, { method: 'POST' });
      assert(status === 400, `Expected 400, got ${status}`);
    });

    // ── 6. waive-deposit on pending succeeds ─────────────────────────────────
    await test('POST /api/bookings/:id/waive-deposit on pending returns 200', async () => {
      const { ok, body } = await api(`/api/bookings/${pendingBookingId}/waive-deposit`, { method: 'POST' });
      assert(ok, `HTTP error: ${JSON.stringify(body)}`);
      assert(body.booking?.deposit_status === 'waived', `Expected waived, got ${body.booking?.deposit_status}`);
    });

    // ── 7. waive again returns 400 (already waived) ──────────────────────────
    await test('POST /api/bookings/:id/waive-deposit already waived returns 400', async () => {
      const { status } = await api(`/api/bookings/${pendingBookingId}/waive-deposit`, { method: 'POST' });
      assert(status === 400, `Expected 400, got ${status}`);
    });
  }

  // ── 8. Static deposit pages ───────────────────────────────────────────────
  await test('GET /deposit/success returns 200', async () => {
    const { status } = await apiPublic('/deposit/success');
    assert(status === 200, `Expected 200, got ${status}`);
  });

  await test('GET /deposit/cancel returns 200', async () => {
    const { status } = await apiPublic('/deposit/cancel');
    assert(status === 200, `Expected 200, got ${status}`);
  });

  await test('GET /deposit/invalid-token returns 400', async () => {
    const { status } = await apiPublic('/deposit/not-a-real-jwt');
    assert(status === 400, `Expected 400, got ${status}`);
  });

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(40)}`);
  console.log(`  Passed: ${passed}  Failed: ${failed}`);
  if (failed > 0) process.exit(1);
})();
