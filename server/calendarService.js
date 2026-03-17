const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const { DateTime } = require('luxon');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.error('FATAL: SUPABASE_URL or SUPABASE_KEY is not set');
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Create OAuth2 client
function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000'}/auth/google/callback`
  );
}

// Generate authorization URL for a business to connect their calendar
function getAuthUrl(businessId) {
  const oauth2Client = getOAuthClient();
  
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar'],
    state: businessId // Pass business ID to identify which business is connecting
  });
  
  return url;
}

// Exchange authorization code for tokens
async function getTokensFromCode(code) {
  const oauth2Client = getOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);
  return tokens;
}

// Create calendar event
async function createCalendarEvent(business, booking) {
  try {
    console.log('📅 Attempting to create calendar event for booking:', booking.id);

    // Check if business has connected their calendar
    if (!business.google_access_token || !business.google_refresh_token) {
      console.log('⚠️  Business has not connected Google Calendar — skipping calendar event');
      console.log('   Access token present:', !!business.google_access_token);
      console.log('   Refresh token present:', !!business.google_refresh_token);
      return null;
    }

    console.log('   Refresh token present: yes');
    console.log('   Access token present: yes');
    console.log('   Token expiry:', business.google_token_expiry || 'not stored');

    // Set up OAuth client with stored tokens
    const oauth2Client = getOAuthClient();
    oauth2Client.setCredentials({
      access_token: business.google_access_token,
      refresh_token: business.google_refresh_token
    });

    oauth2Client.on('tokens', async (tokens) => {
      console.log('🔄 Google token refreshed');
      if (tokens.refresh_token) {
        // Update refresh token in database
        await supabase
          .from('businesses')
          .update({
            google_access_token: tokens.access_token,
            google_token_expiry: new Date(tokens.expiry_date).toISOString()
          })
          .eq('id', business.id);
        console.log('✅ Updated tokens in database');
      }
    });

    await oauth2Client.getAccessToken();
    console.log('✅ Access token refreshed successfully');

    // Initialize Calendar API
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    // Parse date and time - database already has ISO format
    const dateTimeString = `${booking.appointment_date}T${booking.appointment_time}`;
    console.log('   Parsing date/time string:', dateTimeString);
    const appointmentDateTime = DateTime.fromISO(dateTimeString, { zone: 'America/Toronto' });

    if (!appointmentDateTime.isValid) {
      console.error('❌ Invalid date/time:', appointmentDateTime.invalidReason);
      console.error('   Attempted to parse:', dateTimeString);
      return null;
    }

    // Calculate end time
    const endDateTime = appointmentDateTime.plus({ minutes: booking.duration_minutes || 30 });

    // Create event
    const event = {
      summary: `${booking.service_ids.join(' & ')} - ${booking.customer_name}`,
      description: `
Customer: ${booking.customer_name}
Phone: ${booking.customer_phone}
Service: ${booking.service_ids.join(' & ')}
Special Requests: ${booking.special_requests || 'None'}
Preferred Barber: ${booking.preferred_barber || 'No preference'}
New Customer: ${booking.is_new_customer ? 'Yes' : 'No'}

Booked via BookingAgent
      `.trim(),
      start: {
        dateTime: appointmentDateTime.toISO(),
        timeZone: 'America/Toronto'
      },
      end: {
        dateTime: endDateTime.toISO(),
        timeZone: 'America/Toronto'
      },
      attendees: booking.customer_email ? [{ email: booking.customer_email }] : [],
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'email', minutes: 24 * 60 },
          { method: 'popup', minutes: 30 }
        ]
      }
    };

    console.log('   Event details:', JSON.stringify({
      summary: event.summary,
      start: event.start,
      end: event.end
    }, null, 2));

    const response = await calendar.events.insert({
      calendarId: 'primary',
      resource: event
    });

    console.log('📅 Calendar event created:', response.data.id);

    // Update booking with calendar event ID
    await supabase
      .from('bookings')
      .update({ google_calendar_event_id: response.data.id })
      .eq('id', booking.id);

    return response.data.id;

  } catch (error) {
    console.error('❌ Calendar error:', error.message);
    if (error.response?.data) {
      console.error('   Google API response:', JSON.stringify(error.response.data, null, 2));
    }
    if (error.message?.includes('invalid_grant') || error.message?.includes('Token has been expired')) {
      console.error('   ⚠️  Google token is expired or revoked — business needs to reconnect calendar');
    }
    return null;
  }
}

module.exports = {
  getAuthUrl,
  getTokensFromCode,
  createCalendarEvent
};