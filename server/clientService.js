// Clients (the shop's CRM): one row per customer per shop, matched by phone.
//
// Phone numbers arrive in different shapes depending on where the booking came
// from ("+16475551234" from calls, "16475551234" from the booking page,
// "647 555 1234" typed by hand), so matching is done on the digits, never on
// the raw string. New clients are stored as +1XXXXXXXXXX when possible.

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Comparable key: digits only, North American numbers without the leading 1
function phoneKey(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') return d.slice(1);
  return d;
}

// Storage format: +1XXXXXXXXXX for North American numbers, else as given (trimmed)
function toE164(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  return String(phone || '').trim();
}

// Every spelling the same number may have been saved under
function phoneVariants(phone) {
  const raw = String(phone || '').trim();
  const key = phoneKey(phone);
  const set = new Set([raw, key]);
  if (key.length === 10) ['1' + key, '+1' + key].forEach(v => set.add(v));
  return [...set].filter(Boolean);
}

// Make sure this customer is in the shop's client list. Never overwrites a
// client the shop already has (they may have edited the name or notes).
// Never throws: a booking must not fail because of the CRM.
async function ensureClient(businessId, { name, phone }) {
  const cleanName = String(name || '').trim();
  if (!businessId || !cleanName || phoneKey(phone).length < 7) return null;
  try {
    const { data: existing, error: findErr } = await supabase
      .from('clients')
      .select('id')
      .eq('business_id', businessId)
      .in('phone', phoneVariants(phone))
      .limit(1);
    if (findErr) throw findErr;
    if (existing && existing.length) return existing[0];

    const { data: created, error } = await supabase
      .from('clients')
      .insert({ business_id: businessId, name: cleanName.slice(0, 100), phone: toE164(phone) })
      .select('id')
      .single();
    if (error && error.code !== '23505') throw error; // 23505 = added at the same moment
    return created || null;
  } catch (err) {
    console.warn('⚠️  Could not add client (non-blocking):', err.message);
    return null;
  }
}

module.exports = { phoneKey, toE164, phoneVariants, ensureClient };
