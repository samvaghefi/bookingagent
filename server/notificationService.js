const twilio = require('twilio');
const sgMail = require('@sendgrid/mail');

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const FROM = { email: 'hello@bimblyai.com', name: 'bimblyai' };

const PLAN_LABELS = {
  solo:    'Solo (CA$39/mo)',
  starter: 'Starter (CA$99/mo)',
  pro:     'Pro (CA$199/mo)',
};
function planLabel(plan) {
  return PLAN_LABELS[plan] || PLAN_LABELS.solo;
}

// ── sendCustomerSMS ───────────────────────────────────────────────────────────
async function sendCustomerSMS(business, booking) {
  const services = Array.isArray(booking.service_ids)
    ? booking.service_ids.join(' and ')
    : booking.service_ids || 'your appointment';
  const message = `Thanks for booking with ${business.name}! Your ${services} is on ${booking.appointment_date} at ${booking.appointment_time}. We'll see you at ${business.address}.`;

  try {
    await twilioClient.messages.create({
      body: message,
      from: business.twilio_phone,   // fixed: was twilio_phone_number
      to: booking.customer_phone,
    });
    console.log(`📱 SMS sent to ${booking.customer_phone}`);
    return true;
  } catch (error) {
    console.error('SMS error:', error);
    return false;
  }
}

// ── sendOwnerEmail ────────────────────────────────────────────────────────────
// Overloaded:
//   sendOwnerEmail(business, booking)          — new booking notification
//   sendOwnerEmail(business, subject, text)    — admin/system alert
async function sendOwnerEmail(business, bookingOrSubject, alertText) {
  try {
    let msg;

    if (typeof bookingOrSubject === 'string') {
      // Admin alert mode
      msg = {
        to: 'hello@bimblyai.com',
        from: FROM,
        subject: bookingOrSubject,
        text: alertText || '',
      };
    } else {
      // Booking notification mode
      const booking = bookingOrSubject;
      const services = Array.isArray(booking.service_ids)
        ? booking.service_ids.join(' and ')
        : booking.service_ids || '';
      const text = `New Booking at ${business.name}!\n\nCustomer: ${booking.customer_name}\nPhone: ${booking.customer_phone}\nCallback Number: ${booking.callback_number || booking.customer_phone}\nService: ${services}\nService Count: ${booking.service_count || 1}\nDate: ${booking.appointment_date}\nTime: ${booking.appointment_time}\nSpecial Requests: ${booking.special_requests || 'None'}\nPreferred Barber: ${booking.preferred_barber || 'No preference'}\nNew Customer: ${booking.is_new_customer ? 'Yes' : 'No'}\n\nPlease add this to your calendar.`;
      msg = {
        to: business.email,
        from: FROM,
        subject: `New Booking: ${booking.customer_name} - ${booking.appointment_date}`,
        text,
      };
    }

    await sgMail.send(msg);
    console.log(`📧 Owner email sent`);
    return true;
  } catch (error) {
    console.error('Owner email error:', error);
    return false;
  }
}

// ── sendWelcomeEmail ──────────────────────────────────────────────────────────
// HTML welcome email sent after checkout completes.
// Includes provisioned Twilio phone number and dashboard link.
async function sendWelcomeEmail(business) {
  const ownerName  = business.owner_name || business.name;
  const label      = planLabel(business.plan);
  const phone      = business.twilio_phone || '(being provisioned)';
  const dashUrl    = 'https://bookingagent-gmo2.onrender.com/dashboard';

  // Format trial end date if available
  let trialNote = 'Your 30-day free trial has started.';
  if (business.trial_ends_at) {
    const trialEnd = new Date(business.trial_ends_at).toLocaleDateString('en-CA', {
      year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Toronto',
    });
    trialNote = `Your 30-day free trial has started. No charges until <strong>${trialEnd}</strong>.`;
  }

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:system-ui,-apple-system,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:24px 16px;">

    <!-- Header -->
    <div style="background:#0f172a;border-radius:8px 8px 0 0;padding:20px 28px;display:flex;justify-content:space-between;align-items:center;">
      <img src="https://bimblyai.com/assets/bimblyai-logo-primary.svg" alt="bimblyai" style="height:40px;display:block;">
    </div>

    <!-- Body -->
    <div style="background:#ffffff;border-radius:0 0 8px 8px;padding:32px 28px;box-shadow:0 1px 3px rgba(0,0,0,0.08);">

      <p style="font-size:16px;color:#111827;margin:0 0 20px;">Hi ${ownerName},</p>

      <p style="font-size:14px;color:#374151;line-height:1.6;margin:0 0 24px;">
        Your AI receptionist is live. Here's everything you need to get started.
      </p>

      <!-- Phone number box -->
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:20px 24px;margin-bottom:24px;">
        <div style="font-size:11px;font-weight:700;color:#16a34a;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px;">Your AI Receptionist Number</div>
        <div style="font-size:28px;font-weight:700;color:#111827;letter-spacing:0.02em;margin-bottom:10px;">${phone}</div>
        <div style="font-size:13px;color:#374151;line-height:1.5;">
          Forward your existing business number to this number to activate your AI receptionist.
          Every unanswered call will be handled by your AI — 24/7.
        </div>
      </div>

      <!-- Plan -->
      <div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:16px 20px;margin-bottom:24px;">
        <div style="font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">Your Plan</div>
        <div style="font-size:15px;font-weight:600;color:#111827;">${label}</div>
        <div style="font-size:13px;color:#6b7280;margin-top:4px;">${trialNote}</div>
      </div>

      <!-- Next steps -->
      <div style="margin-bottom:24px;">
        <div style="font-size:13px;font-weight:700;color:#111827;margin-bottom:10px;">Next steps</div>
        <div style="font-size:13px;color:#374151;line-height:1.8;">
          1. Log into your <a href="${dashUrl}" style="color:#2563eb;text-decoration:none;font-weight:600;">dashboard</a> to review your setup<br>
          2. Confirm your services, hours, and team in Settings<br>
          3. Forward your business number to ${phone}<br>
          4. Test it — call your number and book a test appointment
        </div>
      </div>

      <!-- Dashboard link -->
      <div style="text-align:center;margin-bottom:28px;">
        <a href="${dashUrl}" style="background:#0f172a;color:#ffffff;font-size:14px;font-weight:600;padding:12px 28px;border-radius:6px;display:inline-block;text-decoration:none;">
          Open Dashboard
        </a>
      </div>

      <p style="font-size:13px;color:#6b7280;line-height:1.6;margin:0;">
        Questions? Reply to this email or reach us at
        <a href="mailto:hello@bimblyai.com" style="color:#2563eb;text-decoration:none;">hello@bimblyai.com</a>
      </p>
    </div>

    <!-- Footer -->
    <div style="text-align:center;padding:16px;font-size:11px;color:#9ca3af;">
      bimblyai &middot; Every call answered. Every booking captured.
    </div>
  </div>
</body>
</html>`;

  try {
    await sgMail.send({
      to: business.email,
      from: FROM,
      subject: 'Welcome to bimblyai — your AI receptionist is ready',
      html,
      text: `Hi ${ownerName},\n\nYour AI receptionist number is: ${phone}\n\nForward your existing business number to this number to go live.\n\nDashboard: ${dashUrl}\n\nQuestions? hello@bimblyai.com`,
    });
    console.log(`📧 Welcome email sent to ${business.email}`);
    return true;
  } catch (error) {
    console.error('Welcome email error:', error);
    return false;
  }
}

// ── sendInternalSignupNotification ────────────────────────────────────────────
async function sendInternalSignupNotification(business) {
  const label = planLabel(business.plan);
  const text = `New trial started:\n\nBusiness: ${business.name}\nOwner: ${business.owner_name || 'N/A'}\nEmail: ${business.email}\nPhone: ${business.phone || 'N/A'}\nTwilio Number: ${business.twilio_phone || 'N/A'}\nVapi Assistant: ${business.vapi_assistant_id || 'N/A'}\nType: ${business.business_type || 'N/A'}\nPlan: ${label}\nBusiness ID: ${business.id}\n\nAction required: Verify setup looks correct in Render logs.`;

  try {
    await sgMail.send({
      to: 'hello@bimblyai.com',
      from: FROM,
      subject: `New bimblyai signup: ${business.name}`,
      text,
    });
    console.log(`📧 Internal signup notification sent for ${business.name}`);
    return true;
  } catch (error) {
    console.error('Internal signup notification error:', error);
    return false;
  }
}

// ── sendPaymentFailedEmail ────────────────────────────────────────────────────
async function sendPaymentFailedEmail(business) {
  const text = `Hi,\n\nYour bimblyai payment failed and your subscription is now past due.\n\nTo keep your AI receptionist running, please update your payment method:\n\nEmail: hello@bimblyai.com\n\nIf you don't update within 7 days, your service will be paused.\n\n— The bimblyai Team`;

  try {
    await sgMail.send({
      to: business.email,
      from: FROM,
      subject: 'Action required: bimblyai payment failed',
      text,
    });
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
  sendPaymentFailedEmail,
};
