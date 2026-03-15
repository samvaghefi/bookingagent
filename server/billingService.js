const Stripe = require('stripe');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const BASE_URL = process.env.BASE_URL || 'https://bookingagent-gmo2.onrender.com';

// Create a Stripe customer for a business
async function createCustomer(business) {
  console.log(`💳 Creating Stripe customer for business: ${business.name}`);
  return stripe.customers.create({
    email: business.billing_email || business.email,
    name: business.name,
    metadata: { business_id: business.id }
  });
}

// Create a subscription with a free trial
async function createSubscription(customerId, trialDays = 30) {
  console.log(`📅 Creating subscription with ${trialDays}-day trial for customer: ${customerId}`);
  return stripe.subscriptions.create({
    customer: customerId,
    items: [{ price: process.env.STRIPE_PRICE_ID }],
    trial_period_days: trialDays,
    payment_settings: { save_default_payment_method: 'on_subscription' }
  });
}

// Cancel a subscription at the end of the current billing period
async function cancelSubscription(subscriptionId) {
  console.log(`🚫 Cancelling subscription at period end: ${subscriptionId}`);
  return stripe.subscriptions.update(subscriptionId, {
    cancel_at_period_end: true
  });
}

// Retrieve a subscription and its current status
async function getSubscription(subscriptionId) {
  return stripe.subscriptions.retrieve(subscriptionId);
}

// Create a Stripe Checkout Session for self-serve signup
async function createCheckoutSession(businessId, businessEmail) {
  console.log(`🛒 Creating checkout session for business: ${businessId}`);
  return stripe.checkout.sessions.create({
    mode: 'subscription',
    customer_email: businessEmail,
    line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
    subscription_data: { trial_period_days: 30 },
    success_url: `${BASE_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${BASE_URL}/billing/cancel`,
    metadata: { business_id: businessId }
  });
}

module.exports = {
  createCustomer,
  createSubscription,
  cancelSubscription,
  getSubscription,
  createCheckoutSession
};
