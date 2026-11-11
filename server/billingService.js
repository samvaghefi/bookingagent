const Stripe = require('stripe');

const stripe = Stripe(
  process.env.TEST_MODE === 'true'
    ? process.env.STRIPE_TEST_SECRET_KEY
    : process.env.STRIPE_SECRET_KEY
);
const BASE_URL = process.env.BASE_URL || 'https://bookingagent-gmo2.onrender.com';

// createCustomer() and createSubscription() were removed.
// The signup flow goes directly to Stripe Checkout (createCheckoutSession),
// which handles customer creation internally. No need for a separate customer
// or subscription object before checkout completes.

// Select the correct price ID based on TEST_MODE and plan
function priceIds() {
  const isTest = process.env.TEST_MODE === 'true';
  return {
    solo:    isTest ? process.env.STRIPE_TEST_SOLO_PRICE_ID    : (process.env.STRIPE_SOLO_PRICE_ID    || process.env.STRIPE_PRICE_ID),
    starter: isTest ? process.env.STRIPE_TEST_STARTER_PRICE_ID : process.env.STRIPE_STARTER_PRICE_ID,
    pro:     isTest ? process.env.STRIPE_TEST_PRO_PRICE_ID     : process.env.STRIPE_PRO_PRICE_ID,
  };
}

// Signup: unknown or unset plans fall back to Solo
function getPriceId(plan) {
  const ids = priceIds();
  return ids[plan] || ids.solo;
}

const PLANS = ['solo', 'starter', 'pro'];

// Reverse lookup: which plan a Stripe price belongs to (null if unknown)
function planForPriceId(priceId) {
  if (!priceId) return null;
  const ids = priceIds();
  return PLANS.find(p => ids[p] && ids[p] === priceId) || null;
}

// Move an existing subscription to another plan. Swaps the price on the
// subscription's single item, so there is never a second subscription.
// Stripe prorates: upgrades bill the difference, downgrades leave a credit.
// During a trial nothing is charged until the trial ends.
async function changeSubscriptionPlan(subscriptionId, plan) {
  if (!PLANS.includes(plan)) throw new Error(`Unknown plan: ${plan}`);
  const priceId = priceIds()[plan]; // strict: never fall back to another plan's price
  if (!priceId) throw new Error(`No Stripe price ID configured for plan: ${plan}`);

  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  const item = sub.items?.data?.[0];
  if (!item) throw new Error('Subscription has no items.');
  if (item.price?.id === priceId) return sub;

  console.log(`🔁 Changing subscription ${subscriptionId} to plan: ${plan}`);
  return stripe.subscriptions.update(subscriptionId, {
    items: [{ id: item.id, price: priceId }],
    proration_behavior: 'create_prorations',
    metadata: { ...(sub.metadata || {}), plan },
  });
}

// Cancel a subscription at the end of the current billing period
async function cancelSubscription(subscriptionId) {
  console.log(`🚫 Cancelling subscription at period end: ${subscriptionId}`);
  return stripe.subscriptions.update(subscriptionId, {
    cancel_at_period_end: true,
  });
}

// Retrieve a subscription and its current status
async function getSubscription(subscriptionId) {
  return stripe.subscriptions.retrieve(subscriptionId);
}

// Create a Stripe Checkout Session for self-serve signup.
// plan: 'solo' | 'starter' | 'pro' (defaults to 'solo')
async function createCheckoutSession(businessId, businessEmail, plan = 'solo') {
  const priceId = getPriceId(plan);

  if (!priceId) throw new Error(`No Stripe price ID configured for plan: ${plan} (TEST_MODE=${process.env.TEST_MODE})`);

  const mode = process.env.TEST_MODE === 'true' ? 'TEST' : 'LIVE';
  console.log(`🛒 [${mode}] Creating checkout session for business: ${businessId} (plan: ${plan})`);

  return stripe.checkout.sessions.create({
    mode: 'subscription',
    customer_email: businessEmail,
    line_items: [{ price: priceId, quantity: 1 }],
    subscription_data: { trial_period_days: 30 },
    success_url: `${BASE_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${BASE_URL}/billing/cancel`,
    metadata: { business_id: businessId, plan },
  });
}

module.exports = { cancelSubscription, getSubscription, createCheckoutSession, changeSubscriptionPlan, planForPriceId, getPriceId, PLANS };
