#!/usr/bin/env node
'use strict';

/**
 * Make a shop's phone number answer calls: register its Twilio number in Vapi
 * and link it to the shop's assistant. For shops that signed up before signup
 * did this (their number rang into Vapi with no assistant → busy signal).
 *
 *   node scripts/attach-vapi-number.js --business <id> [--dry-run]
 *   node scripts/attach-vapi-number.js --all [--dry-run]    # every shop with a number + assistant
 *
 * Needs SUPABASE_URL, SUPABASE_KEY, VAPI_API_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN (.env).
 */

require('dotenv').config({ quiet: true });
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { attachPhoneNumber } = require('../server/vapiService');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const all = args.includes('--all');
const onlyId = args.includes('--business') ? args[args.indexOf('--business') + 1] : null;
if (!all && !onlyId) { console.error('Pass --business <id> or --all'); process.exit(1); }

(async () => {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  let q = supabase.from('businesses').select('id, name, twilio_phone, vapi_assistant_id')
    .not('twilio_phone', 'is', null).not('vapi_assistant_id', 'is', null);
  if (onlyId) q = q.eq('id', onlyId);
  const { data: shops, error } = await q;
  if (error) throw error;

  const vapiNums = (await axios.get('https://api.vapi.ai/phone-number?limit=1000', {
    headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}` }, timeout: 15000,
  })).data;

  for (const shop of shops) {
    const current = vapiNums.find(n => n.number === shop.twilio_phone);
    const status = !current ? 'not registered in Vapi'
      : current.assistantId !== shop.vapi_assistant_id ? `linked to another assistant (${current.assistantId})`
      : 'already linked';
    console.log(`${shop.name} (…${shop.twilio_phone.slice(-4)}): ${status}`);
    if (dryRun || status === 'already linked') continue;
    try {
      await attachPhoneNumber(shop.twilio_phone, shop.vapi_assistant_id, shop.name);
      console.log('  ✅ fixed');
    } catch (err) {
      console.error('  ❌', err.message);
      process.exitCode = 1;
    }
  }
})().catch(err => { console.error(err); process.exit(1); });
