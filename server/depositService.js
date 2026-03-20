const jwt = require('jsonwebtoken');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(
  process.env.TEST_MODE === 'true'
    ? process.env.STRIPE_TEST_SECRET_KEY
    : process.env.STRIPE_SECRET_KEY
);

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

function createDepositToken(booking) {
  return jwt.sign({ bookingId: booking.id }, process.env.JWT_SECRET, { expiresIn: '24h' });
}

async function handleDepositCheckoutComplete(session) {
  const bookingId = session.metadata.booking_id;
  const setupIntent = await stripe.setupIntents.retrieve(session.setup_intent);
  await supabase.from('bookings').update({
    deposit_status: 'secured',
    stripe_customer_id: session.customer,
    stripe_payment_method_id: setupIntent.payment_method,
    stripe_setup_intent_id: session.setup_intent,
  }).eq('id', bookingId);
}

async function chargeNoShow(booking, business) {
  await stripe.paymentIntents.create({
    amount: business.deposit_amount,
    currency: 'cad',
    customer: booking.stripe_customer_id,
    payment_method: booking.stripe_payment_method_id,
    payment_method_types: ['card'],
    confirm: true,
    off_session: true,
  });
  await supabase.from('bookings').update({ deposit_status: 'charged' }).eq('id', booking.id);
}

module.exports = { createDepositToken, handleDepositCheckoutComplete, chargeNoShow };
