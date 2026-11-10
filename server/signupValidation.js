'use strict';

// Server-side checks for self-serve signup and password changes.
// Mirrors the rules on bimblyai.com/signup (signup.js) so a request that
// skips the website form gets the same answer.

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)*\.[a-z]{2,}$/i;

const PASSWORD_RULES = [
  { id: 'len',     test: pw => pw.length >= 8,               label: 'at least 8 characters' },
  { id: 'upper',   test: pw => /[A-Z]/.test(pw),             label: 'one capital letter' },
  { id: 'num',     test: pw => /[0-9]/.test(pw),             label: 'one number' },
  { id: 'special', test: pw => /[^A-Za-z0-9\s]/.test(pw),    label: 'one special character' },
];
// bcrypt only uses the first 72 bytes, so longer passwords would be silently truncated
const PASSWORD_MAX_BYTES = 72;

const PROVINCES      = ['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT'];
const BUSINESS_TYPES = ['barbershop', 'hair-salon', 'nail-salon', 'other'];

function isValidEmail(email) {
  return typeof email === 'string' && email.length <= 254 && EMAIL_RE.test(email.trim());
}

// Returns null if the password is fine, otherwise a user-facing message.
function passwordError(pw) {
  if (typeof pw !== 'string' || !pw) return 'Please create a password.';
  if (Buffer.byteLength(pw, 'utf8') > PASSWORD_MAX_BYTES) return 'Password is too long. Please use 72 characters or fewer.';
  const missing = PASSWORD_RULES.filter(r => !r.test(pw)).map(r => r.label);
  if (!missing.length) return null;
  const list = missing.length === 1
    ? missing[0]
    : missing.slice(0, -1).join(', ') + ' and ' + missing[missing.length - 1];
  return `Password needs ${list}.`;
}

// Canadian/NANP number → "+1XXXXXXXXXX", or null if it isn't 10 digits.
// Accepts any punctuation and an optional leading country code 1.
function normalizePhone(phone) {
  if (typeof phone !== 'string') return null;
  let d = phone.replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  return d.length === 10 ? '+1' + d : null;
}

// Validates the POST /signup body.
// Returns { errors, values }: errors maps field → message (empty when valid),
// values holds trimmed/normalised data ready for createBusiness().
function validateSignup(body = {}) {
  const str = v => (typeof v === 'string' ? v.trim() : '');
  const errors = {};

  const businessName = str(body.businessName);
  const ownerName    = str(body.ownerName);
  const email        = str(body.email);
  const password     = typeof body.password === 'string' ? body.password : '';
  const confirm      = typeof body.confirmPassword === 'string' ? body.confirmPassword : '';
  const businessType = str(body.businessType);
  const city         = str(body.city);
  const province     = str(body.province).toUpperCase();
  const plan         = str(body.plan) || 'solo';

  if (!ownerName)    errors.ownerName    = 'Please enter your name.';
  if (!businessName) errors.businessName = 'Please enter your business name.';

  if (!email)                    errors.email = 'Please enter your email.';
  else if (!isValidEmail(email)) errors.email = 'Please enter a valid email address.';

  const pwErr = passwordError(password);
  if (pwErr) errors.password = pwErr;
  if (!confirm)                errors.confirmPassword = 'Please type your password again.';
  else if (confirm !== password) errors.confirmPassword = 'Passwords do not match.';

  const phone = normalizePhone(str(body.phone));
  if (!str(body.phone)) errors.phone = 'Please enter your phone number.';
  else if (!phone)      errors.phone = 'Please enter a 10-digit phone number.';

  if (!city) errors.city = 'Please enter your city.';

  if (!province)                          errors.province = 'Please select your province.';
  else if (!PROVINCES.includes(province)) errors.province = 'Please select a valid province.';

  if (!businessType)                               errors.businessType = 'Please select a business type.';
  else if (!BUSINESS_TYPES.includes(businessType)) errors.businessType = 'Please select a valid business type.';

  if (!['solo', 'starter', 'pro'].includes(plan)) errors.plan = 'Please choose a plan.';

  return {
    errors,
    values: { businessName, ownerName, email, password, phone, businessType, city, province, plan },
  };
}

module.exports = { validateSignup, passwordError, isValidEmail, normalizePhone, PASSWORD_RULES };
