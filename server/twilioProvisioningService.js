/**
 * Twilio Phone Number Provisioning Service
 * Purchases and configures Canadian phone numbers for new businesses.
 *
 * Required env vars:
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 */

const twilio = require('twilio');

// Vapi's standard inbound call handler — Twilio posts here when a call comes in
const VAPI_WEBHOOK_URL = 'https://api.vapi.ai/call/phone';

// Toronto-area codes in priority order, then any CA number as fallback
const AREA_CODE_PRIORITY = ['416', '647', '437'];

function getClient() {
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

// ── provisionPhoneNumber ──────────────────────────────────────────────────────
// Purchases the first available Canadian local number, preferring Toronto area codes.
// Configures the number's voice webhook to point to Vapi's inbound handler.
async function provisionPhoneNumber(business) {
  const client = getClient();
  let purchased = null;

  // Try priority area codes first
  for (const areaCode of AREA_CODE_PRIORITY) {
    try {
      const available = await client.availablePhoneNumbers('CA')
        .local
        .list({ areaCode, limit: 1 });

      if (available.length > 0) {
        purchased = await client.incomingPhoneNumbers.create({
          phoneNumber: available[0].phoneNumber,
          voiceUrl: VAPI_WEBHOOK_URL,
          voiceMethod: 'POST',
          friendlyName: `${business.name} — bimblyai`,
        });
        console.log(`Twilio number provisioned for ${business.name}: ${purchased.phoneNumber}`);
        return purchased.phoneNumber;
      }
    } catch (err) {
      console.warn(`Area code ${areaCode} search failed: ${err.message}`);
    }
  }

  // Fallback: any Canadian local number
  const available = await client.availablePhoneNumbers('CA')
    .local
    .list({ limit: 1 });

  if (!available.length) {
    throw new Error('No Canadian phone numbers available in Twilio');
  }

  purchased = await client.incomingPhoneNumbers.create({
    phoneNumber: available[0].phoneNumber,
    voiceUrl: VAPI_WEBHOOK_URL,
    voiceMethod: 'POST',
    friendlyName: `${business.name} — bimblyai`,
  });

  console.log(`Twilio number provisioned for ${business.name}: ${purchased.phoneNumber}`);
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
