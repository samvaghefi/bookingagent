const express = require('express');
const { google } = require('googleapis');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const DASHBOARD_URL = 'https://bookingagent-gmo2.onrender.com/dashboard';

function getDashboardOAuthClient() {
  const base = process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000';
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${base}/auth/dashboard/callback`
  );
}

// GET /auth/dashboard/google — initiate Google OAuth for dashboard login
router.get('/auth/dashboard/google', (req, res) => {
  const oauth2Client = getDashboardOAuthClient();
  const url = oauth2Client.generateAuthUrl({
    access_type: 'online',
    scope: [
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile'
    ],
    state: 'dashboard'
  });
  res.redirect(url);
});

// GET /auth/dashboard/callback — handle Google OAuth callback
router.get('/auth/dashboard/callback', async (req, res) => {
  const { code, state } = req.query;

  if (state !== 'dashboard') {
    return res.redirect(`${DASHBOARD_URL}/login?error=invalid_state`);
  }

  try {
    const oauth2Client = getDashboardOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Get user email from Google
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data: userInfo } = await oauth2.userinfo.get();
    const email = userInfo.email;

    if (!email) {
      return res.redirect(`${DASHBOARD_URL}/login?error=no_email`);
    }

    // Look up business by email
    const { data: business, error } = await supabase
      .from('businesses')
      .select('id, email, name, is_active')
      .eq('email', email)
      .single();

    if (error || !business) {
      console.log(`⚠️  Dashboard login attempt for unknown email: ${email}`);
      return res.redirect(`${DASHBOARD_URL}/login?error=no_account`);
    }

    // Create JWT — React app reads this from URL and stores in localStorage
    const token = jwt.sign(
      { businessId: business.id, email: business.email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    console.log(`✅ Dashboard login: ${business.name} (${email})`);
    res.redirect(`${DASHBOARD_URL}/?token=${token}`);
  } catch (err) {
    console.error('❌ Dashboard OAuth callback error:', err.message);
    res.redirect(`${DASHBOARD_URL}/login?error=auth_failed`);
  }
});

// GET /auth/dashboard/login — branded login page
router.get('/auth/dashboard/login', (req, res) => {
  const base = process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000';
  const googleAuthUrl = `${base}/auth/dashboard/google`;

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sign in — Bimbly Dashboard</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #f9fafb;
      color: #1f2937;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1rem;
    }
    .card {
      background: #fff;
      border-radius: 16px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.08);
      padding: 48px 40px;
      width: 100%;
      max-width: 400px;
      text-align: center;
    }
    h1 {
      font-size: 24px;
      font-weight: 700;
      color: #111827;
      margin-bottom: 8px;
    }
    .subtext {
      font-size: 15px;
      color: #6b7280;
      margin-bottom: 32px;
      line-height: 1.5;
    }
    .error-msg {
      background: #fef2f2;
      border: 1px solid #fecaca;
      color: #b91c1c;
      border-radius: 8px;
      padding: 10px 14px;
      font-size: 13px;
      margin-bottom: 20px;
    }
    .btn-google {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      width: 100%;
      height: 48px;
      background: #fff;
      color: #1f2937;
      border: 1.5px solid #534AB7;
      border-radius: 10px;
      font-size: 15px;
      font-weight: 600;
      text-decoration: none;
      transition: background 0.15s, box-shadow 0.15s;
    }
    .btn-google:hover {
      background: #f5f4ff;
      box-shadow: 0 2px 8px rgba(83,74,183,0.15);
    }
    .fine-print {
      font-size: 12px;
      color: #9ca3af;
      margin-top: 24px;
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <div class="card">
    <a href="https://bimblyai.com"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 340 90" width="200" height="54" style="display:block;margin:0 auto 24px;">
  <g transform="translate(8, 10)">
    <path d="M22 38 Q22 14 42 14 Q62 14 62 38 Q62 62 82 62 Q102 62 102 38 Q102 14 82 14 Q62 14 62 38 Q62 62 42 62 Q22 62 22 38Z" fill="none" stroke="#534AB7" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="42" cy="27" r="8" fill="#534AB7"/>
    <circle cx="43" cy="28" r="3.5" fill="white"/>
    <circle cx="82" cy="27" r="8" fill="#534AB7"/>
    <circle cx="83" cy="28" r="3.5" fill="white"/>
    <path d="M52 48 Q62 56 72 48" fill="none" stroke="#534AB7" stroke-width="2.5" stroke-linecap="round" opacity="0.5"/>
    <line x1="62" y1="14" x2="62" y2="3" stroke="#D85A30" stroke-width="3" stroke-linecap="round"/>
    <circle cx="62" cy="3" r="6" fill="#D85A30"/>
  </g>
  <text x="130" y="58" font-family="'Helvetica Neue', Helvetica, Arial, sans-serif" font-size="34" font-weight="700" letter-spacing="-1">
    <tspan fill="#534AB7">bimbly</tspan><tspan fill="#D85A30" font-weight="300">ai</tspan>
  </text>
</svg></a>
    <h1>Welcome back</h1>
    <p class="subtext">Sign in to your Bimbly dashboard</p>
    ${req.query.error ? `<div class="error-msg">${{
      no_account: "No account found for that email. <a href='https://bimblyai.com/contact.html'>Contact us</a> for help.",
      auth_failed: 'Authentication failed. Please try again.',
      no_email:    'Could not retrieve your email from Google. Please try again.',
      invalid_state: 'Invalid request. Please try again.'
    }[req.query.error] || 'Something went wrong. Please try again.'}</div>` : ''}
    <a href="${googleAuthUrl}" class="btn-google">
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
        <path d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" fill="#34A853"/>
        <path d="M3.964 10.707A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.707V4.961H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.039l3.007-2.332z" fill="#FBBC05"/>
        <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.961L3.964 7.293C4.672 5.166 6.656 3.58 9 3.58z" fill="#EA4335"/>
      </svg>
      Sign in with Google
    </a>
    <p class="fine-print">Only works with the email address on your Bimbly account.</p>
  </div>
</body>
</html>`);
});

// GET /auth/logout — redirect to dashboard login
router.get('/auth/logout', (req, res) => {
  res.redirect(`${DASHBOARD_URL}/login`);
});

module.exports = router;
