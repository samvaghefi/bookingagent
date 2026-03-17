/**
 * Vapi AI Assistant Service
 * Handles creating, updating, and deleting Vapi voice assistants per business.
 *
 * Required env vars:
 *   VAPI_API_KEY — Vapi API key (Bearer token)
 *
 * System prompt source of truth: vapi-system-prompt.txt (version-controlled).
 * The template assistant on Vapi is cloned for its non-prompt config only.
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Load the canonical system prompt template from disk (version-controlled source of truth)
const PROMPT_TEMPLATE_PATH = path.join(__dirname, '..', 'vapi-system-prompt.txt');
function loadSystemPromptTemplate() {
  return fs.readFileSync(PROMPT_TEMPLATE_PATH, 'utf8');
}

const VAPI_BASE = 'https://api.vapi.ai';
const TEMPLATE_ASSISTANT_ID = '3f7183f9-4796-4104-8b08-015a4d675792';

// Fields returned by GET /assistant that are NOT accepted by POST /assistant.
// Sending these back causes a 400.
const SERVER_ASSIGNED_FIELDS = [
  'id', 'createdAt', 'updatedAt', 'orgId',
  'phoneNumbers', 'phoneNumberId', 'squadId',
  'isPublished', 'publishedAt', 'subscribedPlan',
  'isServerUrlSecretSet',
];

function vapiHeaders() {
  return {
    Authorization: `Bearer ${process.env.VAPI_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

// Extract a human-readable error message from an Axios error
function vapiError(err) {
  if (err.response) {
    const body = JSON.stringify(err.response.data);
    return `Vapi ${err.response.status}: ${body}`;
  }
  return err.message;
}

// ── createVapiAssistant ───────────────────────────────────────────────────────
// Clones the template assistant and customises it for the given business.
async function createVapiAssistant(business) {
  // 1. Fetch template config
  let template;
  try {
    const res = await axios.get(
      `${VAPI_BASE}/assistant/${TEMPLATE_ASSISTANT_ID}`,
      { headers: vapiHeaders(), timeout: 15000 }
    );
    template = res.data;
  } catch (err) {
    throw new Error(vapiError(err));
  }

  // 2. Load system prompt from local file (source of truth) — not from template's stored prompt
  //    This prevents template corruption from affecting new businesses.
  const messages = (template.model && template.model.messages) || [];
  const sysMsgIndex = messages.findIndex(m => m.role === 'system');
  let systemPrompt = loadSystemPromptTemplate();

  // 3. Replace business-specific values in the prompt
  const tz = business.timezone || 'America/Toronto';
  const langs = Array.isArray(business.supported_languages)
    ? business.supported_languages
    : ['en'];

  systemPrompt = systemPrompt
    .replace(/Sam's Barbershop/g, business.name)
    .replace(/\{\{businessName\}\}/g, business.name)
    .replace(/America\/Toronto/g, tz)
    .replace(/Toronto, Canada/g, business.address || 'Toronto, Canada');

  if (!langs.includes('ko')) {
    systemPrompt = systemPrompt
      .replace(/\{\{supportedLanguages\}\}/g, 'en')
      .replace(/en, ko/g, 'en')
      .replace(/English or Korean/g, 'English')
      .replace(/English and Korean/g, 'English')
      .replace(/speak in English or Korean/g, 'speak in English')
      .replace(/- Example for en\+ko:.*\n/g, '')
      .replace(/- If the business supports multiple languages.*\n/g, '');
  } else {
    systemPrompt = systemPrompt
      .replace(/\{\{supportedLanguages\}\}/g, 'en, ko');
  }

  // 4. Build the new assistant config — strip all server-assigned / read-only fields
  const newConfig = { ...template };
  for (const field of SERVER_ASSIGNED_FIELDS) {
    delete newConfig[field];
  }

  // Vapi enforces a 40-character limit on assistant names
  const assistantName = `${business.name} Receptionist`.substring(0, 40);
  newConfig.name = assistantName;

  if (newConfig.model) {
    const updatedMessages = [...messages];
    if (sysMsgIndex >= 0) {
      updatedMessages[sysMsgIndex] = { ...messages[sysMsgIndex], content: systemPrompt };
    }
    newConfig.model = { ...newConfig.model, messages: updatedMessages };
  }

  // 5. Create the assistant
  let created;
  try {
    const res = await axios.post(
      `${VAPI_BASE}/assistant`,
      newConfig,
      { headers: vapiHeaders(), timeout: 15000 }
    );
    created = res.data;
  } catch (err) {
    throw new Error(vapiError(err));
  }

  console.log(`Vapi assistant created for ${business.name}: ${created.id}`);
  return created.id;
}

// ── updateVapiAssistant ───────────────────────────────────────────────────────
// Refreshes the services and barbers sections of an existing assistant's prompt.
async function updateVapiAssistant(assistantId, business, services, barbers) {
  let current;
  try {
    const res = await axios.get(
      `${VAPI_BASE}/assistant/${assistantId}`,
      { headers: vapiHeaders(), timeout: 15000 }
    );
    current = res.data;
  } catch (err) {
    throw new Error(vapiError(err));
  }

  const messages = (current.model && current.model.messages) || [];
  const sysMsgIndex = messages.findIndex(m => m.role === 'system');
  let systemPrompt = sysMsgIndex >= 0 ? messages[sysMsgIndex].content : '';

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

  if (barbers && barbers.length > 0) {
    const barberLines = barbers.map(b => `- ${b}`).join('\n');
    const teamBlock = `TEAM MEMBERS:\n${barberLines}`;
    // Support both old 'TEAM:' header and new 'TEAM MEMBERS:'
    if (systemPrompt.includes('TEAM MEMBERS:') || systemPrompt.includes('TEAM:')) {
      systemPrompt = systemPrompt
        .replace(/TEAM MEMBERS:[\s\S]*?(?=\n[A-Z]{2,}:|$)/, teamBlock + '\n')
        .replace(/TEAM:[\s\S]*?(?=\n[A-Z]{2,}:|$)/, teamBlock + '\n');
    } else {
      systemPrompt += `\n\n${teamBlock}`;
    }
  }

  const updatedMessages = [...messages];
  if (sysMsgIndex >= 0) {
    updatedMessages[sysMsgIndex] = { ...messages[sysMsgIndex], content: systemPrompt };
  }

  try {
    await axios.patch(
      `${VAPI_BASE}/assistant/${assistantId}`,
      { model: { ...current.model, messages: updatedMessages } },
      { headers: vapiHeaders(), timeout: 15000 }
    );
  } catch (err) {
    throw new Error(vapiError(err));
  }

  console.log(`Vapi assistant updated for ${business.name}`);
  return true;
}

// ── deleteVapiAssistant ───────────────────────────────────────────────────────
// Deletes a Vapi assistant — used for cleanup if provisioning fails.
async function deleteVapiAssistant(assistantId) {
  try {
    await axios.delete(
      `${VAPI_BASE}/assistant/${assistantId}`,
      { headers: vapiHeaders(), timeout: 15000 }
    );
  } catch (err) {
    throw new Error(vapiError(err));
  }
  console.log(`Vapi assistant deleted: ${assistantId}`);
}

module.exports = { createVapiAssistant, updateVapiAssistant, deleteVapiAssistant };
