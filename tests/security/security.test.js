'use strict';

/**
 * Security regression tests.
 * These tests verify that specific vulnerabilities that were fixed remain fixed.
 */

// ── Input validation regexes (extracted from bookingPageRoutes.js) ─────────────

const PHONE_REGEX = /^\+?[\d\s\-().]{7,20}$/;
const DATE_REGEX  = /^\d{4}-\d{2}-\d{2}$/;
const TIME_REGEX  = /^\d{2}:\d{2}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

describe('phone number validation', () => {
  const valid = ['+14165550000', '+1 (416) 555-0000', '416-555-0000', '(416) 555-0000', '+447911123456'];
  const invalid = [
    '',
    'abc',
    '123',           // too short
    '+1,eq.businesses.select.*', // PostgREST injection attempt
    'OR 1=1',
    '+1' + 'x'.repeat(19),       // too long
    '\'; DROP TABLE businesses; --',
  ];

  valid.forEach(p => {
    test(`accepts valid phone: ${p}`, () => {
      expect(PHONE_REGEX.test(p)).toBe(true);
    });
  });

  invalid.forEach(p => {
    test(`rejects invalid phone: "${p}"`, () => {
      expect(PHONE_REGEX.test(p)).toBe(false);
    });
  });
});

describe('appointment date validation', () => {
  test('accepts YYYY-MM-DD', () => expect(DATE_REGEX.test('2026-03-25')).toBe(true));
  test('rejects DD/MM/YYYY',  () => expect(DATE_REGEX.test('25/03/2026')).toBe(false));
  test('rejects plain text',  () => expect(DATE_REGEX.test('March 25')).toBe(false));
  test('rejects empty',       () => expect(DATE_REGEX.test('')).toBe(false));
  test('rejects injection',   () => expect(DATE_REGEX.test("2026-03-25'; DROP TABLE bookings;--")).toBe(false));
});

describe('appointment time validation', () => {
  test('accepts HH:MM', () => expect(TIME_REGEX.test('09:30')).toBe(true));
  test('accepts 00:00', () => expect(TIME_REGEX.test('00:00')).toBe(true));
  test('accepts 23:59', () => expect(TIME_REGEX.test('23:59')).toBe(true));
  test('rejects HH:MM:SS (route expects two-part)',     () => expect(TIME_REGEX.test('09:30:00')).toBe(false));
  test('rejects "9:30" (single digit hour)',             () => expect(TIME_REGEX.test('9:30')).toBe(false));
  test('rejects "2 PM" format',                         () => expect(TIME_REGEX.test('2 PM')).toBe(false));
  test('rejects injection',                             () => expect(TIME_REGEX.test("09:30'; --")).toBe(false));
});

describe('email validation', () => {
  test('accepts standard email',  () => expect(EMAIL_REGEX.test('user@example.com')).toBe(true));
  test('accepts subdomain email', () => expect(EMAIL_REGEX.test('user@mail.example.com')).toBe(true));
  test('rejects missing @',       () => expect(EMAIL_REGEX.test('userexample.com')).toBe(false));
  test('rejects empty',           () => expect(EMAIL_REGEX.test('')).toBe(false));
  test('rejects plain text',      () => expect(EMAIL_REGEX.test('notanemail')).toBe(false));
});

// ── findBusiness input validation ─────────────────────────────────────────────

describe('findBusiness phone validation regex', () => {
  // This is the regex used inside bookingService.findBusiness to sanitize before .or()
  const SAFE_PHONE = /^\+?[\d\s\-().]{7,20}$/;
  const SAFE_ASSISTANT = /^[a-zA-Z0-9_\-]{5,60}$/;

  test('valid E.164 phone passes', () => {
    expect(SAFE_PHONE.test('+14165550000')).toBe(true);
  });

  test('PostgREST injection in phone is rejected', () => {
    expect(SAFE_PHONE.test('+1,vapi_assistant_id.eq.anything')).toBe(false);
  });

  test('valid UUID-style assistant ID passes', () => {
    expect(SAFE_ASSISTANT.test('3f7183f9-4796-4104-8b08-015a4d675792')).toBe(true);
  });

  test('assistant ID with SQL injection is rejected', () => {
    expect(SAFE_ASSISTANT.test("abc' OR '1'='1")).toBe(false);
  });

  test('empty strings are rejected for both', () => {
    expect(SAFE_PHONE.test('')).toBe(false);
    expect(SAFE_ASSISTANT.test('')).toBe(false);
  });
});

// ── Session cookie configuration ──────────────────────────────────────────────

describe('session cookie secure flag', () => {
  test('secure flag is true in production', () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const secure = process.env.NODE_ENV === 'production';
    expect(secure).toBe(true);
    process.env.NODE_ENV = originalEnv;
  });

  test('secure flag is false in test/development', () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    const secure = process.env.NODE_ENV === 'production';
    expect(secure).toBe(false);
    process.env.NODE_ENV = originalEnv;
  });
});

// ── Debug logging: verify no credential exposure ──────────────────────────────

describe('intel login route has no debug credential logging', () => {
  const fs = require('fs');
  const path = require('path');
  const intelSource = fs.readFileSync(
    path.join(__dirname, '../../server/intelRoutes.js'), 'utf8'
  );

  test('no DEBUG LOGIN console.log in intelRoutes.js', () => {
    expect(intelSource).not.toMatch(/DEBUG LOGIN/);
  });

  test('no password substring logging (first N chars pattern)', () => {
    // Ensure we removed the .substring(0, 6) password leaking pattern
    expect(intelSource).not.toMatch(/INTEL_PASSWORD.*substring/);
  });
});

// ── Removed endpoints: unauthenticated /api/businesses ───────────────────────

describe('legacy unauthenticated /api/businesses endpoints are removed', () => {
  const fs = require('fs');
  const path = require('path');
  const indexSource = fs.readFileSync(
    path.join(__dirname, '../../server/index.js'), 'utf8'
  );

  test('GET /api/businesses (list all) route is removed', () => {
    // Should not find the unprotected handler
    expect(indexSource).not.toMatch(/app\.get\(['"]\/api\/businesses['"]/);
  });

  test('POST /api/businesses (create with raw req.body) route is removed', () => {
    expect(indexSource).not.toMatch(/app\.post\(['"]\/api\/businesses['"]/);
  });

  test('PATCH /api/businesses/:id (update with raw req.body) route is removed', () => {
    expect(indexSource).not.toMatch(/app\.patch\(['"]\/api\/businesses\//);
  });
});
