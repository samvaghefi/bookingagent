require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { extractFromToolCall, extractBookingInfo, findBusiness, saveBooking } = require('./bookingService');
const { sendCustomerSMS, sendOwnerEmail } = require('./notificationService');
const { getAuthUrl, getTokensFromCode, createCalendarEvent } = require('./calendarService');



const app = express();
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

    const message = req.body.message || req.body;
    const messageType = message.type;

    // ── Type A: Custom Tool Call ──────────────────────────────────────────────
    if (messageType === 'tool-calls') {
      console.log('Tool call received: bookAppointment');

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


// Route to initiate Google Calendar connection
app.get('/connect-calendar/:businessId', (req, res) => {
  const { businessId } = req.params;
  const authUrl = getAuthUrl(businessId);
  res.redirect(authUrl);
});

// OAuth callback - Google redirects here after authorization
app.get('/auth/google/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    const businessId = state; // We passed business ID as state
    
    // Exchange code for tokens
    const tokens = await getTokensFromCode(code);
    
    // Save tokens to database
    const { error } = await supabase
      .from('businesses')
      .update({
        google_access_token: tokens.access_token,
        google_refresh_token: tokens.refresh_token,
        google_token_expiry: new Date(tokens.expiry_date)
      })
      .eq('id', businessId);
    
    if (error) throw error;
    
    res.send(`
      <html>
        <body style="font-family: Arial; padding: 40px; text-align: center;">
          <h1>✅ Calendar Connected!</h1>
          <p>Your Google Calendar has been successfully connected to BookingAgent.</p>
          <p>You can close this window.</p>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('OAuth callback error:', error);
    res.status(500).send('Error connecting calendar');
  }
});



// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 BookingAgent server running on port ${PORT}`);
  console.log(`📊 Environment: ${process.env.NODE_ENV}`);
  console.log(`🔗 Health check: http://localhost:${PORT}`);
});