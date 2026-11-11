'use strict';

const {
  computeDay, blocksForDate, intervalsForDate, parseTime, parseDate, describeRanges, serviceDuration, findMember,
} = require('../../server/availabilityService');
const { DateTime } = require('luxon');

const OPEN = { open: '09:00', close: '18:00', closed: false };
const T = s => parseTime(s);
const at = (p, time) => computeDay({ ...p, at: T(time) }).check;

describe('parseTime', () => {
  test.each([
    ['14:30', 870], ['14:30:00', 870], ['2:30 PM', 870], ['2pm', 840], ['9 am', 540], ['12 am', 0], ['12:15 pm', 735], ['9', 540],
  ])('%s → %i', (input, minutes) => expect(parseTime(input)).toBe(minutes));
  test.each(['25:00', '13pm', 'noonish', '', null])('rejects %p', input => expect(parseTime(input)).toBeNull());
});

describe('parseDate', () => {
  const tz = 'America/Toronto';
  test('ISO dates pass through', () => expect(parseDate('2026-12-03', tz)).toBe('2026-12-03'));
  test('today / tomorrow use the shop time zone', () => {
    const now = DateTime.now().setZone(tz);
    expect(parseDate('today', tz)).toBe(now.toISODate());
    expect(parseDate('Tomorrow', tz)).toBe(now.plus({ days: 1 }).toISODate());
  });
  test('rejects other text', () => expect(parseDate('next friday', tz)).toBeNull());
});

describe('computeDay: opening hours', () => {
  const base = { dayHours: OPEN, members: [], bookings: [], blocks: [], busy: [], nowMinutes: null, duration: 30 };

  test('closed day has no slots', () => {
    expect(computeDay({ ...base, dayHours: { open: '09:00', close: '18:00', closed: true } })).toEqual({ closed: true, slots: [] });
    expect(computeDay({ ...base, dayHours: undefined }).closed).toBe(true);
  });

  test('slots run every 30 min and the appointment must end by closing', () => {
    const day = computeDay({ ...base, duration: 45 });
    expect(day.slots[0].time).toBe('09:00');
    expect(day.slots[day.slots.length - 1].time).toBe('17:00'); // 17:00 + 45 = 17:45 ≤ 18:00; 17:30 would end 18:15
    expect(day.slots.every(s => s.available)).toBe(true);
  });

  test('outside hours and past times are not available', () => {
    expect(at(base, '08:30')).toMatchObject({ available: false, reason: 'outside_hours' });
    expect(at(base, '17:45')).toMatchObject({ available: false, reason: 'outside_hours' });
    expect(at({ ...base, nowMinutes: T('11:10') }, '11:00')).toMatchObject({ available: false, reason: 'past' });
    expect(at({ ...base, nowMinutes: T('11:10') }, '11:30').available).toBe(true);
    expect(at({ ...base, nowMinutes: -1 }, '15:00')).toMatchObject({ available: false, reason: 'past' });
  });
});

describe('computeDay: bookings', () => {
  test('one-person shop: an existing booking blocks overlapping times only', () => {
    const p = { dayHours: OPEN, members: [{ name: 'Sam' }], bookings: [{ start: T('10:00'), end: T('10:30'), member: null }], blocks: [], busy: [], duration: 30 };
    expect(at(p, '10:00')).toMatchObject({ available: false, reason: 'busy' });
    expect(at(p, '09:45').available).toBe(false); // 9:45–10:15 overlaps
    expect(at(p, '09:30').available).toBe(true);
    expect(at(p, '10:30').available).toBe(true);
  });

  test('two barbers: one booking leaves the other free; two bookings fill the slot', () => {
    const members = [{ name: 'Sam' }, { name: 'Jordan' }];
    const one = { dayHours: OPEN, members, bookings: [{ start: T('10:00'), end: T('10:30'), member: 'Sam' }], blocks: [], busy: [], duration: 30 };
    expect(at(one, '10:00')).toMatchObject({ available: true, freeMembers: ['Jordan'] });
    expect(at({ ...one, teamMember: 'Sam' }, '10:00')).toMatchObject({ available: false, reason: 'member_busy' });
    expect(at({ ...one, teamMember: 'jordan' }, '10:00')).toMatchObject({ available: true, freeMembers: ['Jordan'] });

    const two = { ...one, bookings: [...one.bookings, { start: T('10:00'), end: T('10:30'), member: null }] };
    expect(at(two, '10:00')).toMatchObject({ available: false, reason: 'busy' });
  });

  test('an "anyone" booking still needs a barber, so a specific request can be refused', () => {
    const p = { dayHours: OPEN, members: [{ name: 'Sam' }, { name: 'Jordan' }], blocks: [], busy: [], duration: 30,
      bookings: [{ start: T('11:00'), end: T('11:30'), member: 'Jordan' }, { start: T('11:00'), end: T('11:30'), member: null }] };
    // Jordan is booked and the unassigned booking must go to Sam → nobody left
    expect(at({ ...p, teamMember: 'Sam' }, '11:00').available).toBe(false);
  });

  test('bookings for someone no longer on the team count as unassigned', () => {
    const p = { dayHours: OPEN, members: [{ name: 'Sam' }], bookings: [{ start: T('12:00'), end: T('12:30'), member: 'Old Barber' }], blocks: [], busy: [], duration: 30 };
    expect(at(p, '12:00').available).toBe(false);
  });
});

describe('computeDay: blocked time and Google busy', () => {
  const members = [{ name: 'Sam' }, { name: 'Jordan' }];
  const base = { dayHours: OPEN, members, bookings: [], busy: [], blocks: [], duration: 30 };

  test('a shop-wide block closes those times for everyone', () => {
    const p = { ...base, blocks: [{ start: T('12:00'), end: T('13:00'), member: null }] };
    expect(at(p, '12:30')).toMatchObject({ available: false, reason: 'blocked' });
    expect(at(p, '11:45').available).toBe(false);
    expect(at(p, '13:00').available).toBe(true);
  });

  test('a block for one barber only affects them', () => {
    const p = { ...base, blocks: [{ start: 0, end: 1440, member: 'Jordan' }] };
    expect(at(p, '10:00')).toMatchObject({ available: true, freeMembers: ['Sam'] });
    expect(at({ ...p, teamMember: 'Jordan' }, '10:00').available).toBe(false);
  });

  test('Google busy times count like blocks', () => {
    expect(at({ ...base, busy: [{ start: T('15:00'), end: T('16:00'), member: null }] }, '15:30').available).toBe(false);
    expect(at({ ...base, busy: [{ start: T('15:00'), end: T('16:00'), member: 'Sam' }], teamMember: 'Sam' }, '15:30').available).toBe(false);
    expect(at({ ...base, busy: [{ start: T('15:00'), end: T('16:00'), member: 'Sam' }] }, '15:30').available).toBe(true);
  });
});

describe('blocksForDate', () => {
  const tz = 'America/Toronto';
  const rows = [
    { id: 'lunch', repeat: 'weekly', weekdays: [1, 2, 3, 4, 5], start_date: '2026-11-01', end_date: null, start_time: '12:00:00', end_time: '13:00:00', team_member: null, note: 'Lunch' },
    { id: 'holiday', repeat: 'none', start_date: '2026-12-24', end_date: '2026-12-26', start_time: null, end_time: null, team_member: null, note: 'Holidays' },
    { id: 'dentist', repeat: 'none', start_date: '2026-11-16', end_date: '2026-11-16', start_time: '14:00', end_time: '15:30', team_member: 'Jordan' },
  ];
  test('weekly blocks apply on their weekdays only', () => {
    expect(blocksForDate(rows, '2026-11-16', tz).map(b => b.id).sort()).toEqual(['dentist', 'lunch']); // Monday
    expect(blocksForDate(rows, '2026-11-21', tz)).toEqual([]); // Saturday
  });
  test('weekly blocks start on their start date', () => {
    expect(blocksForDate(rows, '2026-10-26', tz)).toEqual([]);
  });
  test('multi-day all-day blocks cover each day', () => {
    for (const d of ['2026-12-24', '2026-12-25', '2026-12-26']) {
      expect(blocksForDate(rows, d, tz).find(b => b.id === 'holiday')).toMatchObject({ start: 0, end: 1440, allDay: true });
    }
    expect(blocksForDate(rows, '2026-12-27', tz).find(b => b.id === 'holiday')).toBeUndefined();
  });
  test('times and team member come through', () => {
    expect(blocksForDate(rows, '2026-11-16', tz).find(b => b.id === 'dentist')).toMatchObject({ start: 840, end: 930, member: 'Jordan' });
  });
});

describe('intervalsForDate', () => {
  test('clips an event that crosses midnight', () => {
    const tz = 'America/Toronto';
    const iv = [{ start: DateTime.fromISO('2026-11-16T22:00', { zone: tz }), end: DateTime.fromISO('2026-11-17T10:00', { zone: tz }), member: null }];
    expect(intervalsForDate(iv, '2026-11-16', tz)).toEqual([{ start: 1320, end: 1440, member: null }]);
    expect(intervalsForDate(iv, '2026-11-17', tz)).toEqual([{ start: 0, end: 600, member: null }]);
  });
});

describe('helpers', () => {
  test('describeRanges groups free start times for the voice reply', () => {
    const slots = ['09:00', '09:30', '10:00', '14:00', '14:30', '16:00'].map(t => ({ minutes: T(t), available: true }));
    expect(describeRanges(slots)).toBe('9 AM to 10 AM, 2 PM to 2:30 PM, and 4 PM');
    expect(describeRanges([{ minutes: 600, available: false }])).toBe('');
  });
  test('serviceDuration matches the menu, falls back to 30', () => {
    const services = [{ name: "Men's Haircut", duration_minutes: 30 }, { name: 'Skin Fade', duration_minutes: 45 }];
    expect(serviceDuration(services, 'skin fade')).toBe(45);
    expect(serviceDuration(services, ['Skin Fade'])).toBe(45);
    expect(serviceDuration(services, 'fade')).toBe(45);
    expect(serviceDuration(services, 'Massage')).toBe(30);
  });
  test('findMember matches full or first names, ignores "anyone"', () => {
    const members = [{ name: 'Jordan Lee' }, { name: 'Sam Vale' }];
    expect(findMember(members, 'jordan lee').name).toBe('Jordan Lee');
    expect(findMember(members, 'Jordan').name).toBe('Jordan Lee');
    expect(findMember(members, 'anyone')).toBeNull();
    expect(findMember(members, 'Chris')).toBeNull();
  });
});
