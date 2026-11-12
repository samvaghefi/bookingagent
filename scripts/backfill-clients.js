// Add every customer from past bookings and walk-ins to their shop's client list.
// Safe to run more than once: existing clients (matched by phone digits) are left alone.
//
//   node scripts/backfill-clients.js --dry-run     # show what would be added
//   node scripts/backfill-clients.js               # add them
//   node scripts/backfill-clients.js --business <id>

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { phoneKey, ensureClient } = require('../server/clientService');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const onlyBusiness = args.includes('--business') ? args[args.indexOf('--business') + 1] : null;

async function all(table, columns) {
  let q = supabase.from(table).select(columns);
  if (onlyBusiness) q = q.eq('business_id', onlyBusiness);
  const { data, error } = await q;
  if (error) throw new Error(`${table}: ${error.message}`);
  return data || [];
}

(async () => {
  const [clients, bookings, walkIns, businesses] = await Promise.all([
    all('clients', 'business_id, phone'),
    all('bookings', 'business_id, customer_name, customer_phone, created_at'),
    all('walk_in_queue', 'business_id, customer_name, customer_phone, created_at').catch(() => []),
    supabase.from('businesses').select('id, name').then(r => r.data || []),
  ]);
  const shopName = Object.fromEntries(businesses.map(b => [b.id, b.name]));
  const known = new Set(clients.map(c => `${c.business_id}|${phoneKey(c.phone)}`));

  // Most recent name wins for each person
  const people = new Map();
  [...bookings, ...walkIns]
    .filter(r => r.customer_name && phoneKey(r.customer_phone).length >= 7)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .forEach(r => people.set(`${r.business_id}|${phoneKey(r.customer_phone)}`, r));

  const missing = [...people.entries()].filter(([k]) => !known.has(k)).map(([, r]) => r);
  console.log(`${missing.length} customer(s) not in the client list yet${dryRun ? ' (dry run, nothing saved)' : ''}:`);
  for (const r of missing) {
    console.log(`  ${shopName[r.business_id] || r.business_id}: ${r.customer_name} ${r.customer_phone}`);
    if (!dryRun) await ensureClient(r.business_id, { name: r.customer_name, phone: r.customer_phone });
  }
})().catch(err => { console.error(err.message); process.exit(1); });
