const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const { DateTime } = require('luxon');

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
    // Check if business has connected their calendar
    if (!business.google_access_token || !business.google_refresh_token) {
      console.log('⚠️  Business has not connected Google Calendar');
      return null;
    }
    
    // Set up OAuth client with stored tokens
    const oauth2Client = getOAuthClient();
    oauth2Client.setCredentials({
      access_token: business.google_access_token,
      refresh_token: business.google_refresh_token
    });
    
    // Initialize Calendar API
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    
// Parse date and time in Toronto timezone using Luxon
const appointmentDateTime = DateTime.fromFormat(
  `${booking.appointment_date} ${booking.appointment_time}`,
  'yyyy-MM-dd HH:mm:ss',
  { zone: 'America/Toronto' }
);

// Check if valid
if (!appointmentDateTime.isValid) {
  console.error('Invalid date/time:', appointmentDateTime.invalidReason);
  return null;
}

// Calculate end time (30 minutes later)
const endDateTime = appointmentDateTime.plus({ minutes: booking.duration_minutes || 30 });
    
    // Create event
    const event = {
      summary: `${booking.service_ids.join(' & ')} - ${booking.customer_name}`,
      description: `
Customer: ${booking.customer_name}
Phone: ${booking.customer_phone}
Service: ${booking.service_ids.join(' & ')}
Special Requests: ${booking.special_requests || 'None'}

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
          { method: 'email', minutes: 24 * 60 }, // 1 day before
          { method: 'popup', minutes: 30 }
        ]
      }
    };
    
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
    return null;
  }
}

module.exports = {
  getAuthUrl,
  getTokensFromCode,
  createCalendarEvent
};