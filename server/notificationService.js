const twilio = require('twilio');
const sgMail = require('@sendgrid/mail');

// Initialize Twilio
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Initialize SendGrid
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Send SMS to customer
async function sendCustomerSMS(business, booking) {
  const message = `Thanks for booking with ${business.name}! Your ${booking.service_ids.join(' and ')} is on ${booking.appointment_date} at ${booking.appointment_time}. We'll see you at ${business.address}.`;
  
  try {
    await twilioClient.messages.create({
      body: message,
      from: business.twilio_phone_number,
      to: booking.customer_phone
    });
    
    console.log(`📱 SMS sent to ${booking.customer_phone}`);
    return true;
  } catch (error) {
    console.error('SMS error:', error);
    return false;
  }
}

// Send email to business owner
async function sendOwnerEmail(business, booking) {
  const emailBody = `
New Booking at ${business.name}!

Customer: ${booking.customer_name}
Phone: ${booking.customer_phone}
Service: ${booking.service_ids.join(' and ')}
Date: ${booking.appointment_date}
Time: ${booking.appointment_time}
Special Requests: ${booking.special_requests || 'None'}

Please add this to your calendar.
  `;
  
  try {
    const msg = {
      to: business.email,
      from: business.email, // SendGrid requires verified sender
      subject: `New Booking: ${booking.customer_name} - ${booking.appointment_date}`,
      text: emailBody,
    };
    
    await sgMail.send(msg);
    console.log(`📧 Email sent to ${business.email}`);
    return true;
  } catch (error) {
    console.error('Email error:', error);
    return false;
  }
}

module.exports = {
  sendCustomerSMS,
  sendOwnerEmail
};