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
  
  // Extract name
  let name = null;
  const summaryNameMatch = summary.match(/^([A-Z][a-z]+)\s+called/);
  if (summaryNameMatch && summaryNameMatch[1].toLowerCase() !== 'customer') {
    name = summaryNameMatch[1];
  }
  
  if (!name) {
    const transcriptPatterns = [
      /(?:my name is|I'm|call me|this is)\s+([A-Za-z]+)/i,
      /name'?s?\s+([A-Za-z]+)/i
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
  
  // Extract special requests
  const fullText = summary + ' ' + transcript;
  const specialMatches = fullText.match(/(?:low fade|high fade|skin fade|taper|buzz cut|faded beard)/gi);
  const specialRequests = specialMatches ? [...new Set(specialMatches.map(s => s.toLowerCase()))].join(', ') : null;
  
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
      appointment_date: bookingData.date,
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