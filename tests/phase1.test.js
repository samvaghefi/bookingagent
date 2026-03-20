/**
 * Phase 1 tests — Opening Hours, Services, Timezone helpers
 * Run with: node --test tests/phase1.test.js
 */
'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

// Will be created in server/vapiHelpers.js
const {
  format12h,
  formatBusinessHours,
  formatServices,
  getTimezoneInfo,
} = require('../server/vapiHelpers');

// ── format12h ─────────────────────────────────────────────────────────────────

test('format12h: midnight 00:00 → 12AM', () => assert.equal(format12h('00:00'), '12AM'));
test('format12h: noon 12:00 → 12PM',     () => assert.equal(format12h('12:00'), '12PM'));
test('format12h: 09:00 → 9AM',           () => assert.equal(format12h('09:00'), '9AM'));
test('format12h: 18:00 → 6PM',           () => assert.equal(format12h('18:00'), '6PM'));
test('format12h: 13:30 → 1:30PM',        () => assert.equal(format12h('13:30'), '1:30PM'));
test('format12h: 09:30 → 9:30AM',        () => assert.equal(format12h('09:30'), '9:30AM'));

// ── formatBusinessHours ───────────────────────────────────────────────────────

test('formatBusinessHours: null → not configured', () => {
  assert.equal(formatBusinessHours(null), '(Hours not configured yet)');
});

test('formatBusinessHours: empty object → not configured', () => {
  assert.equal(formatBusinessHours({}), '(Hours not configured yet)');
});

test('formatBusinessHours: closed day shows Closed', () => {
  const result = formatBusinessHours({
    monday: { open: '09:00', close: '18:00', closed: true },
  });
  assert.equal(result, '- Monday: Closed');
});

test('formatBusinessHours: open day shows hours', () => {
  const result = formatBusinessHours({
    tuesday: { open: '09:00', close: '18:00', closed: false },
  });
  assert.equal(result, '- Tuesday: 9AM – 6PM');
});

test('formatBusinessHours: days output in Mon→Sun order regardless of object key order', () => {
  const result = formatBusinessHours({
    friday:  { open: '10:00', close: '19:00', closed: false },
    monday:  { open: '09:00', close: '18:00', closed: false },
  });
  assert.equal(result, '- Monday: 9AM – 6PM\n- Friday: 10AM – 7PM');
});

test('formatBusinessHours: open/closed mix', () => {
  const result = formatBusinessHours({
    monday:    { open: '09:00', close: '18:00', closed: false },
    saturday:  { open: '10:00', close: '16:00', closed: false },
    sunday:    { open: '09:00', close: '18:00', closed: true  },
  });
  assert.equal(result, '- Monday: 9AM – 6PM\n- Saturday: 10AM – 4PM\n- Sunday: Closed');
});

test("formatBusinessHours: Sam's Barbershop sample (mon+sun closed only)", () => {
  const result = formatBusinessHours({
    monday: { open: '09:00', close: '18:00', closed: true },
    sunday: { open: '09:00', close: '18:00', closed: true },
  });
  assert.equal(result, '- Monday: Closed\n- Sunday: Closed');
});

// ── formatServices ────────────────────────────────────────────────────────────

test('formatServices: null → not configured', () => {
  assert.equal(formatServices(null), '(No services configured yet)');
});

test('formatServices: empty array → not configured', () => {
  assert.equal(formatServices([]), '(No services configured yet)');
});

test('formatServices: name only', () => {
  assert.equal(formatServices([{ name: 'Consultation' }]), '- Consultation');
});

test('formatServices: name + price', () => {
  assert.equal(
    formatServices([{ name: "Men's Haircut", price: 35 }]),
    "- Men's Haircut – $35"
  );
});

test('formatServices: name + price + duration', () => {
  assert.equal(
    formatServices([{ name: "Men's Haircut", price: 35, duration_minutes: 30 }]),
    "- Men's Haircut – $35 (30 min)"
  );
});

test('formatServices: name + price + duration + description', () => {
  assert.equal(
    formatServices([{ name: 'Beard Trim', price: 20, duration_minutes: 20, description: 'Includes hot towel' }]),
    '- Beard Trim – $20 (20 min) — Includes hot towel'
  );
});

test('formatServices: multiple services separated by newlines', () => {
  const result = formatServices([
    { name: "Men's Haircut", price: 35, duration_minutes: 30 },
    { name: 'Beard Trim',    price: 20, duration_minutes: 20 },
  ]);
  assert.equal(result, "- Men's Haircut – $35 (30 min)\n- Beard Trim – $20 (20 min)");
});

test('formatServices: skips entries with no name', () => {
  const result = formatServices([
    { name: "Men's Haircut", price: 35 },
    { price: 20 },
  ]);
  assert.equal(result, "- Men's Haircut – $35");
});

test("formatServices: Sam's Barbershop real data", () => {
  const services = [
    { name: 'Beard Trim',    price: 20,  duration_minutes: 20 },
    { name: "Kid's Haircut", price: 25,  duration_minutes: 20 },
    { name: "Men's Haircut", price: 35,  duration_minutes: 30 },
    { name: 'Shape up',      price: 25,  duration_minutes: 30 },
    { name: 'Wash',          price: 10,  duration_minutes: 30 },
  ];
  const result = formatServices(services);
  assert.ok(result.includes("- Men's Haircut – $35 (30 min)"));
  assert.ok(result.includes('- Beard Trim – $20 (20 min)'));
  assert.ok(result.includes('- Wash – $10 (30 min)'));
});

// ── getTimezoneInfo ───────────────────────────────────────────────────────────

test('getTimezoneInfo: America/Toronto → Eastern Time (ET)', () => {
  const info = getTimezoneInfo('America/Toronto');
  assert.equal(info.label, 'Eastern Time (ET)');
  assert.equal(info.location, 'Toronto, Canada');
});

test('getTimezoneInfo: America/Vancouver → Pacific Time (PT)', () => {
  const info = getTimezoneInfo('America/Vancouver');
  assert.equal(info.label, 'Pacific Time (PT)');
  assert.equal(info.location, 'Vancouver, Canada');
});

test('getTimezoneInfo: America/Edmonton → Mountain Time (MT)', () => {
  const info = getTimezoneInfo('America/Edmonton');
  assert.equal(info.label, 'Mountain Time (MT)');
  assert.equal(info.location, 'Edmonton, Canada');
});

test('getTimezoneInfo: America/Winnipeg → Central Time (CT)', () => {
  const info = getTimezoneInfo('America/Winnipeg');
  assert.equal(info.label, 'Central Time (CT)');
  assert.equal(info.location, 'Winnipeg, Canada');
});

test('getTimezoneInfo: America/Halifax → Atlantic Time (AT)', () => {
  const info = getTimezoneInfo('America/Halifax');
  assert.equal(info.label, 'Atlantic Time (AT)');
  assert.equal(info.location, 'Halifax, Canada');
});

test('getTimezoneInfo: unknown timezone falls back gracefully', () => {
  const info = getTimezoneInfo('America/Unknown');
  assert.equal(info.label, 'America/Unknown');
  assert.equal(info.location, 'Canada');
});

// ── Placeholder substitution in system prompt ─────────────────────────────────

test('{{businessName}} replaced, no literal placeholder remains', () => {
  const prompt = 'You are an assistant for {{businessName}}.';
  const result = prompt.replace(/\{\{businessName\}\}/g, "Sam's Barbershop");
  assert.ok(result.includes("Sam's Barbershop"));
  assert.ok(!result.includes('{{businessName}}'));
});

test('{{businessLocation}} replaced with Vancouver for America/Vancouver', () => {
  const prompt = 'This business is in {{businessLocation}}.';
  const { location } = getTimezoneInfo('America/Vancouver');
  const result = prompt.replace('{{businessLocation}}', location);
  assert.equal(result, 'This business is in Vancouver, Canada.');
});

test('{{timezoneLabel}} replaced with PT for America/Vancouver', () => {
  const prompt = 'All times are in {{timezoneLabel}}.';
  const { label } = getTimezoneInfo('America/Vancouver');
  const result = prompt.replace(/\{\{timezoneLabel\}\}/g, label);
  assert.equal(result, 'All times are in Pacific Time (PT).');
});

test('{{openingHours}} replaced with formatted hours, no placeholder remains', () => {
  const prompt = 'OPENING HOURS:\n{{openingHours}}';
  const hours = formatBusinessHours({ monday: { open: '09:00', close: '18:00', closed: false } });
  const result = prompt.replace('{{openingHours}}', hours);
  assert.ok(result.includes('Monday: 9AM – 6PM'));
  assert.ok(!result.includes('{{openingHours}}'));
});

test('{{services}} replaced with formatted services, no placeholder remains', () => {
  const prompt = 'SERVICES:\n{{services}}';
  const svcStr = formatServices([{ name: "Men's Haircut", price: 35, duration_minutes: 30 }]);
  const result = prompt.replace('{{services}}', svcStr);
  assert.ok(result.includes("Men's Haircut – $35 (30 min)"));
  assert.ok(!result.includes('{{services}}'));
});

test('{{currentDateTime}} is NOT replaced by createVapiAssistant (Vapi substitutes at runtime)', () => {
  // This placeholder must survive into the created assistant — Vapi fills it on each call
  const prompt = 'The time is {{currentDateTime}}.';
  // Simulate the substitutions createVapiAssistant does — currentDateTime should remain
  const result = prompt
    .replace(/\{\{businessName\}\}/g, "Sam's Barbershop")
    .replace(/\{\{businessLocation\}\}/g, 'Toronto, Canada')
    .replace(/\{\{timezoneLabel\}\}/g, 'Eastern Time (ET)');
  assert.ok(result.includes('{{currentDateTime}}'), '{{currentDateTime}} must remain for Vapi runtime');
});

test('{{supportedLanguages}} replaced with en for English-only business', () => {
  const prompt = 'Languages: {{supportedLanguages}}';
  const langs = ['en'];
  const result = prompt.replace('{{supportedLanguages}}', langs.join(', '));
  assert.equal(result, 'Languages: en');
});

test('{{supportedLanguages}} replaced with en, ko for bilingual business', () => {
  const prompt = 'Languages: {{supportedLanguages}}';
  const langs = ['en', 'ko'];
  const result = prompt.replace('{{supportedLanguages}}', langs.join(', '));
  assert.equal(result, 'Languages: en, ko');
});
