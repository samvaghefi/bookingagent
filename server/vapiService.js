/**
 * Vapi AI Assistant Service
 * Handles creating, updating, and deleting Vapi voice assistants per business.
 *
 * Required env vars:
 *   VAPI_API_KEY — Vapi API key (Bearer token)
 */

const axios = require('axios');

const VAPI_BASE = 'https://api.vapi.ai';
const TEMPLATE_ASSISTANT_ID = '3f7183f9-4796-4104-8b08-015a4d675792';

function vapiHeaders() {
  return {
    Authorization: `Bearer ${process.env.VAPI_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

// ── createVapiAssistant ───────────────────────────────────────────────────────
// Clones the template assistant and customises it for the given business.
async function createVapiAssistant(business) {
  // 1. Fetch template config
  const { data: template } = await axios.get(
    `${VAPI_BASE}/assistant/${TEMPLATE_ASSISTANT_ID}`,
    { headers: vapiHeaders(), timeout: 15000 }
  );

  // 2. Pull the system prompt out of the model messages
  const messages = (template.model && template.model.messages) || [];
  const sysMsgIndex = messages.findIndex(m => m.role === 'system');
  let systemPrompt = sysMsgIndex >= 0 ? messages[sysMsgIndex].content : '';

  // 3. Replace business-specific values in the prompt
  const tz = business.timezone || 'America/Toronto';
  const langs = Array.isArray(business.supported_languages)
    ? business.supported_languages
    : ['en'];

  systemPrompt = systemPrompt
    // Business name (literal and template variable)
    .replace(/Sam's Barbershop/g, business.name)
    .replace(/\{\{businessName\}\}/g, business.name)
    // Timezone
    .replace(/America\/Toronto/g, tz)
    .replace(/Toronto, Canada/g, business.address || 'Toronto, Canada');

  // Language — strip Korean if not supported
  if (!langs.includes('ko')) {
    systemPrompt = systemPrompt
      .replace(/\{\{supportedLanguages\}\}/g, 'en')
      .replace(/en, ko/g, 'en')
      .replace(/English or Korean/g, 'English')
      .replace(/English and Korean/g, 'English')
      .replace(/speak in English or Korean/g, 'speak in English')
      // Remove the bilingual greeting example line
      .replace(/- Example for en\+ko:.*\n/g, '')
      // Remove the Korean-only greeting instruction block
      .replace(/- If the business supports multiple languages.*\n/g, '');
  } else {
    systemPrompt = systemPrompt
      .replace(/\{\{supportedLanguages\}\}/g, 'en, ko');
  }

  // 4. Build the new assistant config — strip server-assigned fields
  const newConfig = { ...template };
  delete newConfig.id;
  delete newConfig.createdAt;
  delete newConfig.updatedAt;
  delete newConfig.orgId;

  newConfig.name = `${business.name} — AI Receptionist`;

  if (newConfig.model) {
    const updatedMessages = [...messages];
    if (sysMsgIndex >= 0) {
      updatedMessages[sysMsgIndex] = { ...messages[sysMsgIndex], content: systemPrompt };
    }
    newConfig.model = { ...newConfig.model, messages: updatedMessages };
  }

  // 5. Create the assistant
  const { data: created } = await axios.post(
    `${VAPI_BASE}/assistant`,
    newConfig,
    { headers: vapiHeaders(), timeout: 15000 }
  );

  console.log(`Vapi assistant created for ${business.name}: ${created.id}`);
  return created.id;
}

// ── updateVapiAssistant ───────────────────────────────────────────────────────
// Refreshes the services and barbers sections of an existing assistant's prompt.
async function updateVapiAssistant(assistantId, business, services, barbers) {
  // 1. Fetch current config
  const { data: current } = await axios.get(
    `${VAPI_BASE}/assistant/${assistantId}`,
    { headers: vapiHeaders(), timeout: 15000 }
  );

  const messages = (current.model && current.model.messages) || [];
  const sysMsgIndex = messages.findIndex(m => m.role === 'system');
  let systemPrompt = sysMsgIndex >= 0 ? messages[sysMsgIndex].content : '';

  // 2. Rebuild services block
  if (services && services.length > 0) {
    const serviceLines = services
      .filter(s => s.name)
      .map(s => {
        let line = `- ${s.name}`;
        if (s.price)            line += ` (CA$${s.price})`;
        if (s.duration_minutes) line += `, ${s.duration_minutes} min`;
        if (s.description)      line += ` — ${s.description}`;
        return line;
      })
      .join('\n');

    const servicesBlock = `SERVICES:\n${serviceLines}`;
    if (systemPrompt.includes('SERVICES:')) {
      systemPrompt = systemPrompt.replace(/SERVICES:[\s\S]*?(?=\n[A-Z]{2,}:|$)/, servicesBlock + '\n');
    } else {
      systemPrompt += `\n\n${servicesBlock}`;
    }
  }

  // 3. Rebuild barbers/team block
  if (barbers && barbers.length > 0) {
    const barberLines = barbers.map(b => `- ${b}`).join('\n');
    const teamBlock = `TEAM:\n${barberLines}`;
    if (systemPrompt.includes('TEAM:')) {
      systemPrompt = systemPrompt.replace(/TEAM:[\s\S]*?(?=\n[A-Z]{2,}:|$)/, teamBlock + '\n');
    } else {
      systemPrompt += `\n\n${teamBlock}`;
    }
  }

  // 4. PATCH assistant
  const updatedMessages = [...messages];
  if (sysMsgIndex >= 0) {
    updatedMessages[sysMsgIndex] = { ...messages[sysMsgIndex], content: systemPrompt };
  }

  await axios.patch(
    `${VAPI_BASE}/assistant/${assistantId}`,
    { model: { ...current.model, messages: updatedMessages } },
    { headers: vapiHeaders(), timeout: 15000 }
  );

  console.log(`Vapi assistant updated for ${business.name}`);
  return true;
}

// ── deleteVapiAssistant ───────────────────────────────────────────────────────
// Deletes a Vapi assistant — used for cleanup if provisioning fails.
async function deleteVapiAssistant(assistantId) {
  await axios.delete(
    `${VAPI_BASE}/assistant/${assistantId}`,
    { headers: vapiHeaders(), timeout: 15000 }
  );
  console.log(`Vapi assistant deleted: ${assistantId}`);
}

module.exports = { createVapiAssistant, updateVapiAssistant, deleteVapiAssistant };
