/**
 * vapiHelpers.js — Pure formatting functions for Vapi system prompt construction.
 * All functions are side-effect free and testable in isolation.
 */
'use strict';

const DAY_ORDER  = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
const DAY_LABELS = {
  monday: 'Monday', tuesday: 'Tuesday', wednesday: 'Wednesday',
  thursday: 'Thursday', friday: 'Friday', saturday: 'Saturday', sunday: 'Sunday',
};

const TIMEZONE_INFO = {
  'America/Toronto':   { label: 'Eastern Time (ET)',          location: 'Toronto, Canada'    },
  'America/New_York':  { label: 'Eastern Time (ET)',          location: 'New York, USA'       },
  'America/Vancouver': { label: 'Pacific Time (PT)',          location: 'Vancouver, Canada'   },
  'America/Edmonton':  { label: 'Mountain Time (MT)',         location: 'Edmonton, Canada'    },
  'America/Calgary':   { label: 'Mountain Time (MT)',         location: 'Calgary, Canada'     },
  'America/Winnipeg':  { label: 'Central Time (CT)',          location: 'Winnipeg, Canada'    },
  'America/Halifax':   { label: 'Atlantic Time (AT)',         location: 'Halifax, Canada'     },
  'America/St_Johns':  { label: "Newfoundland Time (NT)",     location: "St. John's, Canada"  },
};

// Convert "HH:MM" 24h to "H:MMAM/PM" (e.g. "09:00" → "9AM", "13:30" → "1:30PM")
function format12h(time24) {
  if (!time24) return '';
  const [h, m] = time24.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12  = h % 12 || 12;
  return m === 0 ? `${h12}${ampm}` : `${h12}:${String(m).padStart(2, '0')}${ampm}`;
}

// Format a business_hours object into a human-readable bullet list.
// Only days explicitly present in the object are shown (missing = not configured).
function formatBusinessHours(businessHours) {
  if (!businessHours || typeof businessHours !== 'object') return '(Hours not configured yet)';
  const lines = [];
  for (const day of DAY_ORDER) {
    const cfg = businessHours[day];
    if (!cfg) continue;
    if (cfg.closed) {
      lines.push(`- ${DAY_LABELS[day]}: Closed`);
    } else if (cfg.open && cfg.close) {
      lines.push(`- ${DAY_LABELS[day]}: ${format12h(cfg.open)} – ${format12h(cfg.close)}`);
    }
  }
  return lines.length ? lines.join('\n') : '(Hours not configured yet)';
}

// Format a services array into a human-readable bullet list.
function formatServices(services) {
  if (!Array.isArray(services) || services.length === 0) return '(No services configured yet)';
  const lines = services
    .filter(s => s && s.name)
    .map(s => {
      let line = `- ${s.name}`;
      if (s.price != null)       line += ` – $${parseFloat(s.price).toFixed(0)}`;
      if (s.duration_minutes)    line += ` (${s.duration_minutes} min)`;
      if (s.description)         line += ` — ${s.description}`;
      return line;
    });
  return lines.length ? lines.join('\n') : '(No services configured yet)';
}

// Return timezone label and location string for a given IANA timezone.
function getTimezoneInfo(timezone) {
  return TIMEZONE_INFO[timezone] || { label: timezone, location: 'Canada' };
}

// Format a team_members array into a human-readable bullet list for the Vapi prompt.
// Supports: legacy string array, object array with {name, role, calendarId}.
function formatTeamMembers(teamMembers) {
  if (!Array.isArray(teamMembers) || teamMembers.length === 0) return '(No team members configured yet)';
  const lines = teamMembers
    .map(m => typeof m === 'string' ? { name: m, role: '' } : m)
    .filter(m => m && m.name)
    .map(m => m.role ? `- ${m.name} (${m.role})` : `- ${m.name}`);
  return lines.length ? lines.join('\n') : '(No team members configured yet)';
}

module.exports = { format12h, formatBusinessHours, formatServices, getTimezoneInfo, formatTeamMembers };
