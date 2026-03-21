const { createClient } = require('@supabase/supabase-js');
const depositService = require('./depositService');
const notificationService = require('./notificationService');
const BASE_URL = process.env.BASE_URL || 'https://bookingagent-gmo2.onrender.com';

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

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.error('FATAL: SUPABASE_URL or SUPABASE_KEY is not set');
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Extract booking info from a Vapi Custom Tool call
function extractFromToolCall(toolCallArgs) {
  return {
    name: toolCallArgs.customerName,
    customerPhone: toolCallArgs.customerPhone || toolCallArgs.callbackNumber,
    service: toolCallArgs.service,
    date: toolCallArgs.appointmentDate,   // already YYYY-MM-DD
    time: toolCallArgs.appointmentTime,   // already HH:MM
    specialRequests: toolCallArgs.specialRequests || null,
    serviceCount: toolCallArgs.serviceCount || 1,
    preferredBarber: toolCallArgs.preferredBarber || null,
    isNewCustomer: toolCallArgs.isNewCustomer || false
  };
}

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
  // Validate inputs before interpolating into PostgREST filter string
  const safePhone = (typeof phoneNumber === 'string' && /^\+?[\d\s\-().]{7,20}$/.test(phoneNumber.trim()))
    ? phoneNumber.trim() : null;
  const safeAssistantId = (typeof assistantId === 'string' && /^[a-zA-Z0-9_\-]{5,60}$/.test(assistantId.trim()))
    ? assistantId.trim() : null;

  if (!safePhone && !safeAssistantId) return null;

  // Use separate .eq() queries when only one value is safe, or .or() when both are validated
  let query = supabase.from('businesses').select('*');
  if (safePhone && safeAssistantId) {
    query = query.or(`twilio_phone_number.eq.${safePhone},vapi_assistant_id.eq.${safeAssistantId}`);
  } else if (safePhone) {
    query = query.eq('twilio_phone_number', safePhone);
  } else {
    query = query.eq('vapi_assistant_id', safeAssistantId);
  }

  const { data, error } = await query.single();
  
  if (error) {
    console.error('Error finding business:', error);
    return null;
  }
  
  return data;
}

// Upsert a client record for this booking (non-blocking — failure only logs a warning)
async function upsertClient(business, bookingData) {
  if (!bookingData.customerPhone || !bookingData.name) return;
  try {
    await supabase
      .from('clients')
      .upsert(
        {
          business_id: business.id,
          phone: bookingData.customerPhone,
          name: bookingData.name,  // extractFromToolCall() maps customerName → name
          updated_at: new Date().toISOString()
        },
        {
          onConflict: 'business_id,phone',
          ignoreDuplicates: false
        }
      );
  } catch (upsertErr) {
    console.warn('⚠️  Client upsert failed (non-blocking):', upsertErr.message);
  }
}

// Save booking to database
async function saveBooking(business, bookingData, vapiCallId, depositStatus = 'none') {
  const record = {
    business_id: business.id,
    customer_name: bookingData.name,
    customer_phone: bookingData.customerPhone,
    service_ids: [bookingData.service],
    appointment_date: convertToISODate(bookingData.date),
    appointment_time: convertTo24HourTime(bookingData.time),
    special_requests: bookingData.specialRequests,
    vapi_call_id: vapiCallId,
    status: 'confirmed',
    deposit_status: depositStatus
  };

  // Include new fields only if they have values — avoids errors if columns don't exist yet
  if (bookingData.preferredBarber != null) record.preferred_barber = bookingData.preferredBarber;
  if (bookingData.isNewCustomer != null) record.is_new_customer = bookingData.isNewCustomer;
  if (bookingData.serviceCount != null) record.service_count = bookingData.serviceCount;

  const { data, error } = await supabase
    .from('bookings')
    .insert(record)
    .select()
    .single();

  if (error) {
    // If the error is about unknown columns, retry without the optional new fields
    if (error.message && error.message.includes('column')) {
      console.warn('⚠️  Optional columns not found, retrying without them:', error.message);
      delete record.preferred_barber;
      delete record.is_new_customer;
      delete record.service_count;
      const retry = await supabase.from('bookings').insert(record).select().single();
      if (retry.error) {
        console.error('Error saving booking:', retry.error);
        throw retry.error;
      }
      console.log('Booking saved successfully:', retry.data.id);
      // Upsert client record — non-blocking (failure only logs a warning)
      await upsertClient(business, bookingData);
      if (business.deposit_enabled) {
        const token = depositService.createDepositToken(retry.data);
        const depositUrl = `${BASE_URL}/deposit/${token}`;
        await notificationService.sendDepositSMS(
          bookingData.customerPhone,
          bookingData.name,
          business.name,
          business.deposit_amount / 100,
          depositUrl,
          business.twilio_phone
        );
      }
      return retry.data;
    }
    console.error('Error saving booking:', error);
    throw error;
  }

  console.log('Booking saved successfully:', data.id);
  // Upsert client record — non-blocking (failure only logs a warning)
  await upsertClient(business, bookingData);
  if (business.deposit_enabled) {
    const token = depositService.createDepositToken(data);
    const depositUrl = `${BASE_URL}/deposit/${token}`;
    await notificationService.sendDepositSMS(
      bookingData.customerPhone,
      bookingData.name,
      business.name,
      business.deposit_amount / 100,
      depositUrl,
      business.twilio_phone
    );
  }
  return data;
}

module.exports = {
  extractFromToolCall,
  extractBookingInfo,
  findBusiness,
  saveBooking
};