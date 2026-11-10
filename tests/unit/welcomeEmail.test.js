'use strict';

function load(sendImpl) {
  jest.resetModules();
  const send = jest.fn(sendImpl || (async () => [{ statusCode: 202 }]));
  jest.doMock('twilio', () => () => ({ messages: { create: jest.fn() } }));
  jest.doMock('@sendgrid/mail', () => ({ setApiKey: jest.fn(), send }));
  const mod = require('../../server/notificationService');
  return { ...mod, send };
}

const GOOGLE_BIZ = {
  name: 'Fade Room', owner_name: 'Jay Patel', email: 'jay@faderoom.ca', plan: 'starter',
  twilio_phone: '+13653348294', trial_ends_at: '2026-12-10T21:21:37.411Z', password_hash: null,
};
const PASSWORD_BIZ = { ...GOOGLE_BIZ, password_hash: '$2a$10$abc' };
const SIGN_IN = 'https://bookingagent-gmo2.onrender.com/auth/dashboard/login';

describe('buildWelcomeEmail', () => {
  test('links to the sign-in page in both HTML and text', () => {
    const { buildWelcomeEmail } = load();
    const { html, text } = buildWelcomeEmail(GOOGLE_BIZ);
    expect(html).toContain(`href="${SIGN_IN}"`);
    expect(text).toContain(SIGN_IN);
  });

  test('Google accounts are told to use Sign in with Google', () => {
    const { buildWelcomeEmail } = load();
    const { html, text } = buildWelcomeEmail(GOOGLE_BIZ);
    expect(html).toMatch(/Sign in with Google/);
    expect(text).toMatch(/Sign in with Google.*jay@faderoom\.ca/);
    expect(text).not.toMatch(/password you created/);
  });

  test('password accounts are told to use email and password', () => {
    const { buildWelcomeEmail } = load();
    const { text } = buildWelcomeEmail(PASSWORD_BIZ);
    expect(text).toMatch(/jay@faderoom\.ca, and the password you created/);
    expect(text).not.toMatch(/Sign in with Google/);
  });

  test('shows first name, shop, plan, trial end and a readable phone number', () => {
    const { buildWelcomeEmail } = load();
    const { html, text, subject } = buildWelcomeEmail(GOOGLE_BIZ);
    expect(subject).toBe("Welcome to Bimbly. Here's how to sign in");
    expect(html).toContain('Welcome to Bimbly, Jay.');
    expect(html).toContain('Fade Room');
    expect(text).toContain('Starter, CA$99/month after your trial');
    expect(text).toContain('December 10, 2026');
    expect(text).toContain('(365) 334-8294');
  });

  test('uses a PNG logo (email clients do not show SVG)', () => {
    const { buildWelcomeEmail } = load();
    expect(buildWelcomeEmail(GOOGLE_BIZ).html).toContain('bimblyai-logo-email.png');
  });

  test('escapes shop and owner names', () => {
    const { buildWelcomeEmail } = load();
    const { html } = buildWelcomeEmail({ ...GOOGLE_BIZ, name: '<script>x</script>', owner_name: '<b>Jay' });
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Welcome to Bimbly, &lt;b&gt;Jay.');
  });

  test('copes with missing optional fields', () => {
    const { buildWelcomeEmail } = load();
    const { text } = buildWelcomeEmail({ email: 'a@b.co' });
    expect(text).toContain('Welcome to Bimbly, there.');
    expect(text).toContain('Nothing is charged for 30 days.');
    expect(text).toContain('Solo, CA$39/month');
    expect(text).not.toContain('Your Bimbly number');
  });

  test('no em dashes in the copy', () => {
    const { buildWelcomeEmail } = load();
    const { html, text, subject } = buildWelcomeEmail(GOOGLE_BIZ);
    expect(html + text + subject).not.toContain('—');
  });
});

describe('sendWelcomeEmail', () => {
  test('sends to the account email from Bimbly with reply-to', async () => {
    const { sendWelcomeEmail, send } = load();
    await expect(sendWelcomeEmail(GOOGLE_BIZ)).resolves.toBe(true);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      to: 'jay@faderoom.ca',
      from: { email: 'hello@bimblyai.com', name: 'Bimbly' },
      replyTo: 'hello@bimblyai.com',
    }));
  });

  test('returns false (does not throw) when SendGrid fails', async () => {
    const err = Object.assign(new Error('Unauthorized'), { code: 401, response: { body: { errors: [{ message: 'bad key' }] } } });
    const { sendWelcomeEmail } = load(async () => { throw err; });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(sendWelcomeEmail(GOOGLE_BIZ)).resolves.toBe(false);
    expect(spy.mock.calls[0][0]).toMatch(/401.*bad key/);
    spy.mockRestore();
  });
});
