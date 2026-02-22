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
    
    // Parse date and time
    const appointmentDate = new Date(booking.appointment_date);
    const [hours, minutes] = booking.appointment_time.split(':');
    appointmentDate.setHours(parseInt(hours), parseInt(minutes), 0);
    
    // Calculate end time (default 30 minutes)
    const endDate = new Date(appointmentDate);
    endDate.setMinutes(endDate.getMinutes() + (booking.duration_minutes || 30));
    
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
        dateTime: appointmentDate.toISOString(),
        timeZone: 'America/Toronto'
      },
      end: {
        dateTime: endDate.toISOString(),
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