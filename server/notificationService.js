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
Callback Number: ${booking.callback_number || booking.customer_phone}
Service: ${booking.service_ids.join(' and ')}
Service Count: ${booking.service_count || 1}
Date: ${booking.appointment_date}
Time: ${booking.appointment_time}
Special Requests: ${booking.special_requests || 'None'}
Preferred Barber: ${booking.preferred_barber || 'No preference'}
New Customer: ${booking.is_new_customer ? 'Yes' : 'No'}

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

// Send welcome email to a new business owner after checkout completes
async function sendWelcomeEmail(business) {
  const ownerName = business.owner_name || business.name;
  const text = `Hi ${ownerName},

Your 30-day free trial has started!

Here's what happens next:
1. We'll call you within 1 business day to set up your AI receptionist
2. Setup takes about 15 minutes
3. We'll configure your services, hours, and barbers
4. You forward your number and go live — same day

Questions? Reply to this email or reach us at hello@bimblyai.com

Welcome to the team,
The Bimbly Team`;

  try {
    await sgMail.send({
      to: business.email,
      from: 'hello@bimblyai.com',
      subject: 'Welcome to Bimbly Receptionist — here\'s what happens next',
      text
    });
    console.log(`📧 Welcome email sent to ${business.email}`);
    return true;
  } catch (error) {
    console.error('Welcome email error:', error);
    return false;
  }
}

// Send internal signup notification to hello@bimblyai.com
async function sendInternalSignupNotification(business) {
  const text = `New trial started:

Business: ${business.name}
Owner: ${business.owner_name || 'N/A'}
Email: ${business.email}
Phone: ${business.phone || 'N/A'}
Type: ${business.business_type || 'N/A'}
Business ID: ${business.id}

Action required: Call them within 1 business day to complete setup.`;

  try {
    await sgMail.send({
      to: 'hello@bimblyai.com',
      from: 'hello@bimblyai.com',
      subject: `New Bimbly signup: ${business.name}`,
      text
    });
    console.log(`📧 Internal signup notification sent for ${business.name}`);
    return true;
  } catch (error) {
    console.error('Internal signup notification error:', error);
    return false;
  }
}

// Send payment failure email to business owner
async function sendPaymentFailedEmail(business) {
  const emailBody = `
Hi,

Your Bimbly Receptionist payment failed and your subscription is now past due.

To keep your AI receptionist running, please update your payment method by contacting us:

Email: hello@bimblyai.com

If you don't update your payment method, your service will be paused.

— The Bimbly Team
  `;

  try {
    const msg = {
      to: business.email,
      from: business.email,
      subject: 'Action required: Bimbly payment failed',
      text: emailBody
    };
    await sgMail.send(msg);
    console.log(`📧 Payment failed email sent to ${business.email}`);
    return true;
  } catch (error) {
    console.error('Payment failed email error:', error);
    return false;
  }
}

module.exports = {
  sendCustomerSMS,
  sendOwnerEmail,
  sendWelcomeEmail,
  sendInternalSignupNotification,
  sendPaymentFailedEmail
};