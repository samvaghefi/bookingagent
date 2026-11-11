#!/usr/bin/env node
'use strict';

/**
 * Rebuild each shop's Vapi assistant from vapi-system-prompt.txt and make sure
 * it has the checkAvailability tool. Run after changing the prompt or tools.
 *
 *   node scripts/sync-vapi-assistants.js --dry-run            # show what would change
 *   node scripts/sync-vapi-assistants.js --business <id>      # one shop
 *   node scripts/sync-vapi-assistants.js                      # every shop with an assistant
 *
 * Needs SUPABASE_URL, SUPABASE_KEY, VAPI_API_KEY (from .env).
 */

require('dotenv').config({ quiet: true });
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { buildSystemPrompt, rebuildAndPatchVapiPrompt } = require('../server/vapiService');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const onlyId = args.includes('--business') ? args[args.indexOf('--business') + 1] : null;

(async () => {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  let q = supabase.from('businesses').select('*').not('vapi_assistant_id', 'is', null);
  if (onlyId) q = q.eq('id', onlyId);
  const { data: businesses, error } = await q;
  if (error) throw error;
  if (!businesses.length) { console.log('No matching shops with an assistant.'); return; }

  for (const biz of businesses) {
    const { data: services } = await supabase.from('services').select('*').eq('business_id', biz.id);
    const label = `${biz.name} (${biz.id}) → assistant ${biz.vapi_assistant_id}`;
    if (dryRun) {
      const prompt = buildSystemPrompt(biz, { services: services || [], businessHours: biz.business_hours || null });
      const live = await axios.get(`https://api.vapi.ai/assistant/${biz.vapi_assistant_id}`, {
        headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}` }, timeout: 15000,
      });
      console.log(`DRY RUN ${label}`);
      console.log(`  current tools: ${JSON.stringify(live.data.model?.toolIds || [])}`);
      console.log(`  new prompt: ${prompt.length} chars, has availability rules: ${prompt.includes('checkAvailability')}`);
      continue;
    }
    try {
      await rebuildAndPatchVapiPrompt(biz, services || []);
      console.log(`✅ ${label}`);
    } catch (err) {
      console.error(`❌ ${label}: ${err.message}`);
      process.exitCode = 1;
    }
  }
})().catch(err => { console.error(err); process.exit(1); });
