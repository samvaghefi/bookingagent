'use strict';

// Mock supabase before requiring the module
jest.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
  }),
}));
jest.mock('../../server/depositService', () => ({}));
jest.mock('../../server/notificationService', () => ({}));

// Re-require after mocks are in place
const {
  extractFromToolCall,
  extractBookingInfo,
} = require('../../server/bookingService');

// ── extractFromToolCall ────────────────────────────────────────────────────────

describe('extractFromToolCall', () => {
  const base = {
    customerName: 'John Smith',
    customerPhone: '+14165550000',
    service: "Men's Haircut",
    appointmentDate: '2026-03-25',
    appointmentTime: '10:00',
    specialRequests: null,
    serviceCount: 1,
    preferredBarber: null,
    isNewCustomer: false,
  };

  test('extracts all standard fields', () => {
    const result = extractFromToolCall(base);
    expect(result.name).toBe('John Smith');
    expect(result.customerPhone).toBe('+14165550000');
    expect(result.service).toBe("Men's Haircut");
    expect(result.date).toBe('2026-03-25');
    expect(result.time).toBe('10:00');
    expect(result.serviceCount).toBe(1);
    expect(result.preferredBarber).toBeNull();
    expect(result.isNewCustomer).toBe(false);
  });

  test('falls back to callbackNumber when customerPhone is missing', () => {
    const args = { ...base, customerPhone: null, callbackNumber: '+14165559999' };
    expect(extractFromToolCall(args).customerPhone).toBe('+14165559999');
  });

  test('specialRequests defaults to null when absent', () => {
    const args = { ...base, specialRequests: undefined };
    expect(extractFromToolCall(args).specialRequests).toBeNull();
  });

  test('serviceCount defaults to 1 when absent', () => {
    const args = { ...base, serviceCount: undefined };
    expect(extractFromToolCall(args).serviceCount).toBe(1);
  });

  test('isNewCustomer defaults to false when absent', () => {
    const args = { ...base, isNewCustomer: undefined };
    expect(extractFromToolCall(args).isNewCustomer).toBe(false);
  });

  test('captures preferredBarber when provided', () => {
    const args = { ...base, preferredBarber: 'Sam' };
    expect(extractFromToolCall(args).preferredBarber).toBe('Sam');
  });

  test('captures specialRequests when provided', () => {
    const args = { ...base, specialRequests: 'No fades' };
    expect(extractFromToolCall(args).specialRequests).toBe('No fades');
  });

  test('isNewCustomer is true when explicitly set', () => {
    const args = { ...base, isNewCustomer: true };
    expect(extractFromToolCall(args).isNewCustomer).toBe(true);
  });
});

// ── extractBookingInfo (regex fallback) ───────────────────────────────────────

describe('extractBookingInfo', () => {
  function makePayload(summary, phone = '+14165550001') {
    return {
      message: {
        summary,
        transcript: '',
        customer: { number: phone },
      },
    };
  }

  test('extracts customer phone from message.customer.number', () => {
    const result = extractBookingInfo(makePayload('John called to book.', '+14165550001'));
    expect(result.customerPhone).toBe('+14165550001');
  });

  test('extracts name from "X called" pattern', () => {
    const result = extractBookingInfo(makePayload('John called to book a haircut for Saturday.'));
    expect(result.name).toBe('John');
  });

  test('extracts name from "for their son/daughter" pattern', () => {
    const result = extractBookingInfo(makePayload("Parent called to book for their son, Marcus, on Saturday."));
    expect(result.name).toBe('Marcus');
  });

  test('extracts time from "2 PM" format', () => {
    const result = extractBookingInfo(makePayload('Booking at 2 PM on Saturday.'));
    expect(result.time).toBe('2 PM');
  });

  test('extracts time from "10:30 AM" format', () => {
    const result = extractBookingInfo(makePayload('Appointment at 10:30 AM.'));
    expect(result.time).toBe('10:30 AM');
  });

  test('detects beard trim service', () => {
    const result = extractBookingInfo(makePayload('Customer wants a beard trim on Saturday.'));
    expect(result.service).toContain('beard trim');
  });

  test("detects men's haircut service", () => {
    const result = extractBookingInfo(makePayload("Customer wants a men's haircut on Saturday."));
    expect(result.service).toContain("men's haircut");
  });

  test("detects kid's haircut service", () => {
    const result = extractBookingInfo(makePayload("Haircut for their son on Saturday."));
    expect(result.service).toContain("kid's haircut");
  });

  test('defaults service to "appointment" when none detected', () => {
    const result = extractBookingInfo(makePayload('Customer called to schedule something.'));
    expect(result.service).toBe('appointment');
  });

  test('handles end-of-call-report format (data at root)', () => {
    const result = extractBookingInfo({
      summary: 'Alex called to book a haircut.',
      transcript: '',
      customer: { number: '+14165550002' },
    });
    expect(result.customerPhone).toBe('+14165550002');
  });

  test('extracts date with day-of-week prefix', () => {
    const result = extractBookingInfo(makePayload('Appointment on Saturday, March 21st, 2026 at 10 AM.'));
    expect(result.date).toBeTruthy();
    expect(result.date).toMatch(/Saturday/i);
  });

  test('returns null name when no name pattern matches', () => {
    const result = extractBookingInfo(makePayload(''));
    expect(result.name).toBeNull();
  });
});

// ── convertTo24HourTime (tested indirectly via extractFromToolCall) ────────────

describe('time/date conversion helpers (indirect)', () => {
  test('extractFromToolCall preserves already-formatted HH:MM time', () => {
    const args = {
      customerName: 'Test', customerPhone: '+1234567890',
      service: 'Haircut', appointmentDate: '2026-03-25', appointmentTime: '14:30',
    };
    expect(extractFromToolCall(args).time).toBe('14:30');
  });

  test('extractFromToolCall preserves YYYY-MM-DD date', () => {
    const args = {
      customerName: 'Test', customerPhone: '+1234567890',
      service: 'Haircut', appointmentDate: '2026-12-01', appointmentTime: '09:00',
    };
    expect(extractFromToolCall(args).date).toBe('2026-12-01');
  });
});
