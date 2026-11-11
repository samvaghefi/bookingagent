'use strict';

// Every assistant is cloned from Sams Barbershop's. The greeting must be the
// shop's own, never the template's.

const TEMPLATE = {
  id: 'f7e41498-1d7b-4297-866f-c070c0bdd92e', orgId: 'org', createdAt: 'x', updatedAt: 'x',
  name: 'Sams Barbershop Receptionist',
  firstMessage: 'Hello! Thank you for calling Sams Barbershop. How can I help you today?',
  model: { provider: 'openai', model: 'gpt', toolIds: ['tool_book'], messages: [{ role: 'system', content: 'old' }] },
};

function load() {
  jest.resetModules();
  jest.doMock('axios', () => ({
    get: jest.fn(url => Promise.resolve({ data: url.includes('/tool') ? [{ id: 'tool_avail', function: { name: 'checkAvailability' } }] : TEMPLATE })),
    post: jest.fn().mockResolvedValue({ data: { id: 'asst_new' } }),
    patch: jest.fn().mockResolvedValue({ data: {} }),
  }));
  process.env.VAPI_API_KEY = 'vapi_test';
  delete process.env.VAPI_AVAILABILITY_TOOL_ID;
  jest.spyOn(console, 'log').mockImplementation(() => {});
  return { axios: require('axios'), vapi: require('../../server/vapiService') };
}

const NAIL = { name: "Sam's Nail Salon", timezone: 'America/Toronto', business_hours: {}, vapi_assistant_id: 'asst_nail' };

test('a new assistant greets with the new shop\'s name', async () => {
  const { axios, vapi } = load();
  await vapi.createVapiAssistant(NAIL);
  const body = axios.post.mock.calls.find(c => c[0].endsWith('/assistant'))[1];
  expect(body.firstMessage).toBe("Hello! Thank you for calling Sam's Nail Salon. How can I help you today?");
  expect(body.name).toBe("Sam's Nail Salon Receptionist");
  expect(JSON.stringify(body)).not.toMatch(/Sams Barbershop/);
  expect(body.model.toolIds).toEqual(['tool_book', 'tool_avail']);
});

test('updating an assistant resets the greeting to the current shop name (e.g. after a rename)', async () => {
  const { axios, vapi } = load();
  await vapi.rebuildAndPatchVapiPrompt(NAIL, []);
  const [, body] = axios.patch.mock.calls[0];
  expect(body.firstMessage).toBe("Hello! Thank you for calling Sam's Nail Salon. How can I help you today?");
  expect(body.name).toBe("Sam's Nail Salon Receptionist");
});

test('long shop names keep the assistant name within Vapi\'s 40-character limit', () => {
  const { vapi } = load();
  expect(vapi.greetingFor({ name: 'A Very Long Shop Name For Testing Purposes Inc' })).toContain('A Very Long Shop Name For Testing Purposes Inc');
});
