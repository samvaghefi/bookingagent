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
      return res.redirect(`/auth/dashboard/login?error=no_account`);
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

// GET /auth/dashboard/login — branded split-screen login page
router.get('/auth/dashboard/login', (req, res) => {
  const base = process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000';
  const googleAuthUrl = `${base}/auth/dashboard/google`;
  const error = req.query.error;

  const errorBanner = error ? (() => {
    if (error === 'no_account') return `
      <div class="error-banner">
        No account found for that email. Did you mean to sign up?
        <a href="https://bimblyai.com/signup" class="error-link">Start your free trial →</a>
      </div>`;
    if (error === 'auth_failed') return `
      <div class="error-banner error-banner--plain">Sign in failed. Please try again.</div>`;
    return '';
  })() : '';

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
      background: #ffffff;
      color: #1f2937;
      min-height: 100vh;
      display: flex;
    }

    /* ── Left panel ── */
    .form-panel {
      flex: 0 0 60%;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      padding: 48px 40px;
      overflow-y: auto;
    }

    .form-inner {
      width: 100%;
      max-width: 440px;
    }

    .logo-link { display: block; margin-bottom: 40px; }

    h1 {
      font-size: 32px;
      font-weight: 700;
      color: #111827;
      margin-bottom: 10px;
    }

    .subtext {
      font-size: 16px;
      color: #6b7280;
      margin-bottom: 32px;
      line-height: 1.5;
    }

    .error-banner {
      background: #fff4f1;
      border: 1.5px solid #D85A30;
      color: #b84220;
      border-radius: 10px;
      padding: 14px 18px;
      font-size: 14px;
      margin-bottom: 24px;
      line-height: 1.5;
    }

    .error-banner--plain { background: #fef2f2; border-color: #fca5a5; color: #b91c1c; }

    .error-link {
      display: block;
      margin-top: 8px;
      color: #D85A30;
      font-weight: 700;
      text-decoration: none;
    }
    .error-link:hover { text-decoration: underline; }

    .btn-google {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      width: 100%;
      height: 52px;
      background: #fff;
      color: #1f2937;
      border: 1.5px solid #534AB7;
      border-radius: 10px;
      font-size: 16px;
      font-weight: 600;
      text-decoration: none;
      transition: background 0.15s, box-shadow 0.15s, transform 0.1s;
    }
    .btn-google:hover {
      background: #f5f4ff;
      box-shadow: 0 2px 10px rgba(83,74,183,0.15);
      transform: translateY(-1px);
    }
    .btn-google:active { transform: translateY(0); }

    .divider {
      text-align: center;
      font-size: 14px;
      color: #9ca3af;
      margin: 28px 0 20px;
    }

    .signup-link {
      display: block;
      text-align: center;
      font-size: 15px;
      color: #D85A30;
      font-weight: 700;
      text-decoration: none;
      transition: opacity 0.15s;
    }
    .signup-link:hover { opacity: 0.8; }

    /* ── Right panel ── */
    .social-panel {
      flex: 0 0 40%;
      background: #1a1a2e;
      display: flex;
      flex-direction: column;
      justify-content: center;
      padding: 64px 48px;
      color: #fff;
      position: relative;
      overflow: hidden;
    }

    .social-panel::before {
      content: '';
      position: absolute;
      top: -80px; right: -80px;
      width: 300px; height: 300px;
      background: rgba(83,74,183,0.15);
      border-radius: 50%;
      pointer-events: none;
    }

    .quote-mark {
      font-size: 60px;
      line-height: 1;
      color: #D85A30;
      font-family: Georgia, serif;
      margin-bottom: 16px;
      display: block;
    }

    .pull-quote {
      font-size: 17px;
      line-height: 1.65;
      color: #e2e8f0;
      margin-bottom: 20px;
      font-style: italic;
    }

    .attribution {
      font-size: 14px;
      color: #94a3b8;
      font-weight: 600;
      margin-bottom: 36px;
    }

    .panel-divider {
      height: 1px;
      background: rgba(255,255,255,0.12);
      margin-bottom: 36px;
    }

    .stat-pills {
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin-bottom: 48px;
    }

    .stat-pill {
      background: #fff;
      color: #1a1a2e;
      border-radius: 100px;
      padding: 10px 20px;
      font-size: 14px;
      font-weight: 700;
      display: inline-flex;
      align-items: center;
      gap: 10px;
      width: fit-content;
    }

    .stat-value { font-size: 18px; font-weight: 800; color: #534AB7; }

    .panel-brand { display: flex; flex-direction: column; gap: 4px; }
    .panel-tagline { font-size: 13px; color: #64748b; margin-top: 6px; }

    /* ── Responsive ── */
    @media (max-width: 768px) {
      body { flex-direction: column; }
      .form-panel { flex: none; padding: 32px 24px; align-items: stretch; }
      .social-panel { display: none; }
      h1 { font-size: 26px; }
    }
  </style>
</head>
<body>

  <!-- Left: Login form -->
  <div class="form-panel">
    <div class="form-inner">

      <a href="https://bimblyai.com" class="logo-link">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 340 90" width="200" height="54" style="display:block;">
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
        </svg>
      </a>

      <h1>Welcome back</h1>
      <p class="subtext">Sign in to your Bimbly dashboard</p>

      ${errorBanner}

      <a href="${googleAuthUrl}" class="btn-google">
        <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
          <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
          <path d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18z" fill="#34A853"/>
          <path d="M3.964 10.706c-.18-.54-.282-1.117-.282-1.706s.102-1.166.282-1.706V4.962H.957C.347 6.175 0 7.55 0 9s.348 2.825.957 4.038l3.007-2.332z" fill="#FBBC05"/>
          <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.962L3.964 7.294C4.672 5.167 6.656 3.58 9 3.58z" fill="#EA4335"/>
        </svg>
        Sign in with Google
      </a>

      <div class="divider">Don't have an account?</div>
      <a href="https://bimblyai.com/signup" class="signup-link">Start your free 30-day trial →</a>

    </div>
  </div>

  <!-- Right: Social proof -->
  <div class="social-panel">
    <span class="quote-mark">"</span>
    <p class="pull-quote">I used to miss 8–10 calls a day mid-cut. Now every call gets answered and I get a booking notification on my phone. It paid for itself in the first week.</p>
    <p class="attribution">— Sam, Owner, Metro Cuts Toronto</p>

    <div class="panel-divider"></div>

    <div class="stat-pills">
      <div class="stat-pill"><span class="stat-value">30+</span> calls captured monthly</div>
      <div class="stat-pill"><span class="stat-value">40%</span> after-hours bookings</div>
      <div class="stat-pill"><span class="stat-value">$79/mo</span> starting price</div>
    </div>

    <div class="panel-brand">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 340 90" width="160" height="44" style="display:block;">
        <g transform="translate(8, 10)">
          <path d="M22 38 Q22 14 42 14 Q62 14 62 38 Q62 62 82 62 Q102 62 102 38 Q102 14 82 14 Q62 14 62 38 Q62 62 42 62 Q22 62 22 38Z" fill="none" stroke="#7F77DD" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/>
          <circle cx="42" cy="27" r="8" fill="#7F77DD"/>
          <circle cx="43" cy="28" r="3.5" fill="white"/>
          <circle cx="82" cy="27" r="8" fill="#7F77DD"/>
          <circle cx="83" cy="28" r="3.5" fill="white"/>
          <path d="M52 48 Q62 56 72 48" fill="none" stroke="#7F77DD" stroke-width="2.5" stroke-linecap="round" opacity="0.5"/>
          <line x1="62" y1="14" x2="62" y2="3" stroke="#F0997B" stroke-width="3" stroke-linecap="round"/>
          <circle cx="62" cy="3" r="6" fill="#F0997B"/>
        </g>
        <text x="130" y="58" font-family="'Helvetica Neue', Helvetica, Arial, sans-serif" font-size="34" font-weight="700" letter-spacing="-1">
          <tspan fill="#AFA9EC">bimbly</tspan><tspan fill="#F0997B" font-weight="300">ai</tspan>
        </text>
      </svg>
      <div class="panel-tagline">Your business, powered by AI</div>
    </div>
  </div>

</body>
</html>`);
});

// GET /auth/logout — redirect to dashboard login
router.get('/auth/logout', (req, res) => {
  res.redirect(`${DASHBOARD_URL}/login`);
});

module.exports = router;
