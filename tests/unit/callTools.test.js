'use strict';

// What the AI hears back from checkAvailability and the bookAppointment re-check.
// The data layer is mocked; the real decision logic (computeDay) is used.

const { DateTime } = require('luxon');

const TZ = 'America/Toronto';
const nextWeekday = n => { // next date (in a week or more) with luxon weekday n
  let d = DateTime.now().setZone(TZ).plus({ days: 7 });
  while (d.weekday !== n) d = d.plus({ days: 1 });
  return d.toISODate();
};
const MONDAY = nextWeekday(1);
const SUNDAY = nextWeekday(7);

const BUSINESS = {
  id: 'biz-1', timezone: TZ,
  business_hours: {
    monday: { open: '09:00', close: '12:00', closed: false },
    tuesday: { open: '09:00', close: '18:00', closed: false },
    sunday: { open: '09:00', close: '17:00', closed: true },
  },
  team_members: [{ name: 'Sam' }, { name: 'Jordan' }],
};

function load({ bookings = [], blockRows = [] } = {}) {
  jest.resetModules();
  jest.doMock('@supabase/supabase-js', () => ({ createClient: () => ({}) }));
  const svc = require('../../server/availabilityService');
  jest.spyOn(svc, 'loadContext').mockImplementation(async business => ({
    business, tz: TZ, members: svc.normalizeMembers(business),
    services: [{ name: "Men's Haircut", duration_minutes: 30 }, { name: 'Skin Fade', duration_minutes: 60 }],
    bookings, blockRows, google: [],
  }));
  return require('../../server/callTools');
}

const booking = (date, time, member = null, dur = 30) => ({ id: time, appointment_date: date, appointment_time: `${time}:00`, duration_minutes: dur, preferred_barber: member, status: 'confirmed' });

describe('checkAvailability replies', () => {
  test('starts with today\'s date', async () => {
    const { handleCheckAvailability } = load();
    const reply = await handleCheckAvailability(BUSINESS, { date: MONDAY });
    expect(reply).toMatch(/^Today is \w+day, \w+ \d+, \d{4} and it is \d{1,2}:\d{2} (AM|PM)\. /);
  });

  test('lists open ranges for a day', async () => {
    const { handleCheckAvailability } = load({ bookings: [booking(MONDAY, '10:00', 'Sam'), booking(MONDAY, '10:00', 'Jordan')] });
    const reply = await handleCheckAvailability(BUSINESS, { date: MONDAY, service: "Men's Haircut" });
    expect(reply).toContain('9 AM to 9:30 AM, and 10:30 AM to 11:30 AM');
    expect(reply).toContain('Only offer times from this list');
  });

  test('a specific free time says yes', async () => {
    const { handleCheckAvailability } = load();
    const reply = await handleCheckAvailability(BUSINESS, { date: MONDAY, time: '11:00', preferredBarber: 'jordan' });
    expect(reply).toContain('Yes, 11 AM');
    expect(reply).toContain('with Jordan');
  });

  test('a taken time says NOT available and gives the closest times', async () => {
    const { handleCheckAvailability } = load({ bookings: [booking(MONDAY, '10:00', 'Sam')] });
    const reply = await handleCheckAvailability(BUSINESS, { date: MONDAY, time: '10:00', preferredBarber: 'Sam' });
    expect(reply).toContain('10 AM');
    expect(reply).toContain('NOT available with Sam');
    expect(reply).toMatch(/closest open times that day are 9 AM, 9:30 AM or 10:30 AM/);
  });

  test('a long service needs the whole length free', async () => {
    const { handleCheckAvailability } = load();
    const reply = await handleCheckAvailability(BUSINESS, { date: MONDAY, time: '11:30', service: 'Skin Fade' });
    expect(reply).toContain('NOT available');
    expect(reply).toContain("outside opening hours");
  });

  test('a closed day points to the next open day', async () => {
    const { handleCheckAvailability } = load();
    const reply = await handleCheckAvailability(BUSINESS, { date: SUNDAY });
    expect(reply).toContain('closed on Sunday');
    expect(reply).toMatch(/next open times are on Monday/);
  });

  test('blocked lunch is respected', async () => {
    const { handleCheckAvailability } = load({ blockRows: [{ repeat: 'weekly', weekdays: [1], start_date: '2020-01-01', end_date: null, start_time: '11:00', end_time: '12:00', team_member: null }] });
    const reply = await handleCheckAvailability(BUSINESS, { date: MONDAY, time: '11:00' });
    expect(reply).toContain("isn't taking bookings then");
  });

  test('unknown team member is called out', async () => {
    const { handleCheckAvailability } = load();
    const reply = await handleCheckAvailability(BUSINESS, { date: MONDAY, preferredBarber: 'Chris' });
    expect(reply).toContain('There is no team member called "Chris"');
  });

  test('a shop with no saved hours is open 9 to 6 (what Settings → Hours shows), not closed', async () => {
    const { handleCheckAvailability } = load();
    const reply = await handleCheckAvailability({ ...BUSINESS, business_hours: {} }, { date: MONDAY });
    expect(reply).toContain('9 AM to 5:30 PM');
  });

  test('bad date asks for YYYY-MM-DD', async () => {
    const { handleCheckAvailability } = load();
    expect(await handleCheckAvailability(BUSINESS, { date: 'next friday' })).toContain('YYYY-MM-DD');
  });
});

describe('checkBeforeBooking', () => {
  test('free time → ok, with service length and the team member\'s real name', async () => {
    const { checkBeforeBooking } = load();
    const r = await checkBeforeBooking(BUSINESS, { date: MONDAY, time: '09:00', service: 'Skin Fade', preferredBarber: 'jordan' });
    expect(r).toEqual({ ok: true, durationMinutes: 60, teamMember: 'Jordan' });
  });

  test('taken time → NOT BOOKED with alternatives', async () => {
    const { checkBeforeBooking } = load({ bookings: [booking(MONDAY, '09:00', 'Sam'), booking(MONDAY, '09:00', 'Jordan')] });
    const r = await checkBeforeBooking(BUSINESS, { date: MONDAY, time: '09:00', service: "Men's Haircut" });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/^NOT BOOKED\./);
    expect(r.message).toContain('9:30 AM');
  });

  test('fails open if the check itself errors', async () => {
    const { checkBeforeBooking } = load();
    const svc = require('../../server/availabilityService');
    svc.loadContext.mockRejectedValueOnce(new Error('db down'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(await checkBeforeBooking(BUSINESS, { date: MONDAY, time: '09:00' })).toEqual({ ok: true });
  });
});
