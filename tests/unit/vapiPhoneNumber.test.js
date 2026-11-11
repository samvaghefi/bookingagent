'use strict';

// A shop's number only answers calls when it's registered in Vapi and linked
// to the shop's assistant.

describe('attachPhoneNumber', () => {
  let axios, attachPhoneNumber;

  function load(existingNumbers) {
    jest.resetModules();
    jest.doMock('axios', () => ({
      get: jest.fn().mockResolvedValue({ data: existingNumbers }),
      post: jest.fn().mockResolvedValue({ data: { id: 'pn_new' } }),
      patch: jest.fn().mockResolvedValue({ data: {} }),
    }));
    axios = require('axios');
    process.env.VAPI_API_KEY = 'vapi_test';
    process.env.TWILIO_ACCOUNT_SID = 'ACtest';
    process.env.TWILIO_AUTH_TOKEN = 'tw_test';
    ({ attachPhoneNumber } = require('../../server/vapiService'));
    jest.spyOn(console, 'log').mockImplementation(() => {});
  }

  test('registers a new Twilio number with the assistant', async () => {
    load([]);
    expect(await attachPhoneNumber('+14165558294', 'asst_1', "Sam's Nail Salon")).toBe('pn_new');
    expect(axios.post).toHaveBeenCalledWith('https://api.vapi.ai/phone-number', expect.objectContaining({
      provider: 'twilio', number: '+14165558294', assistantId: 'asst_1',
      twilioAccountSid: 'ACtest', twilioAuthToken: 'tw_test', name: "Sam's Nail Salon",
    }), expect.any(Object));
  });

  test('re-links a number registered to a different assistant', async () => {
    load([{ id: 'pn_1', number: '+14165558294', assistantId: 'old' }]);
    await attachPhoneNumber('+14165558294', 'asst_1', 'Shop');
    expect(axios.patch).toHaveBeenCalledWith('https://api.vapi.ai/phone-number/pn_1', { assistantId: 'asst_1' }, expect.any(Object));
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('does nothing when already linked', async () => {
    load([{ id: 'pn_1', number: '+14165558294', assistantId: 'asst_1' }]);
    await attachPhoneNumber('+14165558294', 'asst_1', 'Shop');
    expect(axios.patch).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('surfaces Vapi errors so signup marks provisioning as failed', async () => {
    load([]);
    axios.post.mockRejectedValueOnce({ response: { status: 400, data: { message: 'bad number' } } });
    await expect(attachPhoneNumber('+14165558294', 'asst_1', 'Shop')).rejects.toThrow(/Vapi 400/);
  });
});

test('new Twilio numbers point at Vapi\'s inbound call handler, not the outbound API', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../../server/twilioProvisioningService.js'), 'utf8');
  expect(src).toContain("const VAPI_WEBHOOK_URL = 'https://api.vapi.ai/twilio/inbound_call';");
});
