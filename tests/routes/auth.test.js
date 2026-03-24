'use strict';

const request  = require('supertest');
const express  = require('express');
const jwt      = require('jsonwebtoken');
const bcrypt   = require('bcryptjs');

const JWT_SECRET = process.env.JWT_SECRET;

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PASSWORD       = 'hunter2Correct!';
const PASSWORD_HASH  = bcrypt.hashSync(PASSWORD, 10);

const BUSINESS = {
  id:            'biz-123',
  name:          "Sam's Barbershop",
  email:         'sam@example.com',
  is_active:     true,
  password_hash: PASSWORD_HASH,
};

const BUSINESS_NO_PASSWORD = {
  ...BUSINESS,
  id:            'biz-456',
  password_hash: null,
};

// ── Supabase chain builder ─────────────────────────────────────────────────────

function chain(result) {
  const self = { then: (res, rej) => Promise.resolve(result).then(res, rej) };
  ['select','eq','update'].forEach(m => {
    self[m] = () => chain(result);
  });
  self.single      = () => Promise.resolve(result);
  self.maybeSingle = () => Promise.resolve(result);
  return self;
}

// ── App factory ────────────────────────────────────────────────────────────────

function buildApp({ business = BUSINESS, sgSend = jest.fn().mockResolvedValue() } = {}) {
  jest.resetModules();

  jest.doMock('@supabase/supabase-js', () => ({
    createClient: () => ({
      from: () => ({
        select: () => ({
          eq: () => ({
            single:      () => Promise.resolve(business ? { data: business, error: null } : { data: null, error: { message: 'not found' } }),
            maybeSingle: () => Promise.resolve(business ? { data: business, error: null } : { data: null, error: null }),
          }),
        }),
        update: () => ({
          eq: () => Promise.resolve({ error: null }),
        }),
      }),
    }),
  }));

  jest.doMock('@sendgrid/mail', () => ({ setApiKey: jest.fn(), send: sgSend }));

  const router = require('../../server/authRoutes');
  const app = express();
  app.use(express.json());
  app.use(router);
  return { app, sgSend };
}

// ── POST /auth/login ───────────────────────────────────────────────────────────

describe('POST /auth/login', () => {
  test('200 + JWT for correct email/password', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/auth/login')
      .send({ email: BUSINESS.email, password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    const decoded = jwt.verify(res.body.token, JWT_SECRET);
    expect(decoded.businessId).toBe(BUSINESS.id);
    expect(decoded.email).toBe(BUSINESS.email);
  });

  test('401 for wrong password', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/auth/login')
      .send({ email: BUSINESS.email, password: 'wrongpassword' });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid/i);
  });

  test('401 for unknown email', async () => {
    const { app } = buildApp({ business: null });
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'nobody@example.com', password: PASSWORD });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid/i);
  });

  test('401 when account has no password set (Google-only)', async () => {
    const { app } = buildApp({ business: BUSINESS_NO_PASSWORD });
    const res = await request(app)
      .post('/auth/login')
      .send({ email: BUSINESS_NO_PASSWORD.email, password: PASSWORD });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/no password|google/i);
  });

  test('400 when email or password missing', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/auth/login')
      .send({ email: BUSINESS.email });

    expect(res.status).toBe(400);
  });
});

// ── POST /auth/forgot-password ────────────────────────────────────────────────

describe('POST /auth/forgot-password', () => {
  test('200 and sends reset email for known account', async () => {
    const { app, sgSend } = buildApp();
    const res = await request(app)
      .post('/auth/forgot-password')
      .send({ email: BUSINESS.email });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/sent|check/i);
    expect(sgSend).toHaveBeenCalledTimes(1);

    // The email should contain a link with a reset token
    const emailPayload = sgSend.mock.calls[0][0];
    const textContent = emailPayload.text || JSON.stringify(emailPayload);
    expect(textContent).toMatch(/reset/i);
  });

  test('200 (silent) for unknown email — no enumeration', async () => {
    const { app, sgSend } = buildApp({ business: null });
    const res = await request(app)
      .post('/auth/forgot-password')
      .send({ email: 'nobody@example.com' });

    expect(res.status).toBe(200);
    expect(sgSend).not.toHaveBeenCalled();
  });

  test('400 when email missing', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/auth/forgot-password')
      .send({});

    expect(res.status).toBe(400);
  });

  test('reset token embedded in email is a valid JWT', async () => {
    const { app, sgSend } = buildApp();
    await request(app)
      .post('/auth/forgot-password')
      .send({ email: BUSINESS.email });

    const emailPayload = sgSend.mock.calls[0][0];
    const textContent = emailPayload.text || '';
    // Extract token from URL in the email body
    const tokenMatch = textContent.match(/token=([A-Za-z0-9_\-\.]+)/);
    expect(tokenMatch).not.toBeNull();

    const decoded = jwt.verify(tokenMatch[1], JWT_SECRET);
    expect(decoded.purpose).toBe('password-reset');
    expect(decoded.email).toBe(BUSINESS.email);
  });
});

// ── POST /auth/reset-password ─────────────────────────────────────────────────

describe('POST /auth/reset-password', () => {
  function makeResetToken(email, options = {}) {
    return jwt.sign(
      { email, purpose: 'password-reset' },
      JWT_SECRET,
      { expiresIn: '1h', ...options }
    );
  }

  test('200 and updates password_hash for valid token + new password', async () => {
    const { app } = buildApp();
    const token = makeResetToken(BUSINESS.email);
    const res = await request(app)
      .post('/auth/reset-password')
      .send({ token, password: 'NewPassword99!' });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/reset|success/i);
  });

  test('400 for missing token or password', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/auth/reset-password')
      .send({ token: makeResetToken(BUSINESS.email) });

    expect(res.status).toBe(400);
  });

  test('400 for expired token', async () => {
    const { app } = buildApp();
    const token = makeResetToken(BUSINESS.email, { expiresIn: '-1s' });
    const res = await request(app)
      .post('/auth/reset-password')
      .send({ token, password: 'NewPassword99!' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/expired|invalid/i);
  });

  test('400 for token with wrong purpose', async () => {
    const { app } = buildApp();
    const token = jwt.sign({ email: BUSINESS.email, purpose: 'something-else' }, JWT_SECRET, { expiresIn: '1h' });
    const res = await request(app)
      .post('/auth/reset-password')
      .send({ token, password: 'NewPassword99!' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
  });

  test('400 for tampered/invalid token', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/auth/reset-password')
      .send({ token: 'notavalidjwt', password: 'NewPassword99!' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
  });
});

// ── POST /api/auth/change-password ────────────────────────────────────────────

describe('POST /api/auth/change-password', () => {
  function buildAuthApp({ business = BUSINESS } = {}) {
    jest.resetModules();

    jest.doMock('@supabase/supabase-js', () => ({
      createClient: () => ({
        from: () => ({
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: business, error: null }),
            }),
          }),
          update: () => ({
            eq: () => Promise.resolve({ error: null }),
          }),
        }),
      }),
    }));

    jest.doMock('@sendgrid/mail', () => ({ setApiKey: jest.fn(), send: jest.fn().mockResolvedValue() }));
    jest.doMock('googleapis', () => ({ google: { auth: { OAuth2: jest.fn() }, oauth2: jest.fn() } }));

    // Stub authMiddleware to inject business
    jest.doMock('../../server/authMiddleware', () => (req, res, next) => {
      req.business = business;
      next();
    });

    const dashRouter    = require('../../server/dashboardRoutes');
    const app = express();
    app.use(express.json());
    app.use(dashRouter);
    return app;
  }

  test('200 for correct current password + valid new password', async () => {
    const app = buildAuthApp();
    const res = await request(app)
      .post('/api/auth/change-password')
      .send({ currentPassword: PASSWORD, newPassword: 'NewSecure99!', confirmPassword: 'NewSecure99!' });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/updated|success/i);
  });

  test('401 for wrong current password', async () => {
    const app = buildAuthApp();
    const res = await request(app)
      .post('/api/auth/change-password')
      .send({ currentPassword: 'wrong-password', newPassword: 'NewSecure99!', confirmPassword: 'NewSecure99!' });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/incorrect|current/i);
  });

  test('400 when new password and confirm do not match', async () => {
    const app = buildAuthApp();
    const res = await request(app)
      .post('/api/auth/change-password')
      .send({ currentPassword: PASSWORD, newPassword: 'NewSecure99!', confirmPassword: 'DifferentPass99!' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/match/i);
  });

  test('400 when required fields missing', async () => {
    const app = buildAuthApp();
    const res = await request(app)
      .post('/api/auth/change-password')
      .send({ currentPassword: PASSWORD });

    expect(res.status).toBe(400);
  });

  test('400 when account has no password set (Google-only account)', async () => {
    const app = buildAuthApp({ business: BUSINESS_NO_PASSWORD });
    const res = await request(app)
      .post('/api/auth/change-password')
      .send({ currentPassword: PASSWORD, newPassword: 'NewSecure99!', confirmPassword: 'NewSecure99!' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no password|google/i);
  });
});
