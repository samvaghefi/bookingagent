const { createClient } = require('@supabase/supabase-js');

// Convert "7 PM" to "19:00:00" format
function convertTo24HourTime(timeStr) {
  if (!timeStr) return null;
  
  const match = timeStr.match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i);
  if (!match) return timeStr; // Return as-is if format not recognized
  
  let hours = parseInt(match[1]);
  const minutes = match[2] || '00';
  const period = match[3].toUpperCase();
  
  if (period === 'PM' && hours !== 12) hours += 12;
  if (period === 'AM' && hours === 12) hours = 0;
  
  return `${hours.toString().padStart(2, '0')}:${minutes}:00`;
}

// Convert "Wednesday, February 25th, 2026" to "2026-02-25" format
function convertToISODate(dateStr) {
  if (!dateStr) return null;
  
  try {
    // Parse the date string
    const date = new Date(dateStr);
    
    // Check if valid
    if (isNaN(date.getTime())) return null;
    
    // Format as YYYY-MM-DD
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    
    return `${year}-${month}-${day}`;
  } catch (error) {
    console.error('Date conversion error:', error);
    return null;
  }
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Extract booking info from Vapi webhook (reusing barbershop logic)
function extractBookingInfo(vapiData) {
  const message = vapiData.message || vapiData;
  const transcript = message.transcript || message.artifact?.transcript || '';
  const summary = message.summary || message.analysis?.summary || '';
  const customer = message.customer || {};
  
  const customerPhone = customer.number;
  
  console.log('Summary:', summary);
  
// Extract name from summary - comprehensive patterns
let name = null;

// Pattern 1: "[Name] successfully" or "[Name] called"
const nameActionMatch = summary.match(/^([A-Z][a-z]+)\s+(?:successfully|called)/);
if (nameActionMatch) {
  const potentialName = nameActionMatch[1];
  // Make sure it's not a day of the week
  if (!['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].includes(potentialName)) {
    name = potentialName;
  }
}

// Pattern 2: "The user, [Name]," or "user, [Name],"
if (!name) {
  const userNameMatch = summary.match(/\b(?:the\s+)?user,?\s+([A-Z][a-z]+)/i);
  if (userNameMatch && userNameMatch[1].toLowerCase() !== 'called') {
    name = userNameMatch[1];
  }
}

// Pattern 3: "for [Name]" 
if (!name) {
  const forNameMatch = summary.match(/\bfor\s+([A-Z][a-z]+)\b/);
  if (forNameMatch && forNameMatch[1].toLowerCase() !== 'sam' && forNameMatch[1] !== 'Thursday') {
    name = forNameMatch[1];
  }
}

// Pattern 4: Look in transcript as last resort
if (!name) {
  const transcriptPatterns = [
    /(?:my name is|I'm|call me|this is)\s+([A-Z][a-z]+)/i,
    /name'?s?\s+([A-Z][a-z]+)/i
  ];
  
  for (const pattern of transcriptPatterns) {
    const match = transcript.match(pattern);
    if (match && match[1] && 
        match[1].toLowerCase() !== 'sarah' && 
        match[1].toLowerCase() !== 'barbershop') {
      name = match[1];
      break;
    }
  }
}  
  // Extract service
  let service = 'appointment';
  
  if (/changed.*(?:to|request to)\s+(?:a\s+)?beard\s*trim/i.test(summary)) {
    service = 'beard trim';
  } else if (/changed.*(?:to|request to)\s+(?:a\s+)?(?:men's\s+)?haircut/i.test(summary)) {
    service = "men's haircut";
  } else {
    const hasBeardTrim = /\bbeard\s*trim\b/i.test(summary);
    const hasHaircut = /\b(?:men's\s+)?haircut\b/i.test(summary);
    const hasKidsHaircut = /kid'?s?\s+haircut|child'?s?\s+haircut|haircut\s+for\s+(?:his|her)\s+(?:son|daughter|child)/i.test(summary);
    
    const services = [];
    if (hasHaircut) services.push("men's haircut");
    if (hasKidsHaircut) services.push("kid's haircut");
    if (hasBeardTrim) services.push('beard trim');
    
    if (services.length > 0) {
      service = services.join(' and ');
    }
  }
  
  // Extract date
  const dateMatch = summary.match(/(?:Thursday|Friday|Saturday|Sunday|Monday|Tuesday|Wednesday),?\s+([A-Za-z]+\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})/i);
  const date = dateMatch ? dateMatch[0] : null;
  
  // Extract time
  const timeMatch = summary.match(/(\d{1,2}(?::\d{2})?\s*(?:AM|PM|am|pm))/i);
  const time = timeMatch ? timeMatch[1] : null;
  
  // Extract special requests - only from what customer actually requested
let specialRequests = null;

// Look for patterns like "requested X", "wants X", "asked for X"
const requestPatterns = [
  /(?:requested|wants|asked for|would like)\s+(?:a\s+)?([^,.]+)/gi,
  /He requested (?:a\s+)?([^,.]+)/gi,
  /She requested (?:a\s+)?([^,.]+)/gi
];

const requestedItems = [];
for (const pattern of requestPatterns) {
  const matches = summary.matchAll(pattern);
  for (const match of matches) {
    const item = match[1].trim().toLowerCase();
    // Only include if it's a known style
    if (/buzz cut|low fade|high fade|skin fade|taper|faded beard/i.test(item)) {
      requestedItems.push(item);
    }
  }
}

if (requestedItems.length > 0) {
  specialRequests = [...new Set(requestedItems)].join(', ');
}

  return {
    name,
    customerPhone,
    service,
    date,
    time,
    specialRequests
  };
}

// Find business by phone number or assistant ID
async function findBusiness(phoneNumber, assistantId) {
  const { data, error } = await supabase
    .from('businesses')
    .select('*')
    .or(`twilio_phone_number.eq.${phoneNumber},vapi_assistant_id.eq.${assistantId}`)
    .single();
  
  if (error) {
    console.error('Error finding business:', error);
    return null;
  }
  
  return data;
}

// Save booking to database
async function saveBooking(business, bookingData, vapiCallId) {
  const { data, error } = await supabase
    .from('bookings')
    .insert({
      business_id: business.id,
      customer_name: bookingData.name,
      customer_phone: bookingData.customerPhone,
      service_ids: [bookingData.service], // Array of services
      appointment_date: convertToISODate(bookingData.date),
      appointment_time: convertTo24HourTime(bookingData.time),
      special_requests: bookingData.specialRequests,
      vapi_call_id: vapiCallId,
      status: 'confirmed'
    })
    .select()
    .single();
  
  if (error) {
    console.error('Error saving booking:', error);
    throw error;
  }
  
  return data;
}

module.exports = {
  extractBookingInfo,
  findBusiness,
  saveBooking
};