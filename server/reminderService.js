'use strict';

/**
 * reminderService.js — SMS appointment reminders
 *
 * sendDueReminders()       — run every hour; finds bookings in next 24h and sends reminders
 * maybeScheduleReminder()  — call after booking creation; fires immediately if < 24h away
 * isLastMinuteBooking()    — pure helper; exported for unit tests
 */

const { DateTime } = require('luxon');
const { createClient } = require('@supabase/supabase-js');
const { sendReminderSMS } = require('./notificationService');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ── isLastMinuteBooking ───────────────────────────────────────────────────────
// Returns true if the booking appointment falls within the next 24 hours.
// Pure function — testable without mocking time.
function isLastMinuteBooking(booking, timezone) {
  const tz = timezone || 'America/Toronto';
  const apptUtc = DateTime.fromISO(
    `${booking.appointment_date}T${booking.appointment_time}`,
    { zone: tz }
  ).toUTC();
  const hoursUntil = apptUtc.diff(DateTime.utc(), 'hours').hours;
  return hoursUntil > 0 && hoursUntil <= 24;
}

// ── maybeScheduleReminder ─────────────────────────────────────────────────────
// Call after creating a booking. If the appointment is < 24h away (last-minute),
// sends the reminder immediately and marks reminder_sent = true.
async function maybeScheduleReminder(business, booking) {
  if (booking.reminder_sent) return;
  if (!booking.customer_phone) return;
  if (!isLastMinuteBooking(booking, business.timezone)) return;

  const ok = await sendReminderSMS(business, booking);
  if (ok) {
    await supabase
      .from('bookings')
      .update({ reminder_sent: true })
      .eq('id', booking.id);
  }
}

// ── sendDueReminders ──────────────────────────────────────────────────────────
// Hourly job. Queries bookings on today or tomorrow (UTC) that haven't had a
// reminder sent, then filters to those within the next 24 hours in the
// business's local timezone before sending.
async function sendDueReminders() {
  const today    = DateTime.utc().toISODate();
  const tomorrow = DateTime.utc().plus({ days: 1 }).toISODate();

  const { data: bookings, error } = await supabase
    .from('bookings')
    .select('id, business_id, customer_name, customer_phone, service_ids, appointment_date, appointment_time')
    .in('appointment_date', [today, tomorrow])
    .eq('reminder_sent', false)
    .neq('status', 'cancelled')
    .not('customer_phone', 'is', null);

  if (error) {
    console.error('sendDueReminders: query error:', error.message);
    return 0;
  }
  if (!bookings?.length) return 0;

  // Batch-fetch businesses for all unique business_ids in a single query
  const businessIds = [...new Set(bookings.map(b => b.business_id))];
  const { data: businesses } = await supabase
    .from('businesses')
    .select('id, name, timezone, twilio_phone')
    .in('id', businessIds);

  const bizMap = Object.fromEntries((businesses || []).map(b => [b.id, b]));
  const now = DateTime.utc();
  let sent = 0;

  for (const booking of bookings) {
    const business = bizMap[booking.business_id];
    if (!business) continue;

    const tz = business.timezone || 'America/Toronto';
    const apptUtc = DateTime.fromISO(
      `${booking.appointment_date}T${booking.appointment_time}`,
      { zone: tz }
    ).toUTC();

    const hoursUntil = apptUtc.diff(now, 'hours').hours;
    if (hoursUntil <= 0 || hoursUntil > 24) continue;

    try {
      const ok = await sendReminderSMS(business, booking);
      if (ok) {
        await supabase
          .from('bookings')
          .update({ reminder_sent: true })
          .eq('id', booking.id);
        sent++;
      }
    } catch (err) {
      console.error(`sendDueReminders: error for booking ${booking.id}:`, err.message);
    }
  }

  if (sent > 0) console.log(`⏰ Reminders sent: ${sent}`);
  return sent;
}

module.exports = { sendDueReminders, maybeScheduleReminder, isLastMinuteBooking };
