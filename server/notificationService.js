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
          This is your AI receptionist number. Log into your dashboard to complete setup and go live.
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
          1. Log into your <a href="${dashUrl}" style="color:#2563eb;text-decoration:none;font-weight:600;">dashboard</a> to complete your setup<br>
          2. The setup wizard will walk you through your services, hours, and team<br>
          3. Once setup is complete your AI receptionist will be ready to take calls
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
      text: `Hi ${ownerName},\n\nYour AI receptionist number is: ${phone}\n\nLog into your dashboard to complete setup and go live: ${dashUrl}\n\nQuestions? hello@bimblyai.com`,
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
  const label     = planLabel(business.plan);
  const dashUrl   = 'https://bookingagent-gmo2.onrender.com/dashboard';
  const timestamp = new Date().toLocaleString('en-CA', { timeZone: 'America/Toronto', dateStyle: 'medium', timeStyle: 'short' });

  const row = (label, value, highlight = false) => `
    <tr>
      <td style="padding:8px 12px;font-size:13px;color:#6b7280;width:160px;vertical-align:top;">${label}</td>
      <td style="padding:8px 12px;font-size:13px;color:${highlight ? '#0f172a' : '#111827'};font-weight:${highlight ? '700' : '400'};word-break:break-all;">${value || '<span style="color:#9ca3af;">N/A</span>'}</td>
    </tr>`;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:system-ui,-apple-system,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:24px 16px;">

    <!-- Header -->
    <div style="background:#0f172a;border-radius:8px 8px 0 0;padding:18px 24px;">
      <img src="https://bimblyai.com/assets/bimblyai-logo-primary.svg" alt="bimblyai" style="height:36px;display:block;">
    </div>

    <!-- Title bar -->
    <div style="background:#1e293b;padding:12px 24px;">
      <span style="font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.08em;">New Signup Alert</span>
    </div>

    <!-- Card -->
    <div style="background:#ffffff;border-radius:0 0 8px 8px;padding:0 0 8px;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
      <table style="width:100%;border-collapse:collapse;">
        <tbody>
          ${row('Business name', `<strong>${business.name}</strong>`, true)}
          <tr><td colspan="2" style="padding:0 12px;"><hr style="border:none;border-top:1px solid #f1f5f9;margin:0;"></td></tr>
          ${row('Owner name', business.owner_name)}
          ${row('Email', business.email)}
          ${row('Phone', business.phone)}
          <tr><td colspan="2" style="padding:0 12px;"><hr style="border:none;border-top:1px solid #f1f5f9;margin:0;"></td></tr>
          ${row('Twilio number', `<span style="font-family:monospace;font-size:14px;">${business.twilio_phone || ''}</span>`)}
          ${row('Vapi assistant ID', `<span style="font-family:monospace;font-size:12px;">${business.vapi_assistant_id || ''}</span>`)}
          <tr><td colspan="2" style="padding:0 12px;"><hr style="border:none;border-top:1px solid #f1f5f9;margin:0;"></td></tr>
          ${row('Business type', business.business_type)}
          ${row('Plan', `<span style="background:#dbeafe;color:#1d4ed8;font-size:12px;font-weight:600;padding:2px 8px;border-radius:4px;">${label}</span>`)}
          ${row('Business ID', `<span style="font-family:monospace;font-size:12px;color:#6b7280;">${business.id}</span>`)}
          ${row('Timestamp', timestamp)}
        </tbody>
      </table>

      <!-- Actions -->
      <div style="padding:16px 24px 8px;border-top:1px solid #f1f5f9;margin-top:8px;">
        <a href="${dashUrl}" style="background:#0f172a;color:#ffffff;font-size:13px;font-weight:600;padding:9px 20px;border-radius:6px;display:inline-block;text-decoration:none;margin-right:10px;">Open Dashboard</a>
      </div>
    </div>

    <div style="text-align:center;padding:16px;font-size:11px;color:#94a3b8;">
      bimblyai internal &middot; ${timestamp}
    </div>
  </div>
</body>
</html>`;

  const subject = `🆕 New bimblyai signup — ${business.name} (${label})`;
  const text = `New signup:\n\nBusiness: ${business.name}\nOwner: ${business.owner_name || 'N/A'}\nEmail: ${business.email}\nPhone: ${business.phone || 'N/A'}\nTwilio: ${business.twilio_phone || 'N/A'}\nVapi: ${business.vapi_assistant_id || 'N/A'}\nType: ${business.business_type || 'N/A'}\nPlan: ${label}\nID: ${business.id}`;

  try {
    await sgMail.send({
      to: 'vaghefi@gmail.com',
      from: FROM,
      subject,
      html,
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
  sendDepositSMS,
};

// ── sendDepositSMS ────────────────────────────────────────────────────────────
async function sendDepositSMS(customerPhone, customerName, businessName, depositAmountDollars, depositUrl, fromPhone) {
  const message = `Hi ${customerName}, your ${businessName} appointment is confirmed!\nTo secure your spot with a $${depositAmountDollars} deposit, tap: ${depositUrl}\n(Only charged if you miss your appointment.)`;
  try {
    await twilioClient.messages.create({
      body: message,
      from: fromPhone,
      to: customerPhone,
    });
    console.log(`📱 Deposit SMS sent to ${customerPhone}`);
    return true;
  } catch (error) {
    console.error('Deposit SMS error:', error);
    return false;
  }
}
