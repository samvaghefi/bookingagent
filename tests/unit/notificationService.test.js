'use strict';

// ── Test sendReminderSMS in notificationService ───────────────────────────────

const BUSINESS = {
  name: "Sam's Barbershop",
  twilio_phone: '+14161234567',
};

const BOOKING = {
  customer_name: 'John Smith',
  customer_phone: '+14165550000',
  service_ids: ["Men's Haircut"],
  appointment_date: '2026-03-25',
  appointment_time: '14:00:00',
};

// Use jest.resetModules + jest.doMock so Twilio is mocked before the module loads
function buildModule(twilioOverride) {
  jest.resetModules();
  const mockCreate = jest.fn().mockResolvedValue({ sid: 'SM123' });
  const twilioFactory = jest.fn().mockReturnValue({
    messages: { create: twilioOverride || mockCreate },
  });
  jest.doMock('twilio', () => twilioFactory);
  jest.doMock('@sendgrid/mail', () => ({ setApiKey: jest.fn(), send: jest.fn() }));
  const { sendReminderSMS } = require('../../server/notificationService');
  return { sendReminderSMS, mockCreate, twilioFactory };
}

describe('sendReminderSMS', () => {
  test('returns true and sends SMS with correct content', async () => {
    const { sendReminderSMS, mockCreate } = buildModule();
    const result = await sendReminderSMS(BUSINESS, BOOKING);

    expect(result).toBe(true);
    expect(mockCreate).toHaveBeenCalledTimes(1);

    const { body, from, to } = mockCreate.mock.calls[0][0];
    expect(body).toContain('John Smith');
    expect(body).toContain("Men's Haircut");
    expect(body).toContain("Sam's Barbershop");
    expect(body).toContain('2PM');     // 14:00 formatted
    expect(from).toBe('+14161234567');
    expect(to).toBe('+14165550000');
  });

  test('message uses exact template wording', async () => {
    const { sendReminderSMS, mockCreate } = buildModule();
    await sendReminderSMS(BUSINESS, BOOKING);
    const { body } = mockCreate.mock.calls[0][0];
    expect(body).toMatch(/^Hi John Smith,/);
    expect(body).toContain('just a reminder');
    expect(body).toContain('is tomorrow at');
    expect(body).toContain('See you then!');
  });

  test('formats time with minutes when non-zero (e.g. 14:30:00 → 2:30PM)', async () => {
    const { sendReminderSMS, mockCreate } = buildModule();
    await sendReminderSMS(BUSINESS, { ...BOOKING, appointment_time: '14:30:00' });
    const { body } = mockCreate.mock.calls[0][0];
    expect(body).toContain('2:30PM');
  });

  test('joins multiple service_ids with " and "', async () => {
    const { sendReminderSMS, mockCreate } = buildModule();
    await sendReminderSMS(BUSINESS, { ...BOOKING, service_ids: ["Men's Haircut", 'Beard Trim'] });
    const { body } = mockCreate.mock.calls[0][0];
    expect(body).toContain("Men's Haircut and Beard Trim");
  });

  test('returns false when Twilio throws', async () => {
    jest.resetModules();
    const failCreate = jest.fn().mockRejectedValue(new Error('Twilio down'));
    const twilioFactory = jest.fn().mockReturnValue({ messages: { create: failCreate } });
    jest.doMock('twilio', () => twilioFactory);
    jest.doMock('@sendgrid/mail', () => ({ setApiKey: jest.fn(), send: jest.fn() }));
    const { sendReminderSMS } = require('../../server/notificationService');

    const result = await sendReminderSMS(BUSINESS, BOOKING);
    expect(result).toBe(false);
  });
});
