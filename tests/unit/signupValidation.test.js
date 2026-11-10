'use strict';

const { validateSignup, passwordError, isValidEmail, normalizePhone } = require('../../server/signupValidation');

const VALID = {
  businessName: 'Fade Room',
  ownerName: 'Jay Patel',
  email: 'jay@faderoom.ca',
  password: 'Fade2026!',
  confirmPassword: 'Fade2026!',
  phone: '416 555 0123',
  businessType: 'barbershop',
  city: 'Toronto',
  province: 'ON',
  plan: 'starter',
};

describe('passwordError', () => {
  test.each([
    ['Fade2026!'],
    ['Abcdefg1#'],
    ['P@ssw0rd'],
    ['Correct-Horse-9'],
  ])('accepts %s', pw => expect(passwordError(pw)).toBeNull());

  test('rejects empty', () => expect(passwordError('')).toBe('Please create a password.'));
  test('rejects non-string', () => expect(passwordError(undefined)).toBe('Please create a password.'));
  test('needs 8 characters', () => expect(passwordError('Ab1!')).toBe('Password needs at least 8 characters.'));
  test('needs a capital', () => expect(passwordError('fade2026!')).toBe('Password needs one capital letter.'));
  test('needs a number', () => expect(passwordError('FadeRoom!')).toBe('Password needs one number.'));
  test('needs a special character', () => expect(passwordError('Fade2026')).toBe('Password needs one special character.'));
  test('a space does not count as special', () => expect(passwordError('Fade 2026')).toBe('Password needs one special character.'));
  test('lists several missing rules', () => {
    expect(passwordError('password')).toBe('Password needs one capital letter, one number and one special character.');
  });
  test('rejects passwords over bcrypt\'s 72-byte limit', () => {
    expect(passwordError('Aa1!' + 'x'.repeat(70))).toMatch(/too long/);
  });
});

describe('isValidEmail', () => {
  test.each(['a@b.co', 'jay@faderoom.ca', 'me@my.shop.ca', 'first.last+tag@gmail.com'])('accepts %s', e => {
    expect(isValidEmail(e)).toBe(true);
  });
  test.each(['', 'jay', 'jay@shop', 'jay@@shop.com', 'jay @shop.com', '@shop.com', 'jay@.com', 'jay@shop.c'])('rejects "%s"', e => {
    expect(isValidEmail(e)).toBe(false);
  });
  test('rejects non-strings', () => expect(isValidEmail(null)).toBe(false));
});

describe('normalizePhone', () => {
  test.each([
    ['416 555 0123', '+14165550123'],
    ['4165550123', '+14165550123'],
    ['(416) 555-0123', '+14165550123'],
    ['+1 416 555 0123', '+14165550123'],
    ['1-416-555-0123', '+14165550123'],
  ])('%s → %s', (input, out) => expect(normalizePhone(input)).toBe(out));

  test.each(['', '416 555', '416555012', '24165550123', '416555012345'])('rejects "%s"', p => {
    expect(normalizePhone(p)).toBeNull();
  });
});

describe('validateSignup', () => {
  test('valid body has no errors and normalised values', () => {
    const { errors, values } = validateSignup({ ...VALID, email: ' Jay@FadeRoom.ca ', province: 'on' });
    expect(errors).toEqual({});
    expect(values).toMatchObject({ email: 'jay@faderoom.ca', phone: '+14165550123', province: 'ON', plan: 'starter' });
  });

  test('empty body flags every field', () => {
    const { errors } = validateSignup({});
    expect(Object.keys(errors).sort()).toEqual(
      ['businessName', 'businessType', 'city', 'confirmPassword', 'email', 'ownerName', 'password', 'phone', 'province'].sort()
    );
  });

  test('plan defaults to solo when missing', () => {
    const { plan, ...rest } = VALID;
    expect(validateSignup(rest).values.plan).toBe('solo');
  });

  test('unknown plan is rejected', () => {
    expect(validateSignup({ ...VALID, plan: 'enterprise' }).errors.plan).toBeDefined();
  });

  test('weak password is rejected', () => {
    expect(validateSignup({ ...VALID, password: 'password1', confirmPassword: 'password1' }).errors.password).toMatch(/capital/);
  });

  test('mismatched confirmation is rejected', () => {
    expect(validateSignup({ ...VALID, confirmPassword: 'Fade2026?' }).errors.confirmPassword).toBe('Passwords do not match.');
  });

  test('short phone is rejected', () => {
    expect(validateSignup({ ...VALID, phone: '416 555' }).errors.phone).toMatch(/10-digit/);
  });

  test('bad email is rejected', () => {
    expect(validateSignup({ ...VALID, email: 'jay@faderoom' }).errors.email).toMatch(/valid email/);
  });

  test('unknown province and business type are rejected', () => {
    const { errors } = validateSignup({ ...VALID, province: 'XX', businessType: 'spa' });
    expect(errors.province).toBeDefined();
    expect(errors.businessType).toBeDefined();
  });

  test('non-string fields do not throw', () => {
    expect(() => validateSignup({ ...VALID, email: 42, password: {}, phone: [] })).not.toThrow();
  });
});
