'use strict';

const request      = require('supertest');
const express      = require('express');
const cookieParser = require('cookie-parser');
const jwt          = require('jsonwebtoken');

const SHOP = {
  businessName: 'Fade Room', businessType: 'barbershop', phone: '416 555 0123',
  city: 'Toronto', province: 'ON', plan: 'starter',
};

function buildApp({ userInfo = { email: 'Jay@FadeRoom.ca', name: 'Jay Patel', verified_email: true }, createBusinessImpl, tokenError } = {}) {
  jest.resetModules();
  const createBusiness = jest.fn(createBusinessImpl || (async d => ({ id: 'biz-1', name: d.businessName, plan: d.plan })));
  const createCheckoutSession = jest.fn(async () => ({ url: 'https://checkout.stripe.com/c/test' }));
  const generateAuthUrl = jest.fn(opts => 'https://accounts.google.com/o/oauth2/auth?state=' + encodeURIComponent(opts.state));

  jest.doMock('@supabase/supabase-js', () => ({ createClient: () => ({ from: () => ({}) }) }));
  jest.doMock('@sendgrid/mail', () => ({ setApiKey: jest.fn(), send: jest.fn() }));
  jest.doMock('../../server/signupService', () => ({ createBusiness }));
  jest.doMock('../../server/billingService', () => ({ createCheckoutSession }));
  jest.doMock('googleapis', () => ({
    google: {
      auth: { OAuth2: jest.fn(() => ({
        generateAuthUrl,
        getToken: tokenError ? jest.fn().mockRejectedValue(new Error('bad code')) : jest.fn().mockResolvedValue({ tokens: {} }),
        setCredentials: jest.fn(),
      })) },
      oauth2: () => ({ userinfo: { get: async () => ({ data: userInfo }) } }),
    },
  }));

  const router = require('../../server/authRoutes');
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(cookieParser());
  app.use(router);
  return { app, createBusiness, createCheckoutSession, generateAuthUrl };
}

// Starts the flow and returns { state, cookie } as the browser would carry them
async function start(app, body = SHOP) {
  const res = await request(app).post('/signup/google').type('form').send(body);
  const location = res.headers.location || '';
  const state = new URL(location).searchParams.get('state');
  const cookie = (res.headers['set-cookie'] || []).find(c => c.startsWith('bimbly_gsu='));
  return { res, state, cookie: cookie && cookie.split(';')[0] };
}

describe('POST /signup/google', () => {
  test('valid shop details → redirect to Google with signed state and a nonce cookie', async () => {
    const { app, generateAuthUrl } = buildApp();
    const { res, state, cookie } = await start(app);
    expect(res.status).toBe(303);
    expect(res.headers.location).toMatch(/^https:\/\/accounts\.google\.com/);
    expect(state).toMatch(/^signup\./);
    expect(cookie).toMatch(/^bimbly_gsu=[0-9a-f]{32}$/);
    const payload = jwt.verify(state.slice(7), process.env.JWT_SECRET);
    expect(payload.shop).toMatchObject({ businessName: 'Fade Room', phone: '+14165550123', plan: 'starter', province: 'ON' });
    expect(payload.nonce).toBe(cookie.split('=')[1]);
    expect(generateAuthUrl.mock.calls[0][0].prompt).toBe('select_account');
  });

  test('missing shop details → back to the website with error=invalid', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/signup/google').type('form').send({ plan: 'solo' });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('https://bimblyai.com/signup?error=invalid');
  });

  test('does not require name, email or password', async () => {
    const { app } = buildApp();
    const { res } = await start(app);
    expect(res.headers.location).not.toMatch(/bimblyai\.com/);
  });
});

describe('Google signup callback', () => {
  test('creates the account from Google and goes to Stripe checkout', async () => {
    const { app, createBusiness, createCheckoutSession } = buildApp();
    const { state, cookie } = await start(app);
    const res = await request(app).get('/auth/dashboard/callback').query({ code: 'abc', state }).set('Cookie', cookie);

    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('https://checkout.stripe.com/c/test');
    expect(createBusiness).toHaveBeenCalledWith(expect.objectContaining({
      businessName: 'Fade Room', email: 'jay@faderoom.ca', ownerName: 'Jay Patel',
      phone: '+14165550123', plan: 'starter', city: 'Toronto', province: 'ON', passwordHash: null,
    }));
    expect(createCheckoutSession).toHaveBeenCalledWith('biz-1', 'jay@faderoom.ca', 'starter');
  });

  test('rejects a state without the matching browser cookie', async () => {
    const { app, createBusiness } = buildApp();
    const { state } = await start(app);
    const res = await request(app).get('/auth/dashboard/callback').query({ code: 'abc', state }).set('Cookie', 'bimbly_gsu=deadbeef');
    expect(res.headers.location).toBe('https://bimblyai.com/signup?error=google_expired');
    expect(createBusiness).not.toHaveBeenCalled();
  });

  test('rejects a forged state', async () => {
    const { app, createBusiness } = buildApp();
    const forged = 'signup.' + jwt.sign({ purpose: 'google-signup', nonce: 'n', shop: SHOP }, 'wrong-secret');
    const res = await request(app).get('/auth/dashboard/callback').query({ code: 'abc', state: forged }).set('Cookie', 'bimbly_gsu=n');
    expect(res.headers.location).toBe('https://bimblyai.com/signup?error=google_expired');
    expect(createBusiness).not.toHaveBeenCalled();
  });

  test('person cancels at Google → back to the website', async () => {
    const { app } = buildApp();
    const { state, cookie } = await start(app);
    const res = await request(app).get('/auth/dashboard/callback').query({ error: 'access_denied', state }).set('Cookie', cookie);
    expect(res.headers.location).toBe('https://bimblyai.com/signup?error=google_cancelled');
  });

  test('existing account → error=exists', async () => {
    const dup = Object.assign(new Error('An account with this email already exists.'), { isUserFacing: true });
    const { app } = buildApp({ createBusinessImpl: async () => { throw dup; } });
    const { state, cookie } = await start(app);
    const res = await request(app).get('/auth/dashboard/callback').query({ code: 'abc', state }).set('Cookie', cookie);
    expect(res.headers.location).toBe('https://bimblyai.com/signup?error=exists');
  });

  test('unverified Google email is refused', async () => {
    const { app, createBusiness } = buildApp({ userInfo: { email: 'x@y.co', verified_email: false } });
    const { state, cookie } = await start(app);
    const res = await request(app).get('/auth/dashboard/callback').query({ code: 'abc', state }).set('Cookie', cookie);
    expect(res.headers.location).toBe('https://bimblyai.com/signup?error=google_no_email');
    expect(createBusiness).not.toHaveBeenCalled();
  });

  test('token exchange failure → error=google_failed', async () => {
    const { app } = buildApp({ tokenError: true });
    const { state, cookie } = await start(app);
    const res = await request(app).get('/auth/dashboard/callback').query({ code: 'abc', state }).set('Cookie', cookie);
    expect(res.headers.location).toBe('https://bimblyai.com/signup?error=google_failed');
  });

  test('normal Google sign-in state still goes to the login flow', async () => {
    const { app, createBusiness } = buildApp();
    const res = await request(app).get('/auth/dashboard/callback').query({ code: 'abc', state: 'nope' });
    expect(res.headers.location).toMatch(/error=invalid_state/);
    expect(createBusiness).not.toHaveBeenCalled();
  });
});
