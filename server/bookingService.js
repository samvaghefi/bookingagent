const { createClient } = require('@supabase/supabase-js');

// Convert "7 PM" to "19:00:00" format
function convertTo24HourTime(timeStr) {
  if (!timeStr) return null;
  
  const match = timeStr.match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i);
  if (!match) return timeStr;
  
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
    const cleanedDate = dateStr.replace(/(\d+)(?:st|nd|rd|th)/g, '$1');
    const date = new Date(cleanedDate);
    
    if (isNaN(date.getTime())) {
      console.error('Failed to parse date:', dateStr, '-> cleaned:', cleanedDate);
      return null;
    }
    
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

// Extract booking info from Vapi webhook
function extractBookingInfo(vapiData) {
  const message = vapiData.message || vapiData;
  const transcript = message.transcript || message.artifact?.transcript || '';
  const summary = message.summary || message.analysis?.summary || '';
  const customer = message.customer || {};
  
  const customerPhone = customer.number;
  
  console.log('Summary:', summary);
  
  // Extract name - comprehensive approach
  let name = null;
  
  // Pattern 1: "for their son/daughter, [Name],"
  const forChildMatch = summary.match(/for (?:their|his|her) (?:son|daughter|child),\s+([A-Z][a-z]+)/i);
  if (forChildMatch) {
    name = forChildMatch[1];
  }
  
  // Pattern 2: "[Name] called" at start
  if (!name) {
    const calledMatch = summary.match(/^([A-Z][a-z]+)\s+called/);
    if (calledMatch && !['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'The'].includes(calledMatch[1])) {
      name = calledMatch[1];
    }
  }
  
  // Pattern 3: "The user, [Name]," or "user [Name]"
  if (!name) {
    const userMatch = summary.match(/(?:The\s+)?user[,\s]+([A-Z][a-z]+)/i);
    if (userMatch && userMatch[1].toLowerCase() !== 'successfully') {
      name = userMatch[1];
    }
  }
  
  // Pattern 4: Look for any capitalized name that isn't a keyword
  if (!name) {
    const allNames = summary.match(/\b([A-Z][a-z]{2,})\b/g);
    if (allNames) {
      const excludeWords = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'The', 'Sam', 'Barbershop', 'AI', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December', 'January', 'February'];
      const validName = allNames.find(n => !excludeWords.includes(n));
      if (validName) {
        name = validName;
      }
    }
  }
  
  // Fallback: check transcript
  if (!name) {
    const transcriptPatterns = [
      /(?:my name is|I'm|call me|this is)\s+([A-Z][a-z]+)/i,
      /name'?s?\s+([A-Z][a-z]+)/i
    ];
    
    for (const pattern of transcriptPatterns) {
      const match = transcript.match(pattern);
      if (match && match[1] && match[1].toLowerCase() !== 'sarah') {
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
    const hasKidsHaircut = /kid'?s?\s+haircut|child'?s?\s+haircut|haircut\s+for\s+(?:his|her|their)\s+(?:son|daughter|child)/i.test(summary);
    const hasHaircut = !hasKidsHaircut && /\b(?:men's\s+|adult\s+)?haircut\b/i.test(summary);
    
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
  
 // Extract special requests - look for common request patterns
let specialRequests = null;

// Get the booking description (before appointment details)
const bookingPart = summary.split(/\. The appointment|The AI/i)[0];

// Pattern 1: "requesting [something]"
let match = bookingPart.match(/requesting\s+(?:a\s+)?([a-z\s]+?)(?:\.|,|$)/i);
if (match) {
  const req = match[1].trim();
  if (req.length > 2 && !req.match(/haircut|appointment|book/i)) {
    specialRequests = req;
  }
}

// Pattern 2: "with a [style]" anywhere in booking description
if (!specialRequests) {
  match = bookingPart.match(/\bwith\s+(?:a\s+)?([a-z\s]+?)(?:\s+and\s+beard|,|$)/i);
  if (match) {
    specialRequests = match[1].trim();
  }
}

// Pattern 3: Quoted text
if (!specialRequests) {
  match = bookingPart.match(/"([^"]+)"/);
  if (match) {
    specialRequests = match[1];
  }
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
  const { data, error} = await supabase
    .from('bookings')
    .insert({
      business_id: business.id,
      customer_name: bookingData.name,
      customer_phone: bookingData.customerPhone,
      service_ids: [bookingData.service],
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