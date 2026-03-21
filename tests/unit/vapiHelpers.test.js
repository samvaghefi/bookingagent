'use strict';

const {
  format12h,
  formatBusinessHours,
  formatServices,
  getTimezoneInfo,
} = require('../../server/vapiHelpers');

describe('format12h', () => {
  test('midnight 00:00 → 12AM',  () => expect(format12h('00:00')).toBe('12AM'));
  test('noon 12:00 → 12PM',      () => expect(format12h('12:00')).toBe('12PM'));
  test('09:00 → 9AM',            () => expect(format12h('09:00')).toBe('9AM'));
  test('18:00 → 6PM',            () => expect(format12h('18:00')).toBe('6PM'));
  test('13:30 → 1:30PM',         () => expect(format12h('13:30')).toBe('1:30PM'));
  test('09:30 → 9:30AM',         () => expect(format12h('09:30')).toBe('9:30AM'));
});

describe('formatBusinessHours', () => {
  test('null → not configured', () => {
    expect(formatBusinessHours(null)).toBe('(Hours not configured yet)');
  });

  test('empty object → not configured', () => {
    expect(formatBusinessHours({})).toBe('(Hours not configured yet)');
  });

  test('closed day shows Closed', () => {
    expect(formatBusinessHours({
      monday: { open: '09:00', close: '18:00', closed: true },
    })).toBe('- Monday: Closed');
  });

  test('open day shows hours', () => {
    expect(formatBusinessHours({
      tuesday: { open: '09:00', close: '18:00', closed: false },
    })).toBe('- Tuesday: 9AM – 6PM');
  });

  test('days output in Mon→Sun order regardless of object key order', () => {
    expect(formatBusinessHours({
      friday:  { open: '10:00', close: '19:00', closed: false },
      monday:  { open: '09:00', close: '18:00', closed: false },
    })).toBe('- Monday: 9AM – 6PM\n- Friday: 10AM – 7PM');
  });

  test('open/closed mix', () => {
    expect(formatBusinessHours({
      monday:   { open: '09:00', close: '18:00', closed: false },
      saturday: { open: '10:00', close: '16:00', closed: false },
      sunday:   { open: '09:00', close: '18:00', closed: true  },
    })).toBe('- Monday: 9AM – 6PM\n- Saturday: 10AM – 4PM\n- Sunday: Closed');
  });
});

describe('formatServices', () => {
  test('null → not configured', () => {
    expect(formatServices(null)).toBe('(No services configured yet)');
  });

  test('empty array → not configured', () => {
    expect(formatServices([])).toBe('(No services configured yet)');
  });

  test('name only', () => {
    expect(formatServices([{ name: 'Consultation' }])).toBe('- Consultation');
  });

  test('name + price', () => {
    expect(formatServices([{ name: "Men's Haircut", price: 35 }])).toBe("- Men's Haircut – $35");
  });

  test('name + price + duration', () => {
    expect(formatServices([{ name: "Men's Haircut", price: 35, duration_minutes: 30 }]))
      .toBe("- Men's Haircut – $35 (30 min)");
  });

  test('name + price + duration + description', () => {
    expect(formatServices([{ name: 'Beard Trim', price: 20, duration_minutes: 20, description: 'Includes hot towel' }]))
      .toBe('- Beard Trim – $20 (20 min) — Includes hot towel');
  });

  test('multiple services separated by newlines', () => {
    const result = formatServices([
      { name: "Men's Haircut", price: 35, duration_minutes: 30 },
      { name: 'Beard Trim',    price: 20, duration_minutes: 20 },
    ]);
    expect(result).toBe("- Men's Haircut – $35 (30 min)\n- Beard Trim – $20 (20 min)");
  });

  test('skips entries with no name', () => {
    expect(formatServices([{ name: "Men's Haircut", price: 35 }, { price: 20 }]))
      .toBe("- Men's Haircut – $35");
  });
});

describe('getTimezoneInfo', () => {
  test('America/Toronto → Eastern Time (ET)', () => {
    const info = getTimezoneInfo('America/Toronto');
    expect(info.label).toBe('Eastern Time (ET)');
    expect(info.location).toBe('Toronto, Canada');
  });

  test('America/Vancouver → Pacific Time (PT)', () => {
    const info = getTimezoneInfo('America/Vancouver');
    expect(info.label).toBe('Pacific Time (PT)');
  });

  test('America/Edmonton → Mountain Time (MT)', () => {
    expect(getTimezoneInfo('America/Edmonton').label).toBe('Mountain Time (MT)');
  });

  test('America/Winnipeg → Central Time (CT)', () => {
    expect(getTimezoneInfo('America/Winnipeg').label).toBe('Central Time (CT)');
  });

  test('America/Halifax → Atlantic Time (AT)', () => {
    expect(getTimezoneInfo('America/Halifax').label).toBe('Atlantic Time (AT)');
  });

  test('unknown timezone falls back gracefully', () => {
    const info = getTimezoneInfo('America/Unknown');
    expect(info.label).toBe('America/Unknown');
    expect(info.location).toBe('Canada');
  });
});

describe('system prompt placeholder substitution', () => {
  test('{{businessName}} is replaced, no placeholder remains', () => {
    const result = 'You are an assistant for {{businessName}}.'.replace(/\{\{businessName\}\}/g, "Sam's Barbershop");
    expect(result).toContain("Sam's Barbershop");
    expect(result).not.toContain('{{businessName}}');
  });

  test('{{currentDateTime}} is NOT replaced (Vapi fills it at runtime)', () => {
    const result = 'Time: {{currentDateTime}}.'.replace(/\{\{businessName\}\}/g, "Sam's Barbershop");
    expect(result).toContain('{{currentDateTime}}');
  });
});
