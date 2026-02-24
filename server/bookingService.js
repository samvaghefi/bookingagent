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
  
  // Extract name
  let name = null;
  
  const nameActionMatch = summary.match(/^([A-Z][a-z]+)\s+(?:successfully|called)/);
  if (nameActionMatch) {
    const potentialName = nameActionMatch[1];
    if (!['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].includes(potentialName)) {
      name = potentialName;
    }
  }
  
  if (!name) {
    const userNameMatch = summary.match(/\b(?:the\s+)?user,?\s+([A-Z][a-z]+)/i);
    if (userNameMatch && userNameMatch[1].toLowerCase() !== 'called') {
      name = userNameMatch[1];
    }
  }
  
  if (!name) {
    const forNameMatch = summary.match(/\bfor\s+([A-Z][a-z]+)\b/);
    if (forNameMatch && forNameMatch[1].toLowerCase() !== 'sam' && !['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].includes(forNameMatch[1])) {
      name = forNameMatch[1];
    }
  }
  
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
    const hasKidsHaircut = /kid'?s?\s+haircut|child'?s?\s+haircut|haircut\s+for\s+(?:his|her)\s+(?:son|daughter|child)/i.test(summary);
    const hasHaircut = !hasKidsHaircut && /\b(?:men's\s+)?haircut\b/i.test(summary);
    
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
  
  // Extract special requests - focus on first sentence only
  let specialRequests = null;
  
  // Get just the first sentence where the booking request is described
  const firstSentence = summary.split(/\. The appointment|\.  The|The appointment/)[0];
  
  // Pattern 1: Quoted requests (highest priority)
  const quoteMatch = firstSentence.match(/requesting (?:a\s+)?"([^"]+)"/i);
  if (quoteMatch) {
    specialRequests = quoteMatch[1];
  }
  
  // Pattern 2: "haircut with a [style]"
  if (!specialRequests) {
    const withMatch = firstSentence.match(/(?:haircut|trim)\s+with\s+(?:a\s+)?([a-z\s]+?)(?:\s+for|\.|,|$)/i);
    if (withMatch) {
      const item = withMatch[1].trim();
      // Exclude if it looks like a person reference
      if (!item.match(/\b(his|her|their|my|the|sammy|bobby|johnny)\b/i)) {
        specialRequests = item;
      }
    }
  }
  
  // Pattern 3: "requesting [style]" without quotes
  if (!specialRequests) {
    const requestMatch = firstSentence.match(/requesting\s+(?:a\s+)?([a-z\s]+?)(?:\.|,|for)/i);
    if (requestMatch) {
      const item = requestMatch[1].trim();
      if (!item.match(/\b(haircut|appointment|his|her)\b/i)) {
        specialRequests = item;
      }
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
  const { data, error } = await supabase
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