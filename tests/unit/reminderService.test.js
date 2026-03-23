'use strict';

const { DateTime } = require('luxon');

// ── Chain builder: thenable Supabase mock ─────────────────────────────────────
// Every chained method returns another chain resolving to the same result.
// This lets us `await supabase.from().select().in().eq()...` in tests.
function chain(result) {
  const obj = {
    then: (res, rej) => Promise.resolve(result).then(res, rej),
  };
  ['select', 'eq', 'neq', 'in', 'not', 'is', 'order', 'limit'].forEach(m => {
    obj[m] = () => chain(result);
  });
  obj.single = () => Promise.resolve(result);
  return obj;
}

// Build a booking whose appointment is `hoursFromNow` hours in the future (Toronto tz)
function makeBooking(hoursFromNow, overrides = {}) {
  const appt = DateTime.now().setZone('America/Toronto').plus({ hours: hoursFromNow });
  return {
    id: 'booking-1',
    business_id: 'biz-1',
    customer_name: 'John Smith',
    customer_phone: '+14165550000',
    service_ids: ["Men's Haircut"],
    appointment_date: appt.toFormat('yyyy-MM-dd'),
    appointment_time: appt.toFormat('HH:mm:ss'),
    reminder_sent: false,
    status: 'confirmed',
    ...overrides,
  };
}

const BUSINESS = {
  id: 'biz-1',
  name: "Sam's Barbershop",
  timezone: 'America/Toronto',
  twilio_phone: '+14161234567',
};

// ── isLastMinuteBooking ───────────────────────────────────────────────────────

describe('isLastMinuteBooking', () => {
  let isLastMinuteBooking;

  beforeAll(() => {
    jest.resetModules();
    jest.doMock('@supabase/supabase-js', () => ({ createClient: () => ({}) }));
    jest.doMock('../../server/notificationService', () => ({ sendReminderSMS: jest.fn() }));
    ({ isLastMinuteBooking } = require('../../server/reminderService'));
  });

  test('returns true for appointment 12h from now', () => {
    expect(isLastMinuteBooking(makeBooking(12), 'America/Toronto')).toBe(true);
  });

  test('returns true for appointment 1h from now', () => {
    expect(isLastMinuteBooking(makeBooking(1), 'America/Toronto')).toBe(true);
  });

  test('returns true for appointment exactly 24h from now', () => {
    expect(isLastMinuteBooking(makeBooking(24), 'America/Toronto')).toBe(true);
  });

  test('returns false for appointment 25h from now', () => {
    expect(isLastMinuteBooking(makeBooking(25), 'America/Toronto')).toBe(false);
  });

  test('returns false for appointment in the past', () => {
    expect(isLastMinuteBooking(makeBooking(-1), 'America/Toronto')).toBe(false);
  });

  test('works correctly with Pacific timezone', () => {
    const appt = DateTime.now().setZone('America/Vancouver').plus({ hours: 6 });
    const booking = {
      appointment_date: appt.toFormat('yyyy-MM-dd'),
      appointment_time: appt.toFormat('HH:mm:ss'),
    };
    expect(isLastMinuteBooking(booking, 'America/Vancouver')).toBe(true);
  });
});

// ── sendDueReminders ──────────────────────────────────────────────────────────

describe('sendDueReminders', () => {
  function buildApp(bookingsResult, businessResult, updateResult = { data: {}, error: null }) {
    jest.resetModules();

    const mockUpdate = jest.fn().mockReturnValue(chain(updateResult));
    const mockSendReminderSMS = jest.fn().mockResolvedValue(true);

    jest.doMock('@supabase/supabase-js', () => ({
      createClient: () => ({
        from: (table) => {
          if (table === 'bookings') return { select: () => chain(bookingsResult), update: mockUpdate };
          if (table === 'businesses') return { select: () => chain(businessResult) };
          return chain({ data: null, error: null });
        },
      }),
    }));
    jest.doMock('../../server/notificationService', () => ({ sendReminderSMS: mockSendReminderSMS }));

    const { sendDueReminders } = require('../../server/reminderService');
    return { sendDueReminders, mockSendReminderSMS, mockUpdate };
  }

  test('sends SMS and marks reminder_sent=true for a due booking', async () => {
    const booking = makeBooking(12);
    const { sendDueReminders, mockSendReminderSMS, mockUpdate } = buildApp(
      { data: [booking], error: null },
      { data: [BUSINESS], error: null }
    );

    const count = await sendDueReminders();

    expect(count).toBe(1);
    expect(mockSendReminderSMS).toHaveBeenCalledWith(BUSINESS, booking);
    expect(mockUpdate).toHaveBeenCalledWith({ reminder_sent: true });
  });

  test('skips bookings more than 24h away', async () => {
    const { sendDueReminders, mockSendReminderSMS } = buildApp(
      { data: [makeBooking(30)], error: null },
      { data: [BUSINESS], error: null }
    );
    expect(await sendDueReminders()).toBe(0);
    expect(mockSendReminderSMS).not.toHaveBeenCalled();
  });

  test('skips past appointments', async () => {
    const { sendDueReminders, mockSendReminderSMS } = buildApp(
      { data: [makeBooking(-2)], error: null },
      { data: [BUSINESS], error: null }
    );
    expect(await sendDueReminders()).toBe(0);
    expect(mockSendReminderSMS).not.toHaveBeenCalled();
  });

  test('returns 0 when no bookings found', async () => {
    const { sendDueReminders, mockSendReminderSMS } = buildApp(
      { data: [], error: null },
      { data: [], error: null }
    );
    expect(await sendDueReminders()).toBe(0);
    expect(mockSendReminderSMS).not.toHaveBeenCalled();
  });

  test('returns 0 on DB query error', async () => {
    const { sendDueReminders, mockSendReminderSMS } = buildApp(
      { data: null, error: { message: 'DB error' } },
      { data: [], error: null }
    );
    expect(await sendDueReminders()).toBe(0);
    expect(mockSendReminderSMS).not.toHaveBeenCalled();
  });

  test('does not mark reminder_sent when SMS fails', async () => {
    jest.resetModules();
    const mockUpdate = jest.fn().mockReturnValue(chain({ data: {}, error: null }));
    const mockSendReminderSMS = jest.fn().mockResolvedValue(false);
    jest.doMock('@supabase/supabase-js', () => ({
      createClient: () => ({
        from: (t) => t === 'bookings'
          ? { select: () => chain({ data: [makeBooking(12)], error: null }), update: mockUpdate }
          : { select: () => chain({ data: [BUSINESS], error: null }) },
      }),
    }));
    jest.doMock('../../server/notificationService', () => ({ sendReminderSMS: mockSendReminderSMS }));
    const { sendDueReminders } = require('../../server/reminderService');

    expect(await sendDueReminders()).toBe(0);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('continues processing remaining bookings when one throws', async () => {
    jest.resetModules();
    let callCount = 0;
    const mockUpdate = jest.fn().mockReturnValue(chain({ data: {}, error: null }));
    const mockSendReminderSMS = jest.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) throw new Error('Twilio error');
      return Promise.resolve(true);
    });
    const twoBookings = [makeBooking(12, { id: 'b1' }), makeBooking(12, { id: 'b2' })];
    jest.doMock('@supabase/supabase-js', () => ({
      createClient: () => ({
        from: (t) => t === 'bookings'
          ? { select: () => chain({ data: twoBookings, error: null }), update: mockUpdate }
          : { select: () => chain({ data: [BUSINESS], error: null }) },
      }),
    }));
    jest.doMock('../../server/notificationService', () => ({ sendReminderSMS: mockSendReminderSMS }));
    const { sendDueReminders } = require('../../server/reminderService');

    const count = await sendDueReminders();
    expect(count).toBe(1); // second booking sent successfully
    expect(mockSendReminderSMS).toHaveBeenCalledTimes(2);
  });

  test('skips booking when business not found in DB', async () => {
    const { sendDueReminders, mockSendReminderSMS } = buildApp(
      { data: [makeBooking(12, { business_id: 'unknown-biz' })], error: null },
      { data: [], error: null }   // no businesses returned
    );
    expect(await sendDueReminders()).toBe(0);
    expect(mockSendReminderSMS).not.toHaveBeenCalled();
  });

  test('deduplicates business fetches — only one query for multiple bookings of the same business', async () => {
    jest.resetModules();
    const twoBookings = [makeBooking(12, { id: 'b1' }), makeBooking(10, { id: 'b2' })];
    const bizSelectSpy = jest.fn().mockReturnValue(chain({ data: [BUSINESS], error: null }));
    const mockUpdate = jest.fn().mockReturnValue(chain({ data: {}, error: null }));
    const mockSendReminderSMS = jest.fn().mockResolvedValue(true);
    jest.doMock('@supabase/supabase-js', () => ({
      createClient: () => ({
        from: (t) => t === 'bookings'
          ? { select: () => chain({ data: twoBookings, error: null }), update: mockUpdate }
          : { select: bizSelectSpy },
      }),
    }));
    jest.doMock('../../server/notificationService', () => ({ sendReminderSMS: mockSendReminderSMS }));
    const { sendDueReminders } = require('../../server/reminderService');

    const count = await sendDueReminders();
    expect(count).toBe(2);
    expect(bizSelectSpy).toHaveBeenCalledTimes(1); // single batch fetch
  });
});

// ── maybeScheduleReminder ─────────────────────────────────────────────────────

describe('maybeScheduleReminder', () => {
  function buildApp() {
    jest.resetModules();
    const mockUpdate = jest.fn().mockReturnValue(chain({ data: {}, error: null }));
    const mockSendReminderSMS = jest.fn().mockResolvedValue(true);
    jest.doMock('@supabase/supabase-js', () => ({
      createClient: () => ({ from: () => ({ update: mockUpdate }) }),
    }));
    jest.doMock('../../server/notificationService', () => ({ sendReminderSMS: mockSendReminderSMS }));
    const { maybeScheduleReminder } = require('../../server/reminderService');
    return { maybeScheduleReminder, mockSendReminderSMS, mockUpdate };
  }

  test('sends SMS immediately for a last-minute booking', async () => {
    const { maybeScheduleReminder, mockSendReminderSMS, mockUpdate } = buildApp();
    const booking = makeBooking(12);

    await maybeScheduleReminder(BUSINESS, booking);

    expect(mockSendReminderSMS).toHaveBeenCalledWith(BUSINESS, booking);
    expect(mockUpdate).toHaveBeenCalledWith({ reminder_sent: true });
  });

  test('does nothing for a booking 36h away', async () => {
    const { maybeScheduleReminder, mockSendReminderSMS } = buildApp();
    await maybeScheduleReminder(BUSINESS, makeBooking(36));
    expect(mockSendReminderSMS).not.toHaveBeenCalled();
  });

  test('does nothing when reminder already sent', async () => {
    const { maybeScheduleReminder, mockSendReminderSMS } = buildApp();
    await maybeScheduleReminder(BUSINESS, makeBooking(12, { reminder_sent: true }));
    expect(mockSendReminderSMS).not.toHaveBeenCalled();
  });

  test('does nothing when customer_phone is null', async () => {
    const { maybeScheduleReminder, mockSendReminderSMS } = buildApp();
    await maybeScheduleReminder(BUSINESS, makeBooking(12, { customer_phone: null }));
    expect(mockSendReminderSMS).not.toHaveBeenCalled();
  });

  test('does not mark reminder_sent when SMS fails', async () => {
    jest.resetModules();
    const mockUpdate = jest.fn().mockReturnValue(chain({ data: {}, error: null }));
    jest.doMock('@supabase/supabase-js', () => ({
      createClient: () => ({ from: () => ({ update: mockUpdate }) }),
    }));
    jest.doMock('../../server/notificationService', () => ({
      sendReminderSMS: jest.fn().mockResolvedValue(false),
    }));
    const { maybeScheduleReminder } = require('../../server/reminderService');

    await maybeScheduleReminder(BUSINESS, makeBooking(12));
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
