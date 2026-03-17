const Stripe = require('stripe');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const BASE_URL = process.env.BASE_URL || 'https://bookingagent-gmo2.onrender.com';

// createCustomer() and createSubscription() were removed.
// The signup flow goes directly to Stripe Checkout (createCheckoutSession),
// which handles customer creation internally. No need for a separate customer
// or subscription object before checkout completes.

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
  const priceId =
    plan === 'pro'     ? process.env.STRIPE_PRO_PRICE_ID :
    plan === 'starter' ? process.env.STRIPE_STARTER_PRICE_ID :
    (process.env.STRIPE_SOLO_PRICE_ID || process.env.STRIPE_PRICE_ID);

  if (!priceId) throw new Error(`No Stripe price ID configured for plan: ${plan}`);

  console.log(`🛒 Creating checkout session for business: ${businessId} (plan: ${plan})`);
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

module.exports = { cancelSubscription, getSubscription, createCheckoutSession };
