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

// ── checkAvailability tool ────────────────────────────────────────────────────
// Lets the assistant ask the server which times are open before offering any.
// Created once in Vapi (or found by name) and attached to every assistant.
const AVAILABILITY_TOOL_NAME = 'checkAvailability';
const WEBHOOK_URL = `${process.env.RENDER_EXTERNAL_URL || process.env.BASE_URL || 'https://bookingagent-gmo2.onrender.com'}/webhook/booking`;
const AVAILABILITY_TOOL = {
  type: 'function',
  function: {
    name: AVAILABILITY_TOOL_NAME,
    description: 'Check which appointment times are open. Call this BEFORE suggesting, offering or confirming any day or time. The reply lists the only times you may offer.',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'The day the caller wants, as YYYY-MM-DD in the shop time zone. "today" and "tomorrow" also work.' },
        time: { type: 'string', description: 'Optional. The start time the caller asked for, as HH:MM 24-hour (e.g. 14:30). Leave out to get all open times that day.' },
        service: { type: 'string', description: 'Optional. The service from the SERVICES list, so the right appointment length is checked.' },
        preferredBarber: { type: 'string', description: 'Optional. The team member the caller asked for. Leave out if no preference.' },
      },
      required: ['date'],
    },
  },
  server: { url: WEBHOOK_URL },
  messages: [{ type: 'request-start', content: 'One moment while I check the schedule.' }],
};

let availabilityToolId = process.env.VAPI_AVAILABILITY_TOOL_ID || null;

async function ensureAvailabilityTool() {
  if (availabilityToolId) return availabilityToolId;
  try {
    const list = await axios.get(`${VAPI_BASE}/tool?limit=100`, { headers: vapiHeaders(), timeout: 15000 });
    const existing = (list.data || []).find(t => t.function && t.function.name === AVAILABILITY_TOOL_NAME);
    if (existing) {
      availabilityToolId = existing.id;
      return availabilityToolId;
    }
    const created = await axios.post(`${VAPI_BASE}/tool`, AVAILABILITY_TOOL, { headers: vapiHeaders(), timeout: 15000 });
    availabilityToolId = created.data.id;
    console.log(`Vapi checkAvailability tool created: ${availabilityToolId}`);
    return availabilityToolId;
  } catch (err) {
    throw new Error(vapiError(err));
  }
}

// Model config with the availability tool attached (keeps existing tools)
async function withAvailabilityTool(model) {
  const toolId = await ensureAvailabilityTool();
  const toolIds = Array.isArray(model && model.toolIds) ? model.toolIds : [];
  return { ...(model || {}), toolIds: toolIds.includes(toolId) ? toolIds : [...toolIds, toolId] };
}

// Vapi fills this in on every call with the current date/time in the shop's time zone
function currentDateTimeTemplate(tz) {
  return `{{"now" | date: "%A, %B %-d, %Y, %-I:%M %p", "${tz}"}}`;
}

// The first thing callers hear. Built from the shop's current name so it never
// keeps the template assistant's greeting (it used to say "Sams Barbershop" for every shop).
function greetingFor(business) {
  return `Hello! Thank you for calling ${business.name}. How can I help you today?`;
}

function assistantNameFor(business) {
  return `${business.name} Receptionist`.substring(0, 40); // Vapi limit: 40 characters
}

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
    .replace(/\{\{depositPolicy\}\}/g,    depositPolicyText)
    .replace(/\{\{currentDateTime\}\}/g,  currentDateTimeTemplate(tz));

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

  newConfig.name = assistantNameFor(business);
  newConfig.firstMessage = greetingFor(business);

  if (newConfig.model) {
    const updatedMessages = [...messages];
    if (sysMsgIndex >= 0) {
      updatedMessages[sysMsgIndex] = { ...messages[sysMsgIndex], content: systemPrompt };
    }
    newConfig.model = await withAvailabilityTool({ ...newConfig.model, messages: updatedMessages });
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

// ── attachPhoneNumber ─────────────────────────────────────────────────────────
// Registers a Twilio number in Vapi and links it to the assistant, so calls to
// the number are answered. Vapi points the Twilio number at its inbound handler.
// Safe to re-run: an already-registered number is just re-linked.
async function attachPhoneNumber(phoneNumber, assistantId, name) {
  if (!phoneNumber || !assistantId) throw new Error('attachPhoneNumber needs a number and an assistant');
  let existing;
  try {
    const res = await axios.get(`${VAPI_BASE}/phone-number?limit=1000`, { headers: vapiHeaders(), timeout: 15000 });
    existing = (res.data || []).find(n => n.number === phoneNumber);
  } catch (err) {
    throw new Error(vapiError(err));
  }

  try {
    if (existing) {
      if (existing.assistantId !== assistantId) {
        await axios.patch(`${VAPI_BASE}/phone-number/${existing.id}`, { assistantId }, { headers: vapiHeaders(), timeout: 15000 });
      }
      console.log(`Vapi number ${phoneNumber} linked to assistant ${assistantId}`);
      return existing.id;
    }
    const res = await axios.post(`${VAPI_BASE}/phone-number`, {
      provider: 'twilio',
      number: phoneNumber,
      twilioAccountSid: process.env.TWILIO_ACCOUNT_SID,
      twilioAuthToken: process.env.TWILIO_AUTH_TOKEN,
      assistantId,
      name: String(name || 'Bimbly').substring(0, 40),
    }, { headers: vapiHeaders(), timeout: 20000 });
    console.log(`Vapi number registered: ${phoneNumber} → assistant ${assistantId}`);
    return res.data.id;
  } catch (err) {
    throw new Error(vapiError(err));
  }
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

  const model = await withAvailabilityTool({ ...current.model, messages: updatedMessages });
  try {
    await axios.patch(
      `${VAPI_BASE}/assistant/${assistantId}`,
      { model, firstMessage: greetingFor(business), name: assistantNameFor(business) },
      { headers: vapiHeaders(), timeout: 15000 }
    );
  } catch (err) {
    throw new Error(vapiError(err));
  }

  console.log(`Vapi prompt rebuilt for ${business.name} (${assistantId})`);
}

module.exports = { createVapiAssistant, updateVapiAssistant, deleteVapiAssistant, buildSystemPrompt, rebuildAndPatchVapiPrompt, ensureAvailabilityTool, attachPhoneNumber, greetingFor, AVAILABILITY_TOOL };
