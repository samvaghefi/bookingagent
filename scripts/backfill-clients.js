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
