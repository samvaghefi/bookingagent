require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { extractFromToolCall, extractBookingInfo, findBusiness, saveBooking } = require('./bookingService');
const { sendCustomerSMS, sendOwnerEmail, sendPaymentFailedEmail } = require('./notificationService');
const { getAuthUrl, getTokensFromCode, createCalendarEvent } = require('./calendarService');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createCheckoutSession } = require('./billingService');

const app = express();

// ── Stripe webhook (must be before express.json() to get raw body) ────────────
app.post('/billing/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

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
      const businessId = session.metadata?.business_id;
      if (businessId) {
        await supabase.from('businesses').update({
          stripe_customer_id: session.customer,
          stripe_subscription_id: session.subscription,
          subscription_status: 'active'
        }).eq('id', businessId);
        console.log(`✅ Subscription activated for business: ${businessId}`);
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

app.use(express.json());

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

      const savedBooking = await saveBooking(business, bookingData, callId);

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

      const savedBooking = await saveBooking(business, bookingData, callId);

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

// API endpoint to get all businesses
app.get('/api/businesses', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('businesses')
      .select('id, name, email, phone, is_active')
      .order('created_at', { ascending: false });
    
    if (error) throw error;
    
    res.json({ businesses: data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API endpoint to get bookings for a business
app.get('/api/businesses/:businessId/bookings', async (req, res) => {
  try {
    const { businessId } = req.params;
    
    const { data, error } = await supabase
      .from('bookings')
      .select('*')
      .eq('business_id', businessId)
      .order('appointment_date', { ascending: true });
    
    if (error) throw error;
    
    res.json({ bookings: data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API endpoint to create a new business
app.post('/api/businesses', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('businesses')
      .insert(req.body)
      .select()
      .single();
    
    if (error) throw error;
    
    res.status(201).json({ business: data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API endpoint to update a business
app.patch('/api/businesses/:businessId', async (req, res) => {
  try {
    const { businessId } = req.params;
    
    const { data, error } = await supabase
      .from('businesses')
      .update(req.body)
      .eq('id', businessId)
      .select()
      .single();
    
    if (error) throw error;
    
    res.json({ business: data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


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



// ── Billing routes ─────────────────────────────────────────────────────────

// GET /billing/checkout?businessId=xxx
// Creates a Stripe Checkout Session and redirects to Stripe hosted page
app.get('/billing/checkout', async (req, res) => {
  const { businessId } = req.query;
  if (!businessId) return res.status(400).send('Missing businessId');

  try {
    const { data: business, error } = await supabase
      .from('businesses')
      .select('id, email, billing_email')
      .eq('id', businessId)
      .single();

    if (error || !business) return res.status(404).send('Business not found');

    const session = await createCheckoutSession(
      businessId,
      business.billing_email || business.email
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


// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 BookingAgent server running on port ${PORT}`);
  console.log(`📊 Environment: ${process.env.NODE_ENV}`);
  console.log(`🔗 Health check: http://localhost:${PORT}`);
  console.log('Supabase URL configured:', process.env.SUPABASE_URL ? process.env.SUPABASE_URL.substring(0, 30) + '...' : 'MISSING');
  console.log('Node version:', process.version);
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.warn('⚠️  STRIPE_WEBHOOK_SECRET is not set — webhook signature verification disabled. Set this after configuring the webhook in the Stripe dashboard.');
  }
});