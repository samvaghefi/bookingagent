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

const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar';

// Create OAuth2 client (redirect URI is registered in Google Cloud Console)
function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000'}/auth/google/callback`
  );
}

// Consent URL. `state` identifies the shop on the way back; the dashboard
// passes a signed token ('cal.<jwt>'), the legacy admin link a business id.
// prompt=consent makes Google return a refresh token every time.
function getAuthUrl(state, { loginHint } = {}) {
  const oauth2Client = getOAuthClient();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: true,
    scope: [CALENDAR_SCOPE],
    state,
    ...(loginHint ? { login_hint: loginHint } : {}),
  });
}

// Exchange authorization code for tokens
async function getTokensFromCode(code) {
  const oauth2Client = getOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);
  return tokens;
}

// The Google account (primary calendar id is the account's email) for fresh tokens
async function getPrimaryCalendarEmail(tokens) {
  try {
    const oauth2Client = getOAuthClient();
    oauth2Client.setCredentials(tokens);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const res = await calendar.calendars.get({ calendarId: 'primary' });
    return res.data.id || null;
  } catch (err) {
    console.warn('⚠️  Could not read primary calendar id:', err.message);
    return null;
  }
}

// Revoke Bimbly's access at Google (best effort; we clear our copy regardless)
async function revokeTokens(business) {
  const token = business.google_refresh_token || business.google_access_token;
  if (!token) return;
  try {
    await getOAuthClient().revokeToken(token);
  } catch (err) {
    console.warn('⚠️  Google token revoke failed (clearing locally anyway):', err.message);
  }
}

// Authorised Calendar API client for a shop. Saves refreshed tokens.
async function getCalendarClient(business) {
  if (!business.google_access_token || !business.google_refresh_token) {
    throw new Error('Google Calendar is not connected.');
  }
  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials({
    access_token: business.google_access_token,
    refresh_token: business.google_refresh_token,
  });
  oauth2Client.on('tokens', async tokens => {
    try {
      await supabase.from('businesses').update({
        ...(tokens.access_token ? { google_access_token: tokens.access_token } : {}),
        ...(tokens.refresh_token ? { google_refresh_token: tokens.refresh_token } : {}),
        google_token_expiry: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
      }).eq('id', business.id);
    } catch (err) {
      console.warn('⚠️  Could not save refreshed Google token:', err.message);
    }
  });
  return google.calendar({ version: 'v3', auth: oauth2Client });
}

// Create calendar event for a booking in the shop's connected calendar
async function createCalendarEvent(business, booking) {
  try {
    if (!business.google_access_token || !business.google_refresh_token) {
      console.log('⚠️  Business has not connected Google Calendar — skipping calendar event');
      return null;
    }

    const calendar = await getCalendarClient(business);
    const tz = business.timezone || 'America/Toronto';

    const time = String(booking.appointment_time || '').slice(0, 5);
    const start = DateTime.fromISO(`${booking.appointment_date}T${time}`, { zone: tz });
    if (!start.isValid) {
      console.error('❌ Invalid booking date/time for calendar event:', booking.appointment_date, booking.appointment_time);
      return null;
    }
    const end = start.plus({ minutes: booking.duration_minutes || 30 });
    const services = Array.isArray(booking.service_ids) ? booking.service_ids : [booking.service_ids].filter(Boolean);

    const event = {
      summary: `${services.join(' & ') || 'Appointment'} - ${booking.customer_name}`,
      description: `
Customer: ${booking.customer_name}
Phone: ${booking.customer_phone}
Service: ${services.join(' & ')}
Special Requests: ${booking.special_requests || 'None'}
Team member: ${booking.preferred_barber || 'No preference'}
New Customer: ${booking.is_new_customer ? 'Yes' : 'No'}

Booked by Bimbly
      `.trim(),
      start: { dateTime: start.toISO(), timeZone: tz },
      end: { dateTime: end.toISO(), timeZone: tz },
      // Lets the availability check skip events Bimbly created for its own bookings
      extendedProperties: { private: { bimblyBookingId: String(booking.id) } },
      attendees: booking.customer_email ? [{ email: booking.customer_email }] : [],
      reminders: { useDefault: false, overrides: [{ method: 'email', minutes: 24 * 60 }, { method: 'popup', minutes: 30 }] },
    };

    const response = await calendar.events.insert({ calendarId: 'primary', resource: event });
    console.log('📅 Calendar event created:', response.data.id);

    await supabase
      .from('bookings')
      .update({ google_calendar_event_id: response.data.id })
      .eq('id', booking.id);

    return response.data.id;
  } catch (error) {
    console.error('❌ Calendar error:', error.message);
    if (error.message?.includes('invalid_grant') || error.message?.includes('Token has been expired')) {
      console.error('   ⚠️  Google token is expired or revoked — business needs to reconnect calendar');
    }
    return null;
  }
}

// Returns array of { start: Date, end: Date } busy intervals for a calendarId on a given date.
// Fails open — returns [] on any error so booking availability still works without a calendar.
async function getFreeBusy(business, calendarId, date, timezone) {
  if (!business.google_access_token || !business.google_refresh_token) return [];
  try {
    const calendar = await getCalendarClient(business);
    const tz = timezone || 'America/Toronto';
    const dayStart = DateTime.fromISO(date, { zone: tz }).startOf('day');
    const dayEnd = dayStart.endOf('day');
    const response = await calendar.freebusy.query({
      requestBody: { timeMin: dayStart.toISO(), timeMax: dayEnd.toISO(), items: [{ id: calendarId }] },
    });
    const busy = response.data.calendars?.[calendarId]?.busy || [];
    return busy.map(b => ({ start: new Date(b.start), end: new Date(b.end) }));
  } catch (err) {
    console.warn(`⚠️  getFreeBusy failed for calendar ${calendarId}:`, err.message);
    return [];
  }
}

module.exports = {
  getAuthUrl,
  getTokensFromCode,
  getPrimaryCalendarEmail,
  getCalendarClient,
  revokeTokens,
  createCalendarEvent,
  getFreeBusy,
};
