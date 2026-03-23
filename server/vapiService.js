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
const { formatBusinessHours, formatServices, getTimezoneInfo, formatTeamMembers } = require('./vapiHelpers');

// Load the canonical system prompt template from disk (version-controlled source of truth)
const PROMPT_TEMPLATE_PATH = path.join(__dirname, '..', 'vapi-system-prompt.txt');
function loadSystemPromptTemplate() {
  return fs.readFileSync(PROMPT_TEMPLATE_PATH, 'utf8');
}

const VAPI_BASE = 'https://api.vapi.ai';
const TEMPLATE_ASSISTANT_ID = 'f7e41498-1d7b-4297-866f-c070c0bdd92e'; // Sam's Barbershop — reference config for new business clones

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

// ── buildSystemPrompt ────────────────────────────────────────────────────────
// Loads vapi-system-prompt.txt from disk and substitutes all business-specific
// placeholders. Returns the fully substituted string ready to send to Vapi.
function buildSystemPrompt(business, { services = [], businessHours = null } = {}) {
  const tz    = business.timezone || 'America/Toronto';
  const langs = Array.isArray(business.supported_languages) ? business.supported_languages : ['en'];
  const tzInfo = getTimezoneInfo(tz);

  // Build deposit policy text (replaces {{depositPolicy}} placeholder)
  let depositPolicyText = '';
  if (business.deposit_enabled) {
    const amountDollars = business.deposit_amount != null
      ? (business.deposit_amount / 100).toFixed(0)
      : '25';
    depositPolicyText = `DEPOSIT POLICY:\nThis business requires a CA$${amountDollars} deposit to hold appointments. After the booking is confirmed, the customer will receive a text message with a secure payment link. Let them know their appointment is not confirmed until the deposit is paid. If asked, the deposit is applied toward their service cost.`;
  }

  let prompt = loadSystemPromptTemplate();
  prompt = prompt
    .replace(/\{\{businessName\}\}/g,     business.name)
    .replace(/\{\{businessLocation\}\}/g, business.address || tzInfo.location)
    .replace(/\{\{timezoneLabel\}\}/g,    tzInfo.label)
    .replace(/\{\{openingHours\}\}/g,     formatBusinessHours(businessHours || business.business_hours || null))
    .replace(/\{\{services\}\}/g,         formatServices(services))
    .replace(/\{\{teamMembers\}\}/g,      formatTeamMembers(business.team_members || business.barbers || []))
    .replace(/\{\{depositPolicy\}\}/g,    depositPolicyText);

  if (!langs.includes('ko')) {
    prompt = prompt
      .replace(/\{\{supportedLanguages\}\}/g, 'en')
      .replace(/en, ko/g, 'en')
      .replace(/English or Korean/g, 'English')
      .replace(/English and Korean/g, 'English')
      .replace(/speak in English or Korean/g, 'speak in English')
      .replace(/- Example for en\+ko:.*\n/g, '')
      .replace(/- If the business supports multiple languages.*\n/g, '');
  } else {
    prompt = prompt.replace(/\{\{supportedLanguages\}\}/g, 'en, ko');
  }
  return prompt;
}

// ── createVapiAssistant ───────────────────────────────────────────────────────
// Clones the template assistant and customises it for the given business.
async function createVapiAssistant(business, { services = [], businessHours = null } = {}) {
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

  // 2-3. Build system prompt from template file with all placeholders substituted
  const messages = (template.model && template.model.messages) || [];
  const sysMsgIndex = messages.findIndex(m => m.role === 'system');
  const systemPrompt = buildSystemPrompt(business, { services, businessHours });

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
async function updateVapiAssistant(assistantId, business, services, barbers, { businessHours = null } = {}) {
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

  // Update OPENING HOURS block if businessHours provided
  if (businessHours !== null) {
    const { formatBusinessHours } = require('./vapiHelpers');
    const hoursBlock = `OPENING HOURS:\n${formatBusinessHours(businessHours)}`;
    if (systemPrompt.includes('OPENING HOURS:')) {
      systemPrompt = systemPrompt.replace(/OPENING HOURS:[\s\S]*?(?=\n[A-Z]{2,}[\s\w]*:|$)/, hoursBlock + '\n');
    } else {
      systemPrompt += `\n\n${hoursBlock}`;
    }
  }

  if (barbers && barbers.length > 0) {
    const teamBlock = `TEAM MEMBERS:\n${formatTeamMembers(barbers)}`;
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

// ── rebuildAndPatchVapiPrompt ─────────────────────────────────────────────────
// Full prompt rebuild from vapi-system-prompt.txt + current business data.
// Fetches the live assistant, replaces the system message, and PATCHes Vapi.
// Returns silently if no vapi_assistant_id — safe to call unconditionally.
async function rebuildAndPatchVapiPrompt(business, services) {
  const assistantId = business.vapi_assistant_id;
  if (!assistantId || !process.env.VAPI_API_KEY) return;

  const systemPrompt = buildSystemPrompt(business, {
    services: services || [],
    businessHours: business.business_hours || null,
  });

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
  const updatedMessages = [...messages];
  if (sysMsgIndex >= 0) {
    updatedMessages[sysMsgIndex] = { ...messages[sysMsgIndex], content: systemPrompt };
  } else {
    updatedMessages.push({ role: 'system', content: systemPrompt });
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

  console.log(`Vapi prompt rebuilt for ${business.name} (${assistantId})`);
}

module.exports = { createVapiAssistant, updateVapiAssistant, deleteVapiAssistant, buildSystemPrompt, rebuildAndPatchVapiPrompt };
