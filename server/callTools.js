'use strict';

/**
 * callTools — what the AI receptionist hears back when it uses its tools.
 *
 *   checkAvailability  → which times are open (called before offering any time)
 *   bookAppointment    → re-checked here right before saving, so two callers
 *                        can't grab the same time
 *
 * Replies are plain sentences written for a voice model: they start with
 * today's date (so relative dates stay right) and say exactly which times to offer.
 */

const { DateTime } = require('luxon');
const availability = require('./availabilityService');

const { parseDate, parseTime, spokenTime, spokenDate, describeRanges, DEFAULT_TZ } = availability;

function todayLine(tz) {
  const now = DateTime.now().setZone(tz).setLocale('en-US');
  return `Today is ${now.toFormat('cccc, LLLL d, yyyy')} and it is ${now.toFormat('h:mm a')}.`;
}

function withWho(teamMember, freeMembers) {
  if (teamMember) return ` with ${teamMember}`;
  if (freeMembers && freeMembers.length === 1) return ` with ${freeMembers[0]}`;
  return '';
}

function altText(alts, tz, originalDate) {
  if (!alts.length) return 'There are no open times in the next week.';
  const sameDay = alts.every(a => a.date === originalDate);
  const times = alts.map(a => spokenTime(a.minutes));
  const list = times.length > 1 ? `${times.slice(0, -1).join(', ')} or ${times[times.length - 1]}` : times[0];
  return sameDay
    ? `The closest open times that day are ${list}.`
    : `The next open times are on ${spokenDate(alts[0].date, tz)}: ${list}.`;
}

const REASONS = {
  closed: 'the shop is closed that day',
  outside_hours: "that's outside opening hours",
  past: 'that time has already passed',
  blocked: "the shop isn't taking bookings then",
  member_busy: 'they are already booked then',
  busy: "we're fully booked then",
};

/**
 * checkAvailability tool. args: { date, time?, service?, preferredBarber? }
 * Returns the sentence the AI should use.
 */
async function handleCheckAvailability(business, args = {}) {
  const tz = business.timezone || DEFAULT_TZ;
  const head = todayLine(tz);
  const date = parseDate(args.date, tz);
  if (!date) {
    return `${head} I need the date as YYYY-MM-DD (for example ${DateTime.now().setZone(tz).plus({ days: 1 }).toISODate()}). Work out the date the caller means, then check again.`;
  }

  const members = availability.normalizeMembers(business);
  const member = availability.findMember(members, args.preferredBarber);
  const unknownMember = args.preferredBarber && !member && !['anyone', 'any', 'no preference', 'none'].includes(String(args.preferredBarber).trim().toLowerCase());
  const teamMember = member ? member.name : undefined;
  const memberNote = unknownMember
    ? ` There is no team member called "${args.preferredBarber}". The team is: ${members.map(m => m.name).join(', ') || 'just the owner'}. These times are for anyone.`
    : '';

  const when = spokenDate(date, tz);

  if (args.time) {
    const at = parseTime(args.time);
    if (at == null) return `${head} I couldn't read the time "${args.time}". Use 24-hour HH:MM, like 14:30.`;
    const r = await availability.checkSlot(business, { date, time: args.time, service: args.service, teamMember });
    if (r.available) {
      return `${head} Yes, ${spokenTime(at)} on ${when} is available${withWho(teamMember, r.freeMembers)} (${r.duration} minutes).${memberNote} You can book it.`;
    }
    const why = REASONS[r.reason] || 'it is not available';
    return `${head} ${spokenTime(at)} on ${when} is NOT available${teamMember ? ` with ${teamMember}` : ''}: ${why}. ${altText(r.alternatives, tz, date)}${memberNote} Only offer these times.`;
  }

  const day = await availability.getDayAvailability(business, date, { service: args.service, teamMember });
  if (day.closed) {
    const r = await availability.checkSlot(business, { date, time: '00:00', service: args.service, teamMember });
    return `${head} The shop is closed on ${when}. ${altText(r.alternatives, tz, date)}${memberNote} Only offer these times.`;
  }
  const ranges = describeRanges(day.slots);
  if (!ranges) {
    const r = await availability.checkSlot(business, { date, time: '23:59', service: args.service, teamMember });
    return `${head} There are no open times on ${when}${teamMember ? ` with ${teamMember}` : ''}. ${altText(r.alternatives, tz, date)}${memberNote} Only offer these times.`;
  }
  return `${head} Open start times on ${when}${teamMember ? ` with ${teamMember}` : ''} for a ${day.duration}-minute appointment: ${ranges} (every 30 minutes).${memberNote} Only offer times from this list.`;
}

/**
 * Re-check a requested booking right before saving.
 * Returns { ok: true, durationMinutes, teamMember } or { ok: false, message }.
 * Fails open: if the check itself errors, the booking goes ahead.
 */
async function checkBeforeBooking(business, { date, time, service, preferredBarber }) {
  const tz = business.timezone || DEFAULT_TZ;
  try {
    const isoDate = parseDate(date, tz);
    const at = parseTime(time);
    if (!isoDate || at == null) return { ok: true };

    const members = availability.normalizeMembers(business);
    const member = availability.findMember(members, preferredBarber);
    const r = await availability.checkSlot(business, { date: isoDate, time, service, teamMember: member ? member.name : undefined });
    if (r.available) {
      return { ok: true, durationMinutes: r.duration, teamMember: member ? member.name : null };
    }
    const why = REASONS[r.reason] || 'it is not available';
    return {
      ok: false,
      message: `NOT BOOKED. ${spokenTime(at)} on ${spokenDate(isoDate, tz)} is not available: ${why}. ${altText(r.alternatives, tz, isoDate)} Tell the caller, ask which of these times works, then call bookAppointment again with the new time.`,
    };
  } catch (err) {
    console.error('⚠️  Availability re-check failed, booking anyway:', err.message);
    return { ok: true };
  }
}

// What bookAppointment must have before anything is saved. The model sometimes
// calls the tool with no arguments; saving those created empty bookings.
const REQUIRED_BOOKING_FIELDS = [
  ['name', "the caller's name (customerName)"],
  ['customerPhone', 'their phone number (customerPhone)'],
  ['service', 'the service (service)'],
  ['date', 'the date (appointmentDate, YYYY-MM-DD)'],
  ['time', 'the time (appointmentTime, HH:MM)'],
];

// Returns null when complete, else the reply telling the model what's missing
function incompleteBookingMessage(bookingData) {
  const missing = REQUIRED_BOOKING_FIELDS
    .filter(([key]) => !bookingData[key] || !String(bookingData[key]).trim())
    .map(([, label]) => label);
  if (!missing.length) return null;
  return `NOT BOOKED. The booking was not saved because these were missing: ${missing.join(', ')}. ` +
    'If you already have them from the conversation, call bookAppointment again right away with ALL fields filled in. ' +
    "Otherwise ask the caller. Don't tell the caller they're booked until bookAppointment replies \"Booking confirmed\".";
}

module.exports = { handleCheckAvailability, checkBeforeBooking, incompleteBookingMessage };
