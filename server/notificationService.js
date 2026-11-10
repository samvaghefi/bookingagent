const twilio = require('twilio');
const sgMail = require('@sendgrid/mail');

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const FROM = { email: 'hello@bimblyai.com', name: 'Bimbly' };

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
  const memberLine = booking.preferred_barber ? ` with ${booking.preferred_barber}` : '';
  const message = `Thanks for booking with ${business.name}! Your ${services}${memberLine} is on ${booking.appointment_date} at ${booking.appointment_time}. We'll see you at ${business.address}.`;

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
      const text = `New Booking at ${business.name}!\n\nCustomer: ${booking.customer_name}\nPhone: ${booking.customer_phone}\nCallback Number: ${booking.callback_number || booking.customer_phone}\nService: ${services}\nService Count: ${booking.service_count || 1}\nDate: ${booking.appointment_date}\nTime: ${booking.appointment_time}\nSpecial Requests: ${booking.special_requests || 'None'}\nTeam Member: ${booking.preferred_barber || 'No preference'}\nNew Customer: ${booking.is_new_customer ? 'Yes' : 'No'}\n\nPlease add this to your calendar.`;
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
// Sent after checkout completes. Main job: tell the owner how to sign in
// (Google, or the email + password they chose) and link to the sign-in page.
// Styled to match bimblyai.com. Table layout + inline styles for email clients;
// PNG logo because Gmail/Outlook don't render SVG.
const SIGN_IN_URL  = 'https://bookingagent-gmo2.onrender.com/auth/dashboard/login';
const EMAIL_LOGO   = 'https://bimblyai.com/assets/bimblyai-logo-email.png';
const PLAN_PRICES  = { solo: ['Solo', 39], starter: ['Starter', 99], pro: ['Pro', 199] };

function escapeHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// "+14165550123" → "(416) 555-0123"; anything else is returned as-is
function formatNaPhone(e164) {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164 || '');
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : (e164 || '');
}

function buildWelcomeEmail(business) {
  const firstName = String(business.owner_name || '').trim().split(/\s+/)[0] || 'there';
  const shop      = business.name || 'your shop';
  const email     = business.email;
  const usesGoogle = !business.password_hash;
  const [planName, planPrice] = PLAN_PRICES[business.plan] || PLAN_PRICES.solo;
  const phone     = business.twilio_phone ? formatNaPhone(business.twilio_phone) : null;
  const trialEnd  = business.trial_ends_at
    ? new Date(business.trial_ends_at).toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Toronto' })
    : null;

  const howHtml = usesGoogle
    ? `Choose <strong>Sign in with Google</strong> and pick <strong>${escapeHtml(email)}</strong>.`
    : `Sign in with your email, <strong>${escapeHtml(email)}</strong>, and the password you created.`;
  const howText = usesGoogle
    ? `Choose "Sign in with Google" and pick ${email}.`
    : `Sign in with your email, ${email}, and the password you created.`;
  const trialHtml = trialEnd
    ? `Your 30-day free trial runs until <strong>${escapeHtml(trialEnd)}</strong>. Nothing is charged before then.`
    : `Your 30-day free trial has started. Nothing is charged for 30 days.`;
  const trialText = trialEnd
    ? `Your 30-day free trial runs until ${trialEnd}. Nothing is charged before then.`
    : `Your 30-day free trial has started. Nothing is charged for 30 days.`;

  const ink = '#2346C8', inkDeep = '#1A36A0', graphite = '#2C2D33', grey = '#575963', rule = '#D3DFEB', paper = '#FAFBF9', sheet = '#FEFEFC';
  const font = "'Atkinson Hyperlegible Next', 'Atkinson Hyperlegible', -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
  const display = "'Schibsted Grotesk', 'Helvetica Neue', Helvetica, Arial, sans-serif";

  const row = (label, value) => `
          <tr>
            <td style="padding:12px 0;border-top:1px solid ${rule};font:700 14px/1.4 ${font};color:${grey};width:42%;vertical-align:top;">${label}</td>
            <td style="padding:12px 0;border-top:1px solid ${rule};font:400 15px/1.4 ${font};color:${graphite};vertical-align:top;">${value}</td>
          </tr>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light">
  <title>Welcome to Bimbly</title>
</head>
<body style="margin:0;padding:0;background:${paper};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">Your account for ${escapeHtml(shop)} is ready. Here's how to sign in.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${paper};">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
        <tr><td style="padding:0 4px 24px;">
          <a href="https://bimblyai.com"><img src="${EMAIL_LOGO}" width="166" height="40" alt="Bimblyai" style="display:block;border:0;"></a>
        </td></tr>
        <tr><td style="background:${sheet};border:1px solid #A9BED5;border-left:4px solid ${ink};border-radius:4px 10px 10px 4px;padding:32px 28px;">

          <h1 style="margin:0 0 16px;font:800 28px/1.1 ${display};letter-spacing:-0.5px;color:${graphite};">Welcome to Bimbly, ${escapeHtml(firstName)}.</h1>
          <p style="margin:0 0 24px;font:400 16px/1.55 ${font};color:${graphite};">
            Your account for <strong>${escapeHtml(shop)}</strong> is ready. ${trialHtml}
          </p>

          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 12px;">
            <tr><td style="border-radius:6px;background:${ink};">
              <a href="${SIGN_IN_URL}" style="display:inline-block;padding:15px 28px;font:700 16px/1 ${display};color:#ffffff;text-decoration:none;border-radius:6px;">Sign in to Bimbly</a>
            </td></tr>
          </table>
          <p style="margin:0 0 28px;font:400 15px/1.5 ${font};color:${grey};">${howHtml}</p>

          <h2 style="margin:0 0 10px;font:800 18px/1.2 ${display};color:${graphite};">What to do next</h2>
          <ol style="margin:0 0 28px;padding:0 0 0 20px;font:400 15px/1.6 ${font};color:${graphite};">
            <li style="margin-bottom:6px;">Sign in using the button above.</li>
            <li style="margin-bottom:6px;">The setup wizard walks you through your services, hours and team. It takes about 15 minutes.</li>
            <li>When setup is done, Bimbly is ready to answer your calls and book appointments.</li>
          </ol>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px;">
            ${phone ? row('Your Bimbly number', `<strong style="font-size:17px;color:${inkDeep};">${escapeHtml(phone)}</strong>`) : ''}
            ${row('Your plan', `${planName}, CA$${planPrice}/month after your trial`)}
            ${row('Sign-in email', escapeHtml(email))}
          </table>
        </td></tr>
        <tr><td style="padding:24px 4px 0;font:400 14px/1.6 ${font};color:${grey};">
          Questions? Just reply to this email, or write to <a href="mailto:hello@bimblyai.com" style="color:${inkDeep};">hello@bimblyai.com</a>.
          A real person reads every message.
        </td></tr>
        <tr><td style="padding:20px 4px 0;font:400 12px/1.6 ${font};color:#8A8C95;">
          Bimbly, the AI receptionist for barbershops and salons. Made in Toronto.<br>
          You're getting this because you created a Bimbly account with ${escapeHtml(email)}.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    `Welcome to Bimbly, ${firstName}.`,
    '',
    `Your account for ${shop} is ready. ${trialText}`,
    '',
    `Sign in here: ${SIGN_IN_URL}`,
    howText,
    '',
    'What to do next:',
    '1. Sign in using the link above.',
    '2. The setup wizard walks you through your services, hours and team. It takes about 15 minutes.',
    '3. When setup is done, Bimbly is ready to answer your calls and book appointments.',
    '',
    phone ? `Your Bimbly number: ${phone}` : null,
    `Your plan: ${planName}, CA$${planPrice}/month after your trial`,
    `Sign-in email: ${email}`,
    '',
    'Questions? Reply to this email or write to hello@bimblyai.com.',
  ].filter(l => l !== null).join('\n');

  return { subject: `Welcome to Bimbly. Here's how to sign in`, html, text };
}

async function sendWelcomeEmail(business) {
  const { subject, html, text } = buildWelcomeEmail(business);
  try {
    await sgMail.send({
      to: business.email,
      from: FROM,
      replyTo: 'hello@bimblyai.com',
      subject,
      html,
      text,
    });
    console.log(`📧 Welcome email sent to ${business.email}`);
    return true;
  } catch (error) {
    const detail = error.response?.body?.errors?.map(e => e.message).join('; ');
    console.error(`Welcome email error (${error.code || 'no code'}): ${error.message}${detail ? ' | ' + detail : ''}`);
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

// ── sendQueueReadySMS ─────────────────────────────────────────────────────────
async function sendQueueReadySMS(customerPhone, customerName, businessName, fromPhone) {
  const message = `Hi ${customerName}, it's your turn at ${businessName}! Please come to the front now.`;
  try {
    await twilioClient.messages.create({
      body: message,
      from: fromPhone,
      to: customerPhone,
    });
    console.log(`📱 Queue ready SMS sent to ${customerPhone}`);
    return true;
  } catch (error) {
    console.error('Queue ready SMS error:', error);
    throw error;
  }
}

// ── sendReminderSMS ───────────────────────────────────────────────────────────
// Sends a 24-hour reminder SMS to the customer.
async function sendReminderSMS(business, booking) {
  const services = Array.isArray(booking.service_ids)
    ? booking.service_ids.join(' and ')
    : booking.service_ids || 'appointment';

  // Format HH:MM:SS → "2PM" or "2:30PM"
  const [hStr, mStr] = (booking.appointment_time || '00:00').split(':');
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  const timeFormatted = m === 0 ? `${h12}${ampm}` : `${h12}:${String(m).padStart(2, '0')}${ampm}`;

  const message = `Hi ${booking.customer_name}, just a reminder that your ${services} appointment at ${business.name} is tomorrow at ${timeFormatted}. See you then!`;

  try {
    await twilioClient.messages.create({
      body: message,
      from: business.twilio_phone,
      to: booking.customer_phone,
    });
    console.log(`⏰ Reminder SMS sent to ${booking.customer_phone}`);
    return true;
  } catch (error) {
    console.error('Reminder SMS error:', error);
    return false;
  }
}

module.exports = {
  sendCustomerSMS,
  sendOwnerEmail,
  sendWelcomeEmail,
  buildWelcomeEmail,
  sendInternalSignupNotification,
  sendPaymentFailedEmail,
  sendDepositSMS,
  sendQueueReadySMS,
  sendReminderSMS,
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
