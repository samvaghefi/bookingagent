/**
 * Twilio Phone Number Provisioning Service
 * Purchases and configures Canadian phone numbers for new businesses.
 * Uses city/province to select a local area code where possible.
 *
 * Required env vars:
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 */

const twilio = require('twilio');

// Vapi's standard inbound call handler — Twilio posts here when a call comes in
const VAPI_WEBHOOK_URL = 'https://api.vapi.ai/call/phone';

// Province → preferred area codes (priority order)
const PROVINCE_AREA_CODES = {
  'BC': ['604', '778', '250', '236'],
  'AB': ['403', '587', '780', '825'],
  'ON': ['416', '647', '437', '905', '289', '365', '519', '226', '613', '343'],
  'QC': ['514', '438', '450', '579', '418', '581'],
  'MB': ['204', '431'],
  'SK': ['306', '639'],
  'NS': ['902', '782'],
  'NB': ['506'],
  'NL': ['709'],
  'PE': ['902'],
  'NT': ['867'],
  'NU': ['867'],
  'YT': ['867'],
};

// City (lowercase) → preferred area codes (priority order)
const CITY_AREA_CODES = {
  'vancouver':   ['604', '778', '236'],
  'victoria':    ['250', '778'],
  'surrey':      ['604', '778'],
  'burnaby':     ['604', '778'],
  'richmond':    ['604', '778'],
  'calgary':     ['403', '587'],
  'edmonton':    ['780', '587'],
  'toronto':     ['416', '647', '437'],
  'mississauga': ['905', '289'],
  'brampton':    ['905', '289'],
  'ottawa':      ['613', '343'],
  'hamilton':    ['905', '289'],
  'london':      ['519', '226'],
  'montreal':    ['514', '438'],
  'quebec city': ['418', '581'],
  'winnipeg':    ['204', '431'],
  'saskatoon':   ['306', '639'],
  'regina':      ['306', '639'],
  'halifax':     ['902', '782'],
};

function getClient() {
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

// ── provisionPhoneNumber ──────────────────────────────────────────────────────
// Purchases the first available Canadian local number close to the business location.
// Priority: city area codes → province area codes → any CA number.
async function provisionPhoneNumber(business, city, province) {
  const client = getClient();

  const cityKey = (city || business.city || '').toLowerCase().trim();
  const prov    = (province || business.province || '').toUpperCase().trim();

  // Build ordered list of area codes to try
  const cityCodes     = CITY_AREA_CODES[cityKey]     || [];
  const provinceCodes = PROVINCE_AREA_CODES[prov]    || [];

  // Deduplicate while preserving city-first priority
  const seen = new Set();
  const areaCodesToTry = [...cityCodes, ...provinceCodes].filter(c => {
    if (seen.has(c)) return false;
    seen.add(c);
    return true;
  });

  if (areaCodesToTry.length === 0) {
    console.warn(`No area codes found for city="${cityKey}" province="${prov}" — falling back to any CA number`);
  }

  // Try each area code in order
  for (const areaCode of areaCodesToTry) {
    try {
      const available = await client.availablePhoneNumbers('CA')
        .local
        .list({ areaCode, limit: 1 });

      if (available.length > 0) {
        const purchased = await client.incomingPhoneNumbers.create({
          phoneNumber: available[0].phoneNumber,
          voiceUrl:    VAPI_WEBHOOK_URL,
          voiceMethod: 'POST',
          friendlyName: `${business.name} — bimblyai`,
        });
        console.log(`Provisioned ${purchased.phoneNumber} for ${cityKey || prov || 'CA'} using area code ${areaCode}`);
        return purchased.phoneNumber;
      }
    } catch (err) {
      console.warn(`Area code ${areaCode} search failed: ${err.message}`);
    }
  }

  // Fallback: any Canadian local number
  console.warn(`No numbers found in area codes [${areaCodesToTry.join(', ')}] — trying any CA number`);
  const available = await client.availablePhoneNumbers('CA')
    .local
    .list({ limit: 1 });

  if (!available.length) {
    throw new Error('No Canadian phone numbers available in Twilio');
  }

  const purchased = await client.incomingPhoneNumbers.create({
    phoneNumber: available[0].phoneNumber,
    voiceUrl:    VAPI_WEBHOOK_URL,
    voiceMethod: 'POST',
    friendlyName: `${business.name} — bimblyai`,
  });

  console.log(`Provisioned ${purchased.phoneNumber} for ${business.name} (CA fallback)`);
  return purchased.phoneNumber;
}

// ── releasePhoneNumber ────────────────────────────────────────────────────────
// Looks up and releases a Twilio number by E.164 string.
// Used as a rollback step if Vapi assistant creation fails after number purchase.
async function releasePhoneNumber(phoneNumber) {
  const client = getClient();

  const records = await client.incomingPhoneNumbers
    .list({ phoneNumber, limit: 1 });

  if (!records.length) {
    console.warn(`releasePhoneNumber: number not found in account: ${phoneNumber}`);
    return;
  }

  await client.incomingPhoneNumbers(records[0].sid).remove();
  console.log(`Twilio number released: ${phoneNumber}`);
}

module.exports = { provisionPhoneNumber, releasePhoneNumber };
