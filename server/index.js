require('dotenv').config();
// Required env vars (Intel portal):
//   INTEL_USERNAME        — username for /intel login
//   INTEL_PASSWORD        — password for /intel login
//   INTEL_SESSION_SECRET  — random string to sign session cookies
// Required env vars (provisioning):
//   VAPI_API_KEY           — Vapi API key for assistant management
// Required env vars (test mode):
//   TEST_MODE              — set to 'true' to use Stripe sandbox credentials
//   STRIPE_TEST_SECRET_KEY — Stripe test secret key (sk_test_...)
//   STRIPE_TEST_WEBHOOK_SECRET — Stripe test webhook signing secret
//   STRIPE_TEST_SOLO_PRICE_ID, STRIPE_TEST_STARTER_PRICE_ID, STRIPE_TEST_PRO_PRICE_ID
// Required env vars (admin):
//   ADMIN_SECRET           — secret header value for /admin/* endpoints
const express = require('express');
const path = require('path');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { extractFromToolCall, extractBookingInfo, findBusiness, saveBooking } = require('./bookingService');
const { sendCustomerSMS, sendOwnerEmail, sendWelcomeEmail, sendInternalSignupNotification, sendPaymentFailedEmail } = require('./notificationService');
const { getAuthUrl, getTokensFromCode, createCalendarEvent } = require('./calendarService');
const stripe = require('stripe')(
  process.env.TEST_MODE === 'true'
    ? process.env.STRIPE_TEST_SECRET_KEY
    : process.env.STRIPE_SECRET_KEY
);
const { createCheckoutSession } = require('./billingService');
const { handleDepositCheckoutComplete } = require('./depositService');
const { createBusiness } = require('./signupService');
const { provisionPhoneNumber, releasePhoneNumber } = require('./twilioProvisioningService');
const { createVapiAssistant, updateVapiAssistant } = require('./vapiService');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const dashboardRoutes = require('./dashboardRoutes');
const authRoutes = require('./authRoutes');
const intelRoutes = require('./intelRoutes');
const queueService = require('./queueService');
const bookingPageRoutes = require('./bookingPageRoutes');

const app = express();

// ── CORS ──────────────────────────────────────────────────────────────────────
const corsOptions = {
  origin: [
    'https://bimblyai.com',
    'https://www.bimblyai.com',
    'http://localhost:3000',
    'http://localhost:8080'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};
app.use(cors(corsOptions));
app.options(/(.*)/, cors(corsOptions));

// ── Provisioning: checkout.session.completed ─────────────────────────────────
async function handleCheckoutCompleted(session) {
  const businessId = session.metadata?.business_id;
  if (!businessId) {
    console.error('❌ No business_id in checkout session metadata');
    return;
  }

  const { data: business } = await supabase
    .from('businesses')
    .select('*')
    .eq('id', businessId)
    .single();

  if (!business) {
    console.error('❌ Business not found for checkout session:', businessId);
    return;
  }

  // Apply plan from Stripe metadata if missing on the record
  if (!business.plan && session.metadata?.plan) {
    business.plan = session.metadata.plan;
  }

  let twilioPhone = null;
  let vapiAssistantId = null;

  try {
    // 1. Provision Twilio phone number
    console.log('📞 Provisioning Twilio number for:', business.name);
    twilioPhone = await provisionPhoneNumber(business, business.city, business.province);

    // 2. Persist phone number before Vapi creation so the assistant config has it
    await supabase.from('businesses').update({ twilio_phone: twilioPhone }).eq('id', businessId);
    const businessWithPhone = { ...business, twilio_phone: twilioPhone };

    // 3. Create Vapi assistant
    console.log('🤖 Creating Vapi assistant for:', business.name);
    vapiAssistantId = await createVapiAssistant(businessWithPhone);

    // 4. Fully activate the business
    const trialEndsAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await supabase.from('businesses').update({
      is_active: true,
      subscription_status: 'trial',
      trial_ends_at: trialEndsAt,
      stripe_customer_id: session.customer,
      stripe_subscription_id: session.subscription,
      twilio_phone: twilioPhone,
      vapi_assistant_id: vapiAssistantId,
    }).eq('id', businessId);

    // 5. Send welcome email and internal notification
    const fullyProvisioned = { ...businessWithPhone, vapi_assistant_id: vapiAssistantId, trial_ends_at: trialEndsAt };
    await sendWelcomeEmail(fullyProvisioned);
    await sendInternalSignupNotification(fullyProvisioned);

    console.log(`✅ Business fully provisioned: ${business.name} | Twilio: ${twilioPhone} | Vapi: ${vapiAssistantId}`);

  } catch (err) {
    console.error('❌ Provisioning failed for', business.name, ':', err.message);

    // Rollback: release Twilio number if Vapi creation failed partway through
    if (twilioPhone && !vapiAssistantId) {
      try {
        await releasePhoneNumber(twilioPhone);
        console.log('↩️  Rolled back Twilio number:', twilioPhone);
      } catch (rollbackErr) {
        console.error('❌ Rollback failed:', rollbackErr.message);
      }
    }

    // Mark as failed so it can be retried or investigated
    await supabase.from('businesses')
      .update({ subscription_status: 'provisioning_failed' })
      .eq('id', businessId);

    // Alert internal team
    await sendOwnerEmail(
      business,
      `Provisioning failed: ${business.name}`,
      `Provisioning failed for ${business.name} (${business.email}).

Error: ${err.message}

Business ID: ${businessId}

Check Render logs for full stack trace.`
    );
  }
}

// ── Stripe webhook (must be before express.json() to get raw body) ────────────
app.post('/billing/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.TEST_MODE === 'true'
    ? process.env.STRIPE_TEST_WEBHOOK_SECRET
    : process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    if (webhookSecret) {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } else {
      // No secret configured — parse the raw body directly (dev/test only)
      event = JSON.parse(req.body.toString());
      console.warn('⚠️  STRIPE_WEBHOOK_SECRET not set — skipping signature verification');
    }
  } catch (err) {
    console.error('❌ Stripe webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`🔔 Stripe webhook: ${event.type}`);

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      if (session.metadata?.booking_id) {
        // deposit flow — booking_id present, business_id absent
        await handleDepositCheckoutComplete(session);
      } else {
        // billing flow — business_id present, booking_id absent
        await handleCheckoutCompleted(session);
      }
    }

    else if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      await supabase.from('businesses')
        .update({ subscription_status: 'cancelled' })
        .eq('stripe_customer_id', sub.customer);
      console.log(`🚫 Subscription cancelled for customer: ${sub.customer}`);
    }

    else if (event.type === 'customer.subscription.updated') {
      const sub = event.data.object;
      // Map Stripe status → our status
      const statusMap = {
        active: 'active',
        trialing: 'trialing',
        past_due: 'past_due',
        canceled: 'cancelled',
        unpaid: 'past_due',
        paused: 'paused'
      };
      const newStatus = statusMap[sub.status] || sub.status;
      await supabase.from('businesses')
        .update({ subscription_status: newStatus })
        .eq('stripe_customer_id', sub.customer);
      console.log(`🔄 Subscription updated to "${newStatus}" for customer: ${sub.customer}`);
    }

    else if (event.type === 'invoice.payment_failed') {
      const invoice = event.data.object;
      await supabase.from('businesses')
        .update({ subscription_status: 'past_due' })
        .eq('stripe_customer_id', invoice.customer);

      // Notify business owner
      const { data: business } = await supabase.from('businesses')
        .select('email, name')
        .eq('stripe_customer_id', invoice.customer)
        .single();
      if (business) {
        await sendPaymentFailedEmail(business);
      }
      console.log(`⚠️  Payment failed for customer: ${invoice.customer}`);
    }
  } catch (err) {
    console.error('❌ Stripe webhook handler error:', err);
    return res.status(500).json({ error: err.message });
  }

  res.json({ received: true });
});

// ── Deposit routes (public, no auth) ─────────────────────────────────────────
const jwt = require('jsonwebtoken');
const depositStripe = require('stripe')(
  process.env.TEST_MODE === 'true'
    ? process.env.STRIPE_TEST_SECRET_KEY
    : process.env.STRIPE_SECRET_KEY
);
const BASE_URL_DEPOSIT = process.env.BASE_URL || 'https://bookingagent-gmo2.onrender.com';

app.get('/deposit/success', (req, res) => {
  res.status(200).send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Deposit Confirmed</title><style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f9fafb}div{text-align:center;max-width:400px;padding:2rem}</style></head><body><div><h2>✅ You're all set!</h2><p>Your spot is secured! We look forward to seeing you.</p></div></body></html>`);
});

app.get('/deposit/cancel', (req, res) => {
  res.status(200).send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Deposit Pending</title><style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f9fafb}div{text-align:center;max-width:400px;padding:2rem}</style></head><body><div><h2>No problem!</h2><p>Your link is still valid. Tap the link in your text message to submit your deposit.</p></div></body></html>`);
});

app.get('/deposit/:token', async (req, res) => {
  let payload;
  try {
    payload = jwt.verify(req.params.token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(400).send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link Expired</title><style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f9fafb}div{text-align:center;max-width:400px;padding:2rem}</style></head><body><div><h2>Link Expired</h2><p>This link has expired. Please call us to arrange your deposit.</p></div></body></html>`);
  }

  try {
    const { data: booking } = await supabase.from('bookings').select('*').eq('id', payload.bookingId).single();
    if (!booking) return res.status(404).send('Booking not found.');
    const { data: business } = await supabase.from('businesses').select('*').eq('id', booking.business_id).single();
    if (!business) return res.status(404).send('Business not found.');

    let customerId = booking.stripe_customer_id;
    if (!customerId) {
      const customer = await depositStripe.customers.create({
        name: booking.customer_name,
        phone: booking.customer_phone,
        metadata: { booking_id: booking.id },
      });
      customerId = customer.id;
      await supabase.from('bookings').update({ stripe_customer_id: customerId }).eq('id', booking.id);
    }

    const checkoutSession = await depositStripe.checkout.sessions.create({
      mode: 'setup',
      customer: customerId,
      metadata: { booking_id: booking.id },
      success_url: `${BASE_URL_DEPOSIT}/deposit/success`,
      cancel_url: `${BASE_URL_DEPOSIT}/deposit/cancel`,
    });

    res.redirect(checkoutSession.url);
  } catch (err) {
    console.error('GET /deposit/:token error:', err.message);
    res.status(500).send('Something went wrong. Please try again or contact us.');
  }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(session({
  secret: process.env.INTEL_SESSION_SECRET || 'changeme-set-INTEL_SESSION_SECRET',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' },
}));
app.use(authRoutes);
app.use(bookingPageRoutes);
app.use(dashboardRoutes);
app.use(intelRoutes);

// ── Dashboard SPA ─────────────────────────────────────────────────────────────
// Serve dashboard static files (JS, CSS) under /dashboard/
app.use('/dashboard', express.static(path.join(__dirname, '..', 'dashboard')));
// Catch-all: any /dashboard/* route serves the React app
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'dashboard', 'index.html'));
});
app.get('/dashboard/login', (req, res) => {
  res.redirect(`${process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000'}/auth/dashboard/login`);
});

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'BookingAgent API is running',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// Webhook endpoint for Vapi calls
app.post('/webhook/booking', async (req, res) => {
  try {
    console.log('📞 Received booking webhook');
    console.log('Message type:', req.body?.message?.type);

    const message = req.body.message || req.body;
    const messageType = message.type;

    // ── Type A: Custom Tool Call ──────────────────────────────────────────────
    if (messageType === 'tool-calls') {
      console.log('Tool call received: bookAppointment');
      console.log('Full tool call body:', JSON.stringify(req.body?.message, null, 2));

      const toolCalls = message.toolCallList || message.toolCalls || [];
      const toolCall = toolCalls.find(tc => tc.function?.name === 'bookAppointment');

      if (!toolCall) {
        return res.status(200).json({ results: [] });
      }

      // Parse JSON arguments string
      const toolCallArgs = typeof toolCall.function.arguments === 'string'
        ? JSON.parse(toolCall.function.arguments)
        : toolCall.function.arguments;

      const phoneNumber = message.call?.customer?.number;
      const assistantId = message.call?.assistantId;
      const callId = message.call?.id;

      const business = await findBusiness(phoneNumber, assistantId);
      if (!business) {
        console.log('⚠️  Business not found for phone:', phoneNumber);
        return res.status(200).json({
          results: [{ toolCallId: toolCall.id, result: 'Error: business not found' }]
        });
      }

      console.log(`✅ Found business: ${business.name}`);

      const bookingData = extractFromToolCall(toolCallArgs);
      console.log('Extracted booking data:', bookingData);

      const depositStatus = business.deposit_enabled ? 'pending' : 'none';
      const savedBooking = await saveBooking(business, bookingData, callId, depositStatus);

      // Send notifications (non-blocking)
      try {
        await sendCustomerSMS(business, savedBooking);
        await sendOwnerEmail(business, savedBooking);
        await createCalendarEvent(business, savedBooking);
        await supabase
          .from('bookings')
          .update({ sms_sent: true, email_sent: true })
          .eq('id', savedBooking.id);
      } catch (notificationError) {
        console.error('⚠️  Notification error:', notificationError);
      }

      // Respond to Vapi so the tool call resolves
      return res.status(200).json({
        results: [{ toolCallId: toolCall.id, result: 'Booking confirmed successfully' }]
      });
    }

    // ── Type B: End-of-Call Report (regex fallback) ───────────────────────────
    if (messageType === 'end-of-call-report') {
      const phoneNumber = message.phoneNumber?.number;
      const assistantId = message.assistant?.id;
      const callId = message.call?.id;

      const business = await findBusiness(phoneNumber, assistantId);
      if (!business) {
        console.log('⚠️  Business not found for phone:', phoneNumber);
        return res.status(200).json({ success: false, message: 'Business not found' });
      }

      console.log(`✅ Found business: ${business.name}`);

      const bookingData = extractBookingInfo(req.body);
      console.log('Extracted booking data:', bookingData);

      if (!bookingData.customerPhone || !bookingData.name || !bookingData.date || !bookingData.time) {
        console.log('⚠️  Incomplete booking data:', bookingData);
        return res.status(200).json({ success: false, message: 'Incomplete booking data' });
      }

      const depositStatus = business.deposit_enabled ? 'pending' : 'none';
      const savedBooking = await saveBooking(business, bookingData, callId, depositStatus);

      try {
        await sendCustomerSMS(business, savedBooking);
        await sendOwnerEmail(business, savedBooking);
        await createCalendarEvent(business, savedBooking);
        await supabase
          .from('bookings')
          .update({ sms_sent: true, email_sent: true })
          .eq('id', savedBooking.id);
      } catch (notificationError) {
        console.error('⚠️  Notification error:', notificationError);
      }

      return res.status(200).json({ success: true, bookingId: savedBooking.id });
    }

    // Unknown message type — acknowledge without processing
    return res.status(200).json({ received: true });

  } catch (error) {
    console.error('❌ Webhook error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Legacy /api/businesses routes removed — unauthenticated, unused by any frontend.
// Business CRUD is handled by authenticated endpoints in dashboardRoutes.js.


// Route to initiate Google Calendar connection (legacy — kept for compatibility)
app.get('/connect-calendar/:businessId', (req, res) => {
  const { businessId } = req.params;
  const authUrl = getAuthUrl(businessId);
  res.redirect(authUrl);
});

// Google OAuth - initiate connection
app.get('/auth/google', async (req, res) => {
  const { businessId } = req.query;
  if (!businessId) return res.status(400).send('Missing businessId');

  const url = getAuthUrl(businessId);
  res.redirect(url);
});

// Google OAuth - callback
app.get('/auth/google/callback', async (req, res) => {
  const { code, state: businessId } = req.query;

  try {
    const tokens = await getTokensFromCode(code);

    await supabase
      .from('businesses')
      .update({
        google_access_token: tokens.access_token,
        google_refresh_token: tokens.refresh_token || undefined,
        google_token_expiry: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null
      })
      .eq('id', businessId);

    console.log('✅ Google Calendar connected for business:', businessId);
    res.send('✅ Google Calendar connected successfully! You can close this tab.');
  } catch (error) {
    console.error('❌ OAuth callback error:', error);
    res.status(500).send('Failed to connect Google Calendar. Please try again.');
  }
});



// ── Signup routes ──────────────────────────────────────────────────────────

// GET /signup — self-serve signup page
app.get('/signup', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Start Your Free Trial — bimblyai</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #ffffff;
      color: #1f2937;
      min-height: 100vh;
      display: flex;
    }

    .form-panel {
      flex: 0 0 60%;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      padding: 48px 40px;
      overflow-y: auto;
    }

    .form-inner { width: 100%; max-width: 480px; }

    .logo { text-decoration: none; margin-bottom: 36px; display: block; }

    h1 { font-size: 28px; font-weight: 700; color: #111827; line-height: 1.2; margin-bottom: 8px; }

    .subtext { font-size: 15px; color: #6b7280; margin-bottom: 28px; line-height: 1.5; }

    .error-banner {
      display: none;
      background: #fef2f2;
      border: 1px solid #fecaca;
      color: #b91c1c;
      border-radius: 100px;
      padding: 10px 18px;
      font-size: 14px;
      margin-bottom: 20px;
      text-align: center;
    }

    .form-group { margin-bottom: 16px; }

    label {
      display: block;
      font-size: 14px;
      font-weight: 600;
      color: #374151;
      margin-bottom: 6px;
    }

    input, select {
      width: 100%;
      height: 46px;
      padding: 0 14px;
      border: 1.5px solid #e5e7eb;
      border-radius: 10px;
      font-size: 15px;
      color: #1f2937;
      background: #fff;
      transition: border-color 0.15s, box-shadow 0.15s;
      appearance: none;
      -webkit-appearance: none;
    }

    select {
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%236b7280' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 14px center;
      padding-right: 38px;
    }

    input:focus, select:focus {
      outline: none;
      border-color: #534AB7;
      box-shadow: 0 0 0 3px rgba(83,74,183,0.12);
    }

    input.invalid, select.invalid { border-color: #ef4444; box-shadow: 0 0 0 3px rgba(239,68,68,0.1); }

    .field-error { display: block; font-size: 12px; color: #ef4444; margin-top: 4px; min-height: 16px; }

    /* ── Plan cards ── */
    .plan-label {
      font-size: 14px;
      font-weight: 600;
      color: #374151;
      margin-bottom: 10px;
      display: block;
    }

    .plan-cards {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 10px;
      margin-bottom: 4px;
    }

    .plan-card {
      border: 2px solid #e5e7eb;
      border-radius: 12px;
      padding: 14px 12px;
      cursor: pointer;
      transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
      position: relative;
      background: #fff;
      user-select: none;
      -webkit-user-select: none;
    }

    .plan-card:hover { border-color: #534AB7; box-shadow: 0 0 0 3px rgba(83,74,183,0.08); }

    .plan-card.selected {
      border-color: #534AB7;
      background: #f5f4ff;
      box-shadow: 0 0 0 3px rgba(83,74,183,0.12);
    }

    .plan-card.invalid-plan { border-color: #ef4444; }

    .plan-badge {
      display: inline-block;
      font-size: 9px;
      font-weight: 700;
      color: #fff;
      background: #D85A30;
      border-radius: 100px;
      padding: 2px 7px;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      margin-bottom: 6px;
    }

    .plan-name {
      font-size: 13px;
      font-weight: 700;
      color: #111827;
      margin-bottom: 4px;
    }

    .plan-price {
      font-size: 20px;
      font-weight: 800;
      color: #111827;
      line-height: 1;
      margin-bottom: 2px;
    }

    .plan-price span {
      font-size: 12px;
      font-weight: 500;
      color: #6b7280;
    }

    .plan-features {
      margin-top: 8px;
      list-style: none;
    }

    .plan-features li {
      font-size: 11px;
      color: #6b7280;
      padding: 1px 0;
      padding-left: 14px;
      position: relative;
    }

    .plan-features li::before {
      content: '✓';
      position: absolute;
      left: 0;
      color: #534AB7;
      font-weight: 700;
    }

    .plan-card.selected .plan-features li { color: #374151; }

    .plan-check {
      position: absolute;
      top: 10px;
      right: 10px;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: #534AB7;
      display: none;
      align-items: center;
      justify-content: center;
    }

    .plan-check svg { display: block; }

    .plan-card.selected .plan-check { display: flex; }

    .btn-submit {
      width: 100%;
      height: 52px;
      background: #D85A30;
      color: #fff;
      border: none;
      border-radius: 10px;
      font-size: 16px;
      font-weight: 700;
      cursor: pointer;
      margin-top: 18px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      transition: background 0.2s, transform 0.1s;
    }

    .btn-submit:hover:not(:disabled) { background: #c24e27; transform: translateY(-1px); }
    .btn-submit:active:not(:disabled) { transform: translateY(0); }
    .btn-submit:disabled { opacity: 0.7; cursor: not-allowed; }

    .spinner {
      width: 18px; height: 18px;
      border: 2px solid rgba(255,255,255,0.4);
      border-top-color: #fff;
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
      display: none;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    .fine-print { text-align: center; font-size: 12px; color: #9ca3af; margin-top: 12px; line-height: 1.5; }
    .signin-link { text-align: center; font-size: 14px; color: #6b7280; margin-top: 20px; }
    .signin-link a { color: #534AB7; text-decoration: none; font-weight: 600; }
    .signin-link a:hover { text-decoration: underline; }

    /* ── Right panel ── */
    .social-panel {
      flex: 0 0 40%;
      background: #1a1a2e;
      display: flex;
      flex-direction: column;
      justify-content: center;
      padding: 64px 48px;
      color: #fff;
      position: relative;
      overflow: hidden;
    }

    .social-panel::before {
      content: '';
      position: absolute;
      top: -80px; right: -80px;
      width: 300px; height: 300px;
      background: rgba(83,74,183,0.15);
      border-radius: 50%;
      pointer-events: none;
    }

    .quote-mark { font-size: 60px; line-height: 1; color: #D85A30; font-family: Georgia, serif; margin-bottom: 16px; display: block; }
    .pull-quote { font-size: 17px; line-height: 1.65; color: #e2e8f0; margin-bottom: 20px; font-style: italic; }
    .attribution { font-size: 14px; color: #94a3b8; font-weight: 600; margin-bottom: 36px; }
    .divider { height: 1px; background: rgba(255,255,255,0.12); margin-bottom: 36px; }

    .stat-pills { display: flex; flex-direction: column; gap: 12px; margin-bottom: 48px; }
    .stat-pill {
      background: #fff; color: #1a1a2e; border-radius: 100px;
      padding: 10px 20px; font-size: 14px; font-weight: 700;
      display: inline-flex; align-items: center; gap: 10px; width: fit-content;
    }
    .stat-pill .stat-value { font-size: 18px; font-weight: 800; color: #534AB7; }

    @media (max-width: 768px) {
      body { flex-direction: column; }
      .form-panel { flex: none; padding: 32px 20px; order: 1; align-items: stretch; }
      .social-panel { display: none; }
      h1 { font-size: 24px; }
      .plan-cards { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>

  <div class="form-panel">
   <div class="form-inner">
    <a href="https://bimblyai.com" class="logo"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 100" height="44" style="display:block;"><g transform="translate(8, 10)"><path d="M22 38 Q22 14 42 14 Q62 14 62 38 Q62 62 82 62 Q102 62 102 38 Q102 14 82 14 Q62 14 62 38 Q62 62 42 62 Q22 62 22 38Z" fill="none" stroke="#534AB7" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="42" cy="27" r="8" fill="#534AB7"/><circle cx="43" cy="28" r="3.5" fill="white"/><circle cx="82" cy="27" r="8" fill="#534AB7"/><circle cx="83" cy="28" r="3.5" fill="white"/><path d="M52 48 Q62 56 72 48" fill="none" stroke="#534AB7" stroke-width="2.5" stroke-linecap="round" opacity="0.5"/><line x1="62" y1="14" x2="62" y2="3" stroke="#D85A30" stroke-width="3" stroke-linecap="round"/><circle cx="62" cy="3" r="6" fill="#D85A30"/></g><text x="130" y="58" font-family="'Helvetica Neue', Helvetica, Arial, sans-serif" font-size="38" font-weight="700" letter-spacing="-1"><tspan fill="#534AB7">bimbly</tspan><tspan fill="#D85A30" font-weight="300">ai</tspan></text><text x="132" y="80" font-family="'Helvetica Neue', Helvetica, Arial, sans-serif" font-size="13" font-weight="400" letter-spacing="1.8" fill="#5F5E5A">YOUR BUSINESS, POWERED BY AI</text></svg></a>

    <h1>Start your free 30-day trial</h1>
    <p class="subtext">Set up takes 15 minutes. No charges until your trial ends.</p>

    <div id="errorBanner" class="error-banner"></div>

    <form id="signupForm" novalidate>
      <div class="form-group">
        <label for="ownerName">Full Name</label>
        <input type="text" id="ownerName" name="ownerName" placeholder="Your name" autocomplete="name">
        <span class="field-error" id="ownerNameError"></span>
      </div>

      <div class="form-group">
        <label for="businessName">Business Name</label>
        <input type="text" id="businessName" name="businessName" placeholder="Sam's Barbershop" autocomplete="organization">
        <span class="field-error" id="businessNameError"></span>
      </div>

      <div class="form-group">
        <label for="email">Email Address</label>
        <input type="email" id="email" name="email" placeholder="you@yourbusiness.com" autocomplete="email">
        <span class="field-error" id="emailError"></span>
      </div>

      <div class="form-group">
        <label for="phone">Business Phone</label>
        <input type="tel" id="phone" name="phone" placeholder="+1 (416) 555-0000" autocomplete="tel">
        <span class="field-error" id="phoneError"></span>
      </div>

      <div class="form-group">
        <label for="businessType">Business Type</label>
        <select id="businessType" name="businessType">
          <option value="">Select your business type</option>
          <option value="barbershop">Barbershop</option>
          <option value="hair-salon">Hair Salon</option>
          <option value="nail-salon">Nail Salon</option>
          <option value="spa">Spa</option>
          <option value="other">Other</option>
        </select>
        <span class="field-error" id="businessTypeError"></span>
      </div>

      <!-- Plan selection -->
      <div class="form-group">
        <span class="plan-label">Choose Your Plan</span>
        <input type="hidden" id="plan" name="plan" value="">
        <div class="plan-cards" id="planCards">

          <div class="plan-card" data-plan="solo" onclick="selectPlan('solo')">
            <div class="plan-check"><svg width="10" height="8" viewBox="0 0 10 8" fill="none"><path d="M1 4l3 3 5-6" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
            <div class="plan-name">Solo</div>
            <div class="plan-price">CA$39<span>/mo</span></div>
            <ul class="plan-features">
              <li>AI phone receptionist</li>
              <li>Unlimited calls</li>
              <li>SMS + email alerts</li>
            </ul>
          </div>

          <div class="plan-card" data-plan="starter" onclick="selectPlan('starter')">
            <div class="plan-badge">Popular</div>
            <div class="plan-check"><svg width="10" height="8" viewBox="0 0 10 8" fill="none"><path d="M1 4l3 3 5-6" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
            <div class="plan-name">Starter</div>
            <div class="plan-price">CA$99<span>/mo</span></div>
            <ul class="plan-features">
              <li>Everything in Solo</li>
              <li>Multi-language</li>
              <li>Analytics dashboard</li>
            </ul>
          </div>

          <div class="plan-card" data-plan="pro" onclick="selectPlan('pro')">
            <div class="plan-check"><svg width="10" height="8" viewBox="0 0 10 8" fill="none"><path d="M1 4l3 3 5-6" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
            <div class="plan-name">Pro</div>
            <div class="plan-price">CA$199<span>/mo</span></div>
            <ul class="plan-features">
              <li>Everything in Starter</li>
              <li>Priority support</li>
              <li>Advanced analytics</li>
            </ul>
          </div>

        </div>
        <span class="field-error" id="planError"></span>
      </div>

      <button type="submit" id="submitBtn" class="btn-submit">
        <span id="submitText">Start My Free Trial →</span>
        <span id="spinner" class="spinner"></span>
      </button>
    </form>

    <p class="fine-print">30-day free trial. Then from CA$39/month. Cancel anytime.</p>
    <p class="signin-link">Already have an account? <a href="/auth/dashboard/login">Sign in</a></p>
   </div>
  </div>

  <div class="social-panel">
    <span class="quote-mark">"</span>
    <p class="pull-quote">I used to miss 8–10 calls a day mid-cut. Now every call gets answered and I get a booking notification on my phone. It paid for itself in the first week.</p>
    <p class="attribution">— Sam, Owner, Metro Cuts Toronto</p>
    <div class="divider"></div>
    <div class="stat-pills">
      <div class="stat-pill"><span class="stat-value">30+</span> calls captured monthly</div>
      <div class="stat-pill"><span class="stat-value">40%</span> after-hours bookings</div>
      <div class="stat-pill"><span class="stat-value">from $39</span> /mo all-in</div>
    </div>
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 100" height="44" style="display:block;"><g transform="translate(8, 10)"><path d="M22 38 Q22 14 42 14 Q62 14 62 38 Q62 62 82 62 Q102 62 102 38 Q102 14 82 14 Q62 14 62 38 Q62 62 42 62 Q22 62 22 38Z" fill="none" stroke="#7F77DD" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="42" cy="27" r="8" fill="#7F77DD"/><circle cx="43" cy="28" r="3.5" fill="white"/><circle cx="82" cy="27" r="8" fill="#7F77DD"/><circle cx="83" cy="28" r="3.5" fill="white"/><path d="M52 48 Q62 56 72 48" fill="none" stroke="#7F77DD" stroke-width="2.5" stroke-linecap="round" opacity="0.5"/><line x1="62" y1="14" x2="62" y2="3" stroke="#F0997B" stroke-width="3" stroke-linecap="round"/><circle cx="62" cy="3" r="6" fill="#F0997B"/></g><text x="130" y="58" font-family="'Helvetica Neue', Helvetica, Arial, sans-serif" font-size="38" font-weight="700" letter-spacing="-1"><tspan fill="#AFA9EC">bimbly</tspan><tspan fill="#F0997B" font-weight="300">ai</tspan></text><text x="132" y="80" font-family="'Helvetica Neue', Helvetica, Arial, sans-serif" font-size="13" font-weight="400" letter-spacing="1.8" fill="#5F5E5A">YOUR BUSINESS, POWERED BY AI</text></svg>
  </div>

  <script>
    // ── Plan selection ────────────────────────────────────────────────────────
    function selectPlan(plan) {
      document.getElementById('plan').value = plan;
      document.querySelectorAll('.plan-card').forEach(c => {
        c.classList.toggle('selected', c.dataset.plan === plan);
        c.classList.remove('invalid-plan');
      });
      document.getElementById('planError').textContent = '';
    }

    // ── Form validation ───────────────────────────────────────────────────────
    const form = document.getElementById('signupForm');
    const submitBtn = document.getElementById('submitBtn');
    const submitText = document.getElementById('submitText');
    const spinner = document.getElementById('spinner');
    const errorBanner = document.getElementById('errorBanner');

    function setError(inputId, errorId, msg) {
      const el = document.getElementById(inputId);
      const err = document.getElementById(errorId);
      if (msg) { el && el.classList.add('invalid'); err.textContent = msg; }
      else { el && el.classList.remove('invalid'); err.textContent = ''; }
    }

    ['ownerName','businessName','email','phone','businessType'].forEach(id => {
      const el = document.getElementById(id);
      el.addEventListener('input', () => setError(id, id + 'Error', ''));
      el.addEventListener('change', () => setError(id, id + 'Error', ''));
    });

    function validate() {
      let ok = true;
      const v = id => document.getElementById(id).value.trim();
      if (!v('ownerName'))     { setError('ownerName',     'ownerNameError',     'Please enter your name.');           ok = false; }
      if (!v('businessName'))  { setError('businessName',  'businessNameError',  'Please enter your business name.'); ok = false; }
      const email = v('email');
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setError('email', 'emailError', 'Please enter a valid email address.'); ok = false; }
      if (!v('phone'))         { setError('phone',         'phoneError',         'Please enter your phone number.');  ok = false; }
      if (!v('businessType'))  { setError('businessType',  'businessTypeError',  'Please select a business type.');   ok = false; }
      if (!v('plan')) {
        document.querySelectorAll('.plan-card').forEach(c => c.classList.add('invalid-plan'));
        document.getElementById('planError').textContent = 'Please choose a plan to continue.';
        ok = false;
      }
      return ok;
    }

    form.addEventListener('submit', async function(e) {
      e.preventDefault();
      errorBanner.style.display = 'none';
      if (!validate()) return;

      submitBtn.disabled = true;
      submitText.textContent = 'Setting up your account...';
      spinner.style.display = 'inline-block';

      try {
        const res = await fetch('/signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ownerName:    document.getElementById('ownerName').value.trim(),
            businessName: document.getElementById('businessName').value.trim(),
            email:        document.getElementById('email').value.trim(),
            phone:        document.getElementById('phone').value.trim(),
            businessType: document.getElementById('businessType').value,
            plan:         document.getElementById('plan').value,
          })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Something went wrong');
        window.location.href = data.checkoutUrl;
      } catch (err) {
        errorBanner.textContent = err.message || 'Something went wrong. Please try again or email hello@bimblyai.com';
        errorBanner.style.display = 'block';
        submitBtn.disabled = false;
        submitText.textContent = 'Start My Free Trial →';
        spinner.style.display = 'none';
      }
    });
  </script>
</body>
</html>`);
});

// POST /signup — create business and return Stripe checkout URL
app.post('/signup', async (req, res) => {
  const { businessName, ownerName, email, phone, businessType, plan = 'solo' } = req.body;

  console.log('📝 Signup attempt:', { businessName, ownerName, email, phone, businessType, plan });

  if (!businessName || !ownerName || !email || !phone || !businessType) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  let business;
  try {
    business = await createBusiness({ businessName, ownerName, email, phone, businessType, plan });
  } catch (err) {
    if (err.isUserFacing) {
      return res.status(409).json({ error: err.message });
    }
    console.error('❌ createBusiness failed');
    console.error('  message:', err.message);
    console.error('  code:', err.code);
    console.error('  details:', err.details);
    console.error('  hint:', err.hint);
    console.error('  stack:', err.stack);
    return res.status(500).json({ error: 'Failed to create account. Please try again.' });
  }

  try {
    const session = await createCheckoutSession(business.id, email, business.plan);
    res.json({ checkoutUrl: session.url });
  } catch (err) {
    console.error('❌ createCheckoutSession failed for business:', business.id);
    console.error('  message:', err.message);
    console.error('  type:', err.type);
    console.error('  stack:', err.stack);
    return res.status(500).json({ error: err.message || 'Failed to create checkout session. Please try again.' });
  }
});

// ── Billing routes ─────────────────────────────────────────────────────────

// GET /billing/checkout?businessId=xxx&plan=solo|starter|pro
// Creates a Stripe Checkout Session and redirects to Stripe hosted page
app.get('/billing/checkout', async (req, res) => {
  const { businessId, plan } = req.query;
  if (!businessId) return res.status(400).send('Missing businessId');

  try {
    const { data: business, error } = await supabase
      .from('businesses')
      .select('id, email, billing_email, plan')
      .eq('id', businessId)
      .single();

    if (error || !business) return res.status(404).send('Business not found');

    // Use plan from query param (upgrade flow), fall back to business's current plan
    const checkoutPlan = plan || business.plan || 'solo';
    const session = await createCheckoutSession(
      businessId,
      business.billing_email || business.email,
      checkoutPlan
    );
    res.redirect(303, session.url);
  } catch (err) {
    console.error('❌ Checkout error:', err);
    res.status(500).send('Failed to create checkout session');
  }
});

// GET /billing/success
app.get('/billing/success', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>You're all set — Bimbly</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f9fafb;}
.box{text-align:center;max-width:480px;padding:2rem;}
h1{font-size:1.8rem;color:#1f2937;margin-bottom:1rem;}
p{color:#6b7280;line-height:1.6;}</style></head>
<body><div class="box">
<div style="font-size:3rem;">✅</div>
<h1>You're all set!</h1>
<p>Bimbly Receptionist is now active. You'll receive a confirmation email shortly.</p>
<p style="margin-top:1.5rem;"><a href="https://bimblyai.com" style="color:#D85A30;">← Back to bimblyai.com</a></p>
</div></body></html>`);
});

// GET /billing/cancel
app.get('/billing/cancel', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>No worries — Bimbly</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f9fafb;}
.box{text-align:center;max-width:480px;padding:2rem;}
h1{font-size:1.8rem;color:#1f2937;margin-bottom:1rem;}
p{color:#6b7280;line-height:1.6;}</style></head>
<body><div class="box">
<div style="font-size:3rem;">👋</div>
<h1>No worries.</h1>
<p>You can start your free trial anytime at <a href="https://bimblyai.com" style="color:#D85A30;">bimblyai.com</a></p>
</div></body></html>`);
});


// ── POST /onboarding/complete ────────────────────────────────────────────────
// Called by the dashboard after the onboarding wizard finishes.
// Updates the Vapi assistant with the finalised services and barbers.
const authMiddlewareFn = require('./authMiddleware');
app.post('/onboarding/complete', authMiddlewareFn, async (req, res) => {
  try {
    const businessId = req.business.id;
    const { services, barbers, timezone, supported_languages } = req.body;

    const { data: business } = await supabase
      .from('businesses')
      .select('id, name, vapi_assistant_id, supported_languages, timezone')
      .eq('id', businessId)
      .single();

    if (!business) return res.status(404).json({ error: 'Business not found' });

    if (business.vapi_assistant_id) {
      const merged = { ...business, timezone: timezone || business.timezone, supported_languages: supported_languages || business.supported_languages };
      await updateVapiAssistant(business.vapi_assistant_id, merged, services || [], barbers || []);
      console.log(`✅ Onboarding complete for ${business.name} — Vapi assistant updated`);
    } else {
      console.warn(`⚠️  Onboarding complete for ${business.name} — no Vapi assistant ID on record, skipping update`);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('POST /onboarding/complete error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Walk-in Queue (public) ────────────────────────────────────────────────────
// GET /q/:businessId — mobile form for customers to join the queue
app.get('/q/:businessId', async (req, res) => {
  const { data: business, error } = await supabase
    .from('businesses')
    .select('name, queue_enabled')
    .eq('id', req.params.businessId)
    .single();

  if (error || !business) return res.status(404).send('Business not found.');
  if (!business.queue_enabled) {
    return res.status(403).send('Walk-in queue is not enabled for this business.');
  }

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Join Queue — ${business.name}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #f8fafc; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px; }
    .card { background: #fff; border-radius: 12px; padding: 32px 24px; max-width: 420px; width: 100%; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    h1 { font-size: 22px; color: #111827; margin-bottom: 6px; }
    .sub { font-size: 14px; color: #6b7280; margin-bottom: 24px; }
    label { display: block; font-size: 13px; font-weight: 600; color: #374151; margin-bottom: 4px; margin-top: 14px; }
    input, select { width: 100%; padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 15px; color: #111827; background: #fff; }
    button { margin-top: 20px; width: 100%; padding: 13px; background: #534AB7; color: #fff; font-size: 16px; font-weight: 700; border: none; border-radius: 8px; cursor: pointer; }
    button:active { background: #4338ca; }
    .success { text-align: center; padding: 24px 0; }
    .success h2 { font-size: 24px; color: #10b981; margin-bottom: 8px; }
    .success p { color: #374151; font-size: 15px; }
  </style>
</head>
<body>
  <div class="card" id="formCard">
    <h1>Join the Queue</h1>
    <p class="sub">${business.name} — walk-in waitlist</p>
    <form id="joinForm">
      <label>Your Name *</label>
      <input type="text" id="name" placeholder="e.g. Alex" required>
      <label>Phone Number *</label>
      <input type="tel" id="phone" placeholder="+1 (416) 555-0000" required>
      <label>Service (optional)</label>
      <input type="text" id="service" placeholder="e.g. Haircut">
      <label>Team Member Preference (optional)</label>
      <input type="text" id="barber" placeholder="e.g. Sam, or leave blank">
      <button type="submit" id="submitBtn">Join Queue</button>
    </form>
  </div>
  <script>
    document.getElementById('joinForm').addEventListener('submit', async function(e) {
      e.preventDefault();
      const btn = document.getElementById('submitBtn');
      btn.disabled = true; btn.textContent = 'Joining...';
      try {
        const res = await fetch('/q/${req.params.businessId}', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            customerName: document.getElementById('name').value.trim(),
            customerPhone: document.getElementById('phone').value.trim(),
            service: document.getElementById('service').value.trim() || null,
            preferredBarber: document.getElementById('barber').value.trim() || null,
          }),
        });
        const data = await res.json();
        if (!res.ok) { alert(data.error || 'Something went wrong.'); btn.disabled = false; btn.textContent = 'Join Queue'; return; }
        document.getElementById('formCard').innerHTML = '<div class="success"><h2>You\\'re in!</h2><p>You are #' + data.position + ' in the queue.<br>We\\'ll text you when it\\'s your turn.</p></div>';
      } catch { alert('Network error. Please try again.'); btn.disabled = false; btn.textContent = 'Join Queue'; }
    });
  </script>
</body>
</html>`);
});

// POST /q/:businessId — submit walk-in queue entry
app.post('/q/:businessId', async (req, res) => {
  try {
    const { data: business, error } = await supabase
      .from('businesses')
      .select('queue_enabled')
      .eq('id', req.params.businessId)
      .single();
    if (error || !business) return res.status(404).json({ error: 'Business not found.' });
    if (!business.queue_enabled) return res.status(403).json({ error: 'Queue is not enabled.' });

    const { customerName, customerPhone, service, preferredBarber } = req.body;
    if (!customerName || !customerPhone) {
      return res.status(400).json({ error: 'Name and phone are required.' });
    }
    const result = await queueService.joinQueue(req.params.businessId, {
      customerName, customerPhone, service, preferredBarber,
    });
    res.json({ position: result.position, entry: result.entry });
  } catch (err) {
    console.error('POST /q/:businessId error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /health ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    testMode: process.env.TEST_MODE === 'true',
    services: {
      supabase:  process.env.SUPABASE_URL        ? 'connected'   : 'missing',
      stripe:    (process.env.TEST_MODE === 'true' ? process.env.STRIPE_TEST_SECRET_KEY : process.env.STRIPE_SECRET_KEY)
                                                 ? (process.env.TEST_MODE === 'true' ? 'test' : 'live') : 'missing',
      twilio:    process.env.TWILIO_ACCOUNT_SID  ? 'configured'  : 'missing',
      vapi:      process.env.VAPI_API_KEY         ? 'configured'  : 'missing',
      sendgrid:  process.env.SENDGRID_API_KEY     ? 'configured'  : 'missing',
    },
  });
});




// ── POST /admin/generate-research-report ──────────────────────────────────────
// Triggers a one-time deep competitor research report (3-5 min, async).
// Immediately returns 202; report emails to vaghefi@gmail.com when done.
app.post('/admin/generate-research-report', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!process.env.ADMIN_SECRET || adminKey !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden — missing or invalid x-admin-key' });
  }

  const startTime = Date.now();
  console.log(`[research-report] Starting at ${new Date().toISOString()}`);

  // Fire and forget — don't await so response returns immediately
  const { generateResearchReport } = require('../competitor-monitor/researchReport');
  generateResearchReport()
    .then(() => console.log(`[research-report] Completed in ${Math.round((Date.now() - startTime) / 1000)}s`))
    .catch(err => console.error('[research-report] Failed:', err.message));

  return res.json({
    status: 'generating',
    message: 'This report takes approximately 15-20 minutes to generate. You will receive an email at vaghefi@gmail.com when complete.',
  });
});





// ── GET /admin/vapi-assistants ─────────────────────────────────────────────────
// Lists all Vapi assistants (id + name only).
app.get('/admin/vapi-assistants', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!process.env.ADMIN_SECRET || adminKey !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const axios = require('axios');
    const { data } = await axios.get('https://api.vapi.ai/assistant?limit=100', {
      headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}` },
      timeout: 15000,
    });
    const list = Array.isArray(data) ? data : (data.results || data.data || []);
    return res.json(list.map(a => ({ id: a.id, name: a.name, createdAt: a.createdAt })));
  } catch (err) {
    const msg = err.response ? `Vapi ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
    return res.status(500).json({ error: msg });
  }
});

// ── DELETE /admin/vapi-assistants/:id ──────────────────────────────────────────
// Deletes a specific Vapi assistant by ID.
app.delete('/admin/vapi-assistants/:id', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!process.env.ADMIN_SECRET || adminKey !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const axios = require('axios');
    await axios.delete(`https://api.vapi.ai/assistant/${req.params.id}`, {
      headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}` },
      timeout: 15000,
    });
    return res.json({ ok: true, deleted: req.params.id });
  } catch (err) {
    const msg = err.response ? `Vapi ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
    return res.status(500).json({ error: msg });
  }
});

// ── POST /admin/clone-vapi-for-sams ───────────────────────────────────────────
// One-shot: creates a proper cloned Vapi assistant for Sam's Barbershop and
// updates the businesses table with the new assistant ID.
app.post('/admin/clone-vapi-for-sams', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!process.env.ADMIN_SECRET || adminKey !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const { createVapiAssistant } = require('./vapiService');
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

    const BUSINESS_ID = 'a09fdd0b-421e-479a-b4d7-120f6a72a043';

    // Fetch business + services from Supabase
    const { data: biz, error: bizErr } = await supabase
      .from('businesses')
      .select('id, name, address, timezone, supported_languages, business_hours, barbers')
      .eq('id', BUSINESS_ID)
      .single();
    if (bizErr) throw new Error('Supabase business fetch failed: ' + bizErr.message);

    const { data: svcRows, error: svcErr } = await supabase
      .from('services')
      .select('name, price, duration_minutes, description')
      .eq('business_id', BUSINESS_ID)
      .eq('is_active', true);
    if (svcErr) throw new Error('Supabase services fetch failed: ' + svcErr.message);

    const business = {
      ...biz,
      supported_languages: biz.supported_languages || ['en', 'ko'],
    };

    const assistantId = await createVapiAssistant(business, {
      services: svcRows || [],
      businessHours: biz.business_hours || null,
    });

    // Update businesses table
    const { error } = await supabase
      .from('businesses')
      .update({ vapi_assistant_id: assistantId })
      .eq('id', BUSINESS_ID);

    if (error) throw new Error('Supabase update failed: ' + error.message);

    return res.json({ ok: true, assistantId });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /admin/patch-sams-prompt ────────────────────────────────────────────
// Rebuilds Sam's Barbershop Vapi system prompt from vapi-system-prompt.txt
// using real business data (hours, services) and PATCHes the live assistant.
app.post('/admin/patch-sams-prompt', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!process.env.ADMIN_SECRET || adminKey !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const { buildSystemPrompt } = require('./vapiService');
    const { createClient } = require('@supabase/supabase-js');
    const axios = require('axios');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

    const BUSINESS_ID = 'a09fdd0b-421e-479a-b4d7-120f6a72a043';

    const { data: biz, error: bizErr } = await supabase
      .from('businesses')
      .select('*')
      .eq('id', BUSINESS_ID)
      .single();
    if (bizErr) throw new Error('Supabase business: ' + bizErr.message);

    const { data: services, error: svcErr } = await supabase
      .from('services')
      .select('*')
      .eq('business_id', BUSINESS_ID);
    if (svcErr) throw new Error('Supabase services: ' + svcErr.message);

    const assistantId = biz.vapi_assistant_id;
    if (!assistantId) throw new Error('No vapi_assistant_id on businesses row');

    const systemPrompt = buildSystemPrompt(biz, {
      services: services || [],
      businessHours: biz.business_hours || null,
    });

    // Fetch current assistant to preserve model config
    const getRes = await axios.get(
      `https://api.vapi.ai/assistant/${assistantId}`,
      { headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    const current = getRes.data;
    const messages = (current.model && current.model.messages) || [];
    const sysMsgIndex = messages.findIndex(m => m.role === 'system');
    const updatedMessages = [...messages];
    if (sysMsgIndex >= 0) {
      updatedMessages[sysMsgIndex] = { ...messages[sysMsgIndex], content: systemPrompt };
    } else {
      updatedMessages.push({ role: 'system', content: systemPrompt });
    }

    await axios.patch(
      `https://api.vapi.ai/assistant/${assistantId}`,
      { model: { ...current.model, messages: updatedMessages } },
      { headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 15000 }
    );

    res.json({
      ok: true,
      assistantId,
      promptSnippet: systemPrompt.substring(0, 300),
    });
  } catch (err) {
    console.error('/admin/patch-sams-prompt error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /admin/patch-vapi-voice ───────────────────────────────────────────────
// One-shot: sets the voiceId on the Vapi template assistant, keeping other voice settings.
app.post('/admin/patch-vapi-voice', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!process.env.ADMIN_SECRET || adminKey !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const axios = require('axios');
    const TEMPLATE_ID = '3f7183f9-4796-4104-8b08-015a4d675792';
    const headers = { Authorization: `Bearer ${process.env.VAPI_API_KEY}`, 'Content-Type': 'application/json' };

    // Fetch current voice settings
    const { data: current } = await axios.get(`https://api.vapi.ai/assistant/${TEMPLATE_ID}`, { headers, timeout: 15000 });
    const updatedVoice = { ...current.voice, voiceId: (req.body && req.body.voiceId) || 'AZnzlk1XvdvUeBnXmlld' };

    await axios.patch(`https://api.vapi.ai/assistant/${TEMPLATE_ID}`, { voice: updatedVoice }, { headers, timeout: 15000 });

    // Confirm
    const { data: updated } = await axios.get(`https://api.vapi.ai/assistant/${TEMPLATE_ID}`, { headers, timeout: 15000 });
    return res.json({ ok: true, voice: updated.voice });
  } catch (err) {
    const msg = err.response ? `Vapi ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
    return res.status(500).json({ error: msg });
  }
});

// ── POST /admin/patch-vapi-transcriber ─────────────────────────────────────────
// One-shot: sets the transcriber on the Vapi template assistant.
app.post('/admin/patch-vapi-transcriber', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!process.env.ADMIN_SECRET || adminKey !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const axios = require('axios');
    const TEMPLATE_ID = '3f7183f9-4796-4104-8b08-015a4d675792';
    const transcriber = req.body && req.body.transcriber
      ? req.body.transcriber
      : { provider: 'deepgram', model: 'nova-2', language: 'multi' };

    await axios.patch(
      `https://api.vapi.ai/assistant/${TEMPLATE_ID}`,
      { transcriber },
      { headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 15000 }
    );

    // Fetch back to confirm
    const { data } = await axios.get(
      `https://api.vapi.ai/assistant/${TEMPLATE_ID}`,
      { headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}` }, timeout: 15000 }
    );
    return res.json({ ok: true, transcriber: data.transcriber });
  } catch (err) {
    const msg = err.response ? `Vapi ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
    return res.status(500).json({ error: msg });
  }
});

// ── POST /admin/patch-vapi-template ────────────────────────────────────────────
// Rewrites the Vapi template assistant's system prompt from vapi-system-prompt.txt.
// Run once to fix a corrupted template. Requires x-admin-key header.
app.post('/admin/patch-vapi-template', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!process.env.ADMIN_SECRET || adminKey !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const axios = require('axios');
    const fs = require('fs');
    const path = require('path');
    const TEMPLATE_ID = '3f7183f9-4796-4104-8b08-015a4d675792';

    // 1. Fetch current template
    const { data: current } = await axios.get(
      `https://api.vapi.ai/assistant/${TEMPLATE_ID}`,
      { headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}` }, timeout: 15000 }
    );

    // 2. Load canonical prompt from disk
    const canonicalPrompt = fs.readFileSync(
      path.join(__dirname, '..', 'vapi-system-prompt.txt'), 'utf8'
    );

    // 3. Replace system message with canonical version
    const messages = (current.model && current.model.messages) || [];
    const sysMsgIndex = messages.findIndex(m => m.role === 'system');
    const updatedMessages = [...messages];
    if (sysMsgIndex >= 0) {
      updatedMessages[sysMsgIndex] = { ...messages[sysMsgIndex], content: canonicalPrompt };
    } else {
      updatedMessages.unshift({ role: 'system', content: canonicalPrompt });
    }

    // 4. Patch the template
    await axios.patch(
      `https://api.vapi.ai/assistant/${TEMPLATE_ID}`,
      { model: { ...current.model, messages: updatedMessages } },
      { headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 15000 }
    );

    return res.json({ ok: true, message: 'Template system prompt updated from vapi-system-prompt.txt' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /admin/vapi-template ──────────────────────────────────────────────
// Returns the current system prompt of the Vapi template assistant.
// Requires header: x-admin-key matching ADMIN_SECRET env var.
app.get('/admin/vapi-template', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!process.env.ADMIN_SECRET || adminKey !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const axios = require('axios');
    const r = await axios.get(
      `https://api.vapi.ai/assistant/3f7183f9-4796-4104-8b08-015a4d675792`,
      { headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}` }, timeout: 15000 }
    );
    const messages = (r.data.model && r.data.model.messages) || [];
    const sys = messages.find(m => m.role === 'system');
    return res.json({
      assistantId: r.data.id,
      assistantName: r.data.name,
      systemPrompt: sys ? sys.content : null,
      transcriber: r.data.transcriber || null,
      voice: r.data.voice || null,
      allFields: Object.keys(r.data),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /admin/test-provisioning ─────────────────────────────────────────────
// Bypasses Stripe and tests the full Twilio + Vapi provisioning chain.
// Requires header: x-admin-key matching ADMIN_SECRET env var.
// Required env vars:
//   ADMIN_SECRET — any long random string, set in Render env vars
const { deleteVapiAssistant } = require('./vapiService');
app.post('/admin/test-provisioning', express.json(), async (req, res) => {
  // Auth check
  const adminKey = req.headers['x-admin-key'];
  if (!process.env.ADMIN_SECRET || adminKey !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden — missing or invalid x-admin-key' });
  }

  const {
    businessName = `Test Shop ${Date.now()}`,
    ownerName    = 'Test Owner',
    email        = `test+${Date.now()}@test.bimblyai.com`,
    phone        = '+14165550001',
    businessType = 'barbershop',
    plan         = 'solo',
    city         = 'Toronto',
    province     = 'ON',
    cleanup      = false,
  } = req.body || {};

  const steps = {};
  const errors = [];

  let businessId    = null;
  let twilioPhone   = null;
  let vapiAssistantId = null;

  console.log(`🧪 Test provisioning started: ${businessName} (${email})`);

  // Step a: Create business
  try {
    const biz = await createBusiness({ businessName, ownerName, email, phone, businessType, plan });
    businessId = biz.id;
    steps.businessCreated = { id: biz.id, name: biz.name };
    console.log(`  ✅ Business created: ${biz.id}`);
  } catch (err) {
    errors.push({ step: 'businessCreated', error: err.message });
    console.error('  ❌ Business creation failed:', err.message);
    return res.json({ success: false, steps, errors });
  }

  // Step b: Provision Twilio phone number
  try {
    const biz = { id: businessId, name: businessName, email };
    twilioPhone = await provisionPhoneNumber(biz, city, province);
    steps.twilioProvisioned = { phoneNumber: twilioPhone };
    console.log(`  ✅ Twilio provisioned: ${twilioPhone}`);
  } catch (err) {
    errors.push({ step: 'twilioProvisioned', error: err.message });
    console.error('  ❌ Twilio provisioning failed:', err.message);
    // Cleanup business
    await supabase.from('businesses').delete().eq('id', businessId);
    return res.json({ success: false, steps, errors });
  }

  // Step c: Create Vapi assistant
  try {
    const biz = { id: businessId, name: businessName, email, twilio_phone: twilioPhone, plan };
    vapiAssistantId = await createVapiAssistant(biz);
    steps.vapiCreated = { assistantId: vapiAssistantId };
    console.log(`  ✅ Vapi assistant created: ${vapiAssistantId}`);
  } catch (err) {
    errors.push({ step: 'vapiCreated', error: err.message });
    console.error('  ❌ Vapi creation failed:', err.message);
    // Rollback Twilio + business
    try { await releasePhoneNumber(twilioPhone); } catch (e) { console.warn('Rollback Twilio failed:', e.message); }
    await supabase.from('businesses').delete().eq('id', businessId);
    return res.json({ success: false, steps, errors });
  }

  // Step d+e: Update Supabase record
  try {
    const trialEndsAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await supabase.from('businesses').update({
      twilio_phone: twilioPhone,
      vapi_assistant_id: vapiAssistantId,
      is_active: true,
      subscription_status: 'trial',
      trial_ends_at: trialEndsAt,
    }).eq('id', businessId);
    steps.supabaseUpdated = true;
    console.log('  ✅ Supabase updated');
  } catch (err) {
    errors.push({ step: 'supabaseUpdated', error: err.message });
    console.error('  ❌ Supabase update failed:', err.message);
  }

  // Step f: Welcome email
  try {
    const trialEndsAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const biz = { id: businessId, name: businessName, email, phone, plan, twilio_phone: twilioPhone, vapi_assistant_id: vapiAssistantId, trial_ends_at: trialEndsAt };
    await sendWelcomeEmail(biz);
    steps.welcomeEmailSent = true;
    console.log('  ✅ Welcome email sent');
  } catch (err) {
    errors.push({ step: 'welcomeEmailSent', error: err.message });
    console.error('  ❌ Welcome email failed:', err.message);
  }

  // Step g: Internal notification
  try {
    const biz = { id: businessId, name: businessName, owner_name: ownerName, email, phone, business_type: businessType, plan, twilio_phone: twilioPhone, vapi_assistant_id: vapiAssistantId };
    await sendInternalSignupNotification(biz);
    steps.internalNotificationSent = true;
    console.log('  ✅ Internal notification sent');
  } catch (err) {
    errors.push({ step: 'internalNotificationSent', error: err.message });
    console.error('  ❌ Internal notification failed:', err.message);
  }

  // Step h: Schedule cleanup
  if (cleanup) {
    steps.cleanupScheduled = true;
    setTimeout(async () => {
      console.log('🧹 Running test cleanup...');
      try {
        if (vapiAssistantId) await deleteVapiAssistant(vapiAssistantId);
        console.log('  ✅ Vapi assistant deleted');
      } catch (e) { console.warn('  ⚠️  Vapi cleanup failed:', e.message); }
      try {
        if (twilioPhone) await releasePhoneNumber(twilioPhone);
        console.log('  ✅ Twilio number released');
      } catch (e) { console.warn('  ⚠️  Twilio cleanup failed:', e.message); }
      try {
        if (businessId) await supabase.from('businesses').delete().eq('id', businessId);
        console.log('  ✅ Business record deleted');
      } catch (e) { console.warn('  ⚠️  Supabase cleanup failed:', e.message); }
      console.log('🧹 Test cleanup complete');
    }, 5000);
  } else {
    steps.cleanupScheduled = false;
  }

  const success = errors.length === 0;
  console.log(`🧪 Test provisioning ${success ? 'PASSED ✅' : 'FAILED ❌'} (${errors.length} errors)`);
  res.json({ success, steps, errors });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  setInterval(() => queueService.autoExpireNoShows(), 60_000);
  console.log(`🚀 BookingAgent server running on port ${PORT}`);
  console.log(`📊 Environment: ${process.env.NODE_ENV}`);
  console.log(`🔗 Health check: http://localhost:${PORT}`);
  if (process.env.TEST_MODE === 'true') {
    console.warn('⚠️  TEST MODE ACTIVE — using Stripe sandbox credentials');
    console.warn('⚠️  TEST MODE: Twilio/Vapi still use live credentials — test resources will be auto-released if cleanup=true');
  }
  console.log('Supabase URL configured:', process.env.SUPABASE_URL ? process.env.SUPABASE_URL.substring(0, 30) + '...' : 'MISSING');
  console.log('Node version:', process.version);
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.warn('⚠️  STRIPE_WEBHOOK_SECRET is not set — webhook signature verification disabled. Set this after configuring the webhook in the Stripe dashboard.');
  }
  if (!process.env.JWT_SECRET) {
    console.warn('⚠️  JWT_SECRET is not set — dashboard authentication will fail. Set this in Render environment variables.');
  }
  if (!process.env.STRIPE_SOLO_PRICE_ID) {
    console.warn('⚠️  STRIPE_SOLO_PRICE_ID is not set — Solo plan signups will fail.');
  }
  if (!process.env.STRIPE_STARTER_PRICE_ID) {
    console.warn('⚠️  STRIPE_STARTER_PRICE_ID is not set — Starter plan signups will fail.');
  }
  if (!process.env.STRIPE_PRO_PRICE_ID) {
    console.warn('⚠️  STRIPE_PRO_PRICE_ID is not set — Pro plan signups will fail.');
  }
  if (!process.env.VAPI_API_KEY) {
    console.warn('⚠️  VAPI_API_KEY is not set — Vapi assistant provisioning will fail.');
  }
  if (!process.env.ADMIN_SECRET) {
    console.warn('⚠️  ADMIN_SECRET not set — /admin/* endpoints will return 403');
    // Add ADMIN_SECRET to Render env vars: any long random string (e.g. openssl rand -hex 32)
  }
  if (!process.env.INTEL_USERNAME || !process.env.INTEL_PASSWORD) {
    console.warn('⚠️  INTEL_USERNAME / INTEL_PASSWORD not set — /intel portal will not be accessible.');
  }
  if (!process.env.INTEL_SESSION_SECRET) {
    console.warn('⚠️  INTEL_SESSION_SECRET not set — using insecure fallback. Set this in Render env vars.');
  }
  console.log('\nAdd these to Render env vars for the bookingagent service:');
  console.log('  INTEL_USERNAME=your_chosen_username');
  console.log('  INTEL_PASSWORD=your_chosen_password');
  console.log('  INTEL_SESSION_SECRET=any_long_random_string');
});