'use strict';

// Plan changes must switch the existing Stripe subscription, never create a second one.

const request = require('supertest');
const express = require('express');

const PRICES = { solo: 'price_solo', starter: 'price_starter', pro: 'price_pro' };

function setPriceEnv() {
  process.env.STRIPE_SOLO_PRICE_ID = PRICES.solo;
  process.env.STRIPE_STARTER_PRICE_ID = PRICES.starter;
  process.env.STRIPE_PRO_PRICE_ID = PRICES.pro;
  delete process.env.TEST_MODE;
}

function mockStripe({ currentPrice = PRICES.solo } = {}) {
  const stripeApi = {
    subscriptions: {
      retrieve: jest.fn().mockResolvedValue({
        id: 'sub_1', metadata: { business_id: 'biz-1' }, cancel_at_period_end: false,
        items: { data: [{ id: 'si_1', price: { id: currentPrice, unit_amount: 3900 } }] },
      }),
      update: jest.fn().mockImplementation((id, params) => Promise.resolve({
        id, cancel_at_period_end: false, metadata: params.metadata,
        items: { data: [{ id: 'si_1', price: { id: params.items[0].price, unit_amount: params.items[0].price === PRICES.pro ? 19900 : 9900 } }] },
      })),
    },
    checkout: { sessions: { create: jest.fn() } },
  };
  jest.doMock('stripe', () => () => stripeApi);
  return stripeApi;
}

describe('billingService plan helpers', () => {
  beforeEach(() => { jest.resetModules(); setPriceEnv(); });

  test('changeSubscriptionPlan swaps the price on the existing item', async () => {
    const stripe = mockStripe();
    const { changeSubscriptionPlan } = require('../../server/billingService');
    await changeSubscriptionPlan('sub_1', 'pro');
    expect(stripe.subscriptions.update).toHaveBeenCalledWith('sub_1', expect.objectContaining({
      items: [{ id: 'si_1', price: PRICES.pro }],
      proration_behavior: 'create_prorations',
      metadata: expect.objectContaining({ plan: 'pro', business_id: 'biz-1' }),
    }));
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  test('does nothing when already on that price', async () => {
    const stripe = mockStripe({ currentPrice: PRICES.starter });
    const { changeSubscriptionPlan } = require('../../server/billingService');
    await changeSubscriptionPlan('sub_1', 'starter');
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  test('refuses a plan whose price is not configured (no silent fallback to Solo)', async () => {
    mockStripe();
    delete process.env.STRIPE_PRO_PRICE_ID;
    const { changeSubscriptionPlan } = require('../../server/billingService');
    await expect(changeSubscriptionPlan('sub_1', 'pro')).rejects.toThrow(/No Stripe price ID/);
  });

  test('rejects unknown plans', async () => {
    mockStripe();
    const { changeSubscriptionPlan } = require('../../server/billingService');
    await expect(changeSubscriptionPlan('sub_1', 'enterprise')).rejects.toThrow(/Unknown plan/);
  });

  test('planForPriceId maps prices back to plans', () => {
    mockStripe();
    const { planForPriceId } = require('../../server/billingService');
    expect(planForPriceId(PRICES.starter)).toBe('starter');
    expect(planForPriceId(PRICES.pro)).toBe('pro');
    expect(planForPriceId('price_other')).toBeNull();
    expect(planForPriceId(undefined)).toBeNull();
  });
});

describe('POST /api/billing/change-plan', () => {
  const BASE = { id: 'biz-1', plan: 'solo', stripe_subscription_id: 'sub_1', subscription_status: 'trial', email: 'o@example.com' };

  function buildApp(business = BASE) {
    jest.resetModules();
    setPriceEnv();
    const stripe = mockStripe();
    const updates = [];
    jest.doMock('@supabase/supabase-js', () => ({
      createClient: () => ({
        from: () => ({
          update: data => ({ eq: () => { updates.push(data); return Promise.resolve({ error: null }); } }),
        }),
      }),
    }));
    jest.doMock('@sendgrid/mail', () => ({ setApiKey: jest.fn(), send: jest.fn().mockResolvedValue() }));
    jest.doMock('googleapis', () => ({ google: { auth: { OAuth2: jest.fn() }, oauth2: jest.fn() } }));
    jest.doMock('../../server/authMiddleware', () => (req, res, next) => { req.business = { ...business }; next(); });
    const router = require('../../server/dashboardRoutes');
    const app = express();
    app.use(express.json());
    app.use(router);
    return { app, stripe, updates };
  }

  test('Solo can upgrade straight to Pro (skipping Starter)', async () => {
    const { app, stripe, updates } = buildApp();
    const res = await request(app).post('/api/billing/change-plan').send({ plan: 'pro' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, plan: 'pro', amount: 199 });
    expect(stripe.subscriptions.update).toHaveBeenCalledTimes(1);
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    expect(updates).toContainEqual({ plan: 'pro' });
  });

  test('Pro can downgrade to Starter', async () => {
    const { app, updates } = buildApp({ ...BASE, plan: 'pro' });
    const res = await request(app).post('/api/billing/change-plan').send({ plan: 'starter' });
    expect(res.status).toBe(200);
    expect(updates).toContainEqual({ plan: 'starter' });
  });

  test('400 for the current plan', async () => {
    const { app, stripe } = buildApp();
    const res = await request(app).post('/api/billing/change-plan').send({ plan: 'solo' });
    expect(res.status).toBe(400);
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  test('400 for an unknown plan', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/api/billing/change-plan').send({ plan: 'gold' });
    expect(res.status).toBe(400);
  });

  test('400 when there is no live subscription', async () => {
    const { app, stripe } = buildApp({ ...BASE, subscription_status: 'cancelled' });
    const res = await request(app).post('/api/billing/change-plan').send({ plan: 'pro' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/hello@bimblyai.com/);
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  test('500 with a friendly message when Stripe fails, and the plan is not changed', async () => {
    const { app, stripe, updates } = buildApp();
    stripe.subscriptions.update.mockRejectedValueOnce(new Error('card_declined'));
    const res = await request(app).post('/api/billing/change-plan').send({ plan: 'starter' });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/could not change your plan/i);
    expect(updates).toHaveLength(0);
  });
});
