const express = require('express');
const { google } = require('googleapis');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const sgMail = require('@sendgrid/mail');
const { createClient } = require('@supabase/supabase-js');

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

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

    .or-divider {
      display: flex;
      align-items: center;
      gap: 12px;
      margin: 20px 0;
      color: #9ca3af;
      font-size: 13px;
    }
    .or-divider::before, .or-divider::after {
      content: '';
      flex: 1;
      height: 1px;
      background: #e5e7eb;
    }

    label { display: block; font-size: 14px; font-weight: 600; color: #374151; margin-bottom: 6px; }
    .field { margin-bottom: 16px; }
    input[type=email], input[type=password] {
      width: 100%;
      padding: 11px 14px;
      border: 1.5px solid #d1d5db;
      border-radius: 8px;
      font-size: 15px;
      outline: none;
      transition: border-color 0.15s;
      color: #111827;
    }
    input[type=email]:focus, input[type=password]:focus { border-color: #534AB7; }

    .btn-submit {
      width: 100%;
      height: 52px;
      background: #534AB7;
      color: #fff;
      border: none;
      border-radius: 10px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s, transform 0.1s;
      margin-top: 4px;
    }
    .btn-submit:hover { background: #4338b0; transform: translateY(-1px); }
    .btn-submit:active { transform: translateY(0); }

    .forgot-link {
      display: block;
      text-align: right;
      font-size: 13px;
      color: #6b7280;
      text-decoration: none;
      margin-top: -10px;
      margin-bottom: 16px;
    }
    .forgot-link:hover { color: #534AB7; }

    .btn-apple {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      width: 100%;
      height: 52px;
      background: #f3f4f6;
      color: #9ca3af;
      border: 1.5px solid #e5e7eb;
      border-radius: 10px;
      font-size: 15px;
      font-weight: 500;
      cursor: default;
      margin-top: 12px;
    }

    .form-error {
      background: #fef2f2;
      border: 1.5px solid #fca5a5;
      color: #b91c1c;
      border-radius: 8px;
      padding: 11px 14px;
      font-size: 14px;
      margin-bottom: 16px;
      display: none;
    }

    .divider {
      text-align: center;
      font-size: 14px;
      color: #9ca3af;
      margin: 24px 0 16px;
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

      <div class="or-divider">or</div>

      <form id="email-form" novalidate>
        <div class="form-error" id="form-error"></div>
        <div class="field">
          <label for="email">Email</label>
          <input type="email" id="email" name="email" placeholder="you@example.com" autocomplete="email" required>
        </div>
        <div class="field">
          <label for="password">Password</label>
          <input type="password" id="password" name="password" placeholder="Your password" autocomplete="current-password" required>
        </div>
        <a href="/auth/forgot-password-page" class="forgot-link">Forgot password?</a>
        <button type="submit" class="btn-submit" id="login-btn">Sign In</button>
      </form>

      <div class="btn-apple">
        <svg width="16" height="16" viewBox="0 0 814 1000" xmlns="http://www.w3.org/2000/svg" fill="#9ca3af">
          <path d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-164-39.5c-76 0-103.7 40.8-165.9 40.8s-105-57.8-155.5-127.4C46 411.1 0 309.2 0 208.6C0 94.7 57.3 38.7 108.2 38.7c50.9 0 81.6 33.4 154.3 33.4 70.7 0 106-38.7 162.3-38.7 66.9 0 116.5 71.9 116.5 71.9s-68.7 41.9-68.7 138.6c0 96.7 68.7 138.5 68.7 138.5z"/>
        </svg>
        Sign in with Apple — coming soon
      </div>

      <div class="divider">Don't have an account?</div>
      <a href="https://bimblyai.com/signup" class="signup-link">Start your free 30-day trial →</a>

    </div>
  </div>

  <script>
    const DASHBOARD = 'https://bookingagent-gmo2.onrender.com/dashboard';
    document.getElementById('email-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = document.getElementById('form-error');
      const btn   = document.getElementById('login-btn');
      errEl.style.display = 'none';
      btn.disabled = true;
      btn.textContent = 'Signing in…';

      const email    = document.getElementById('email').value.trim();
      const password = document.getElementById('password').value;

      try {
        const res  = await fetch('/auth/login', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ email, password }),
        });
        const data = await res.json();
        if (res.ok && data.token) {
          window.location.href = DASHBOARD + '/?token=' + data.token;
        } else {
          errEl.textContent   = data.error || 'Sign in failed. Please try again.';
          errEl.style.display = 'block';
          btn.disabled        = false;
          btn.textContent     = 'Sign In';
        }
      } catch {
        errEl.textContent   = 'Network error. Please try again.';
        errEl.style.display = 'block';
        btn.disabled        = false;
        btn.textContent     = 'Sign In';
      }
    });
  </script>

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

// GET /auth/forgot-password-page — serve the forgot-password form
router.get('/auth/forgot-password-page', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Forgot Password — Bimbly</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f9fafb; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 24px; }
    .card { background: #fff; border-radius: 16px; padding: 40px; width: 100%; max-width: 420px; box-shadow: 0 4px 24px rgba(0,0,0,0.08); }
    h1 { font-size: 24px; font-weight: 700; color: #111827; margin-bottom: 8px; }
    p.sub { font-size: 15px; color: #6b7280; margin-bottom: 28px; line-height: 1.5; }
    label { display: block; font-size: 14px; font-weight: 600; color: #374151; margin-bottom: 6px; }
    input { width: 100%; padding: 12px 14px; border: 1.5px solid #d1d5db; border-radius: 8px; font-size: 15px; outline: none; transition: border-color 0.15s; color: #111827; }
    input:focus { border-color: #534AB7; }
    .field { margin-bottom: 18px; }
    button { width: 100%; padding: 13px; background: #534AB7; color: #fff; border: none; border-radius: 10px; font-size: 16px; font-weight: 600; cursor: pointer; transition: background 0.15s; }
    button:hover { background: #4338b0; }
    .back { display: block; text-align: center; margin-top: 16px; font-size: 14px; color: #6b7280; text-decoration: none; }
    .back:hover { color: #534AB7; }
    .msg { margin-top: 16px; padding: 12px 16px; border-radius: 8px; font-size: 14px; display: none; }
    .msg--success { background: #f0fdf4; border: 1.5px solid #86efac; color: #166534; }
    .msg--error   { background: #fef2f2; border: 1.5px solid #fca5a5; color: #b91c1c; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Forgot your password?</h1>
    <p class="sub">Enter your email and we'll send you a link to reset your password.</p>
    <form id="form">
      <div class="field">
        <label for="email">Email address</label>
        <input type="email" id="email" placeholder="you@example.com" required autocomplete="email">
      </div>
      <button type="submit" id="btn">Send reset link</button>
      <div class="msg msg--success" id="ok">Check your inbox — a reset link is on its way.</div>
      <div class="msg msg--error"   id="err"></div>
    </form>
    <a href="/auth/dashboard/login" class="back">← Back to sign in</a>
  </div>
  <script>
    document.getElementById('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const ok  = document.getElementById('ok');
      const err = document.getElementById('err');
      const btn = document.getElementById('btn');
      ok.style.display  = 'none';
      err.style.display = 'none';
      btn.disabled    = true;
      btn.textContent = 'Sending…';

      try {
        const res = await fetch('/auth/forgot-password', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ email: document.getElementById('email').value.trim() }),
        });
        const data = await res.json();
        if (res.ok) {
          ok.style.display = 'block';
          document.getElementById('form').querySelector('button').style.display = 'none';
        } else {
          err.textContent   = data.error || 'Something went wrong.';
          err.style.display = 'block';
          btn.disabled      = false;
          btn.textContent   = 'Send reset link';
        }
      } catch {
        err.textContent   = 'Network error. Please try again.';
        err.style.display = 'block';
        btn.disabled      = false;
        btn.textContent   = 'Send reset link';
      }
    });
  </script>
</body>
</html>`);
});

// ── Email / password auth routes ─────────────────────────────────────────────

// POST /auth/login — email + password → JWT
router.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const { data: business, error } = await supabase
      .from('businesses')
      .select('id, email, name, password_hash, is_active')
      .eq('email', email)
      .single();

    if (error || !business) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (!business.password_hash) {
      return res.status(401).json({ error: 'No password set — please sign in with Google' });
    }

    const match = await bcrypt.compare(password, business.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign(
      { businessId: business.id, email: business.email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    console.log(`✅ Email/password login: ${business.name} (${email})`);
    return res.json({ token });
  } catch (err) {
    console.error('❌ /auth/login error:', err.message);
    return res.status(500).json({ error: 'Login failed' });
  }
});

// POST /auth/forgot-password — send reset link via email
router.post('/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  try {
    const { data: business } = await supabase
      .from('businesses')
      .select('id, email, name')
      .eq('email', email)
      .single();

    // Always return 200 to avoid email enumeration
    if (!business) {
      return res.json({ message: 'If that email exists, a reset link has been sent' });
    }

    const resetToken = jwt.sign(
      { email: business.email, purpose: 'password-reset' },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    const base = process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000';
    const resetLink = `${base}/auth/reset-password?token=${resetToken}`;

    await sgMail.send({
      to:      business.email,
      from:    { email: 'hello@bimblyai.com', name: 'Bimbly' },
      subject: 'Reset your Bimbly password',
      text:    `Hi ${business.name},\n\nClick the link below to reset your password. This link expires in 1 hour.\n\n${resetLink}\n\nIf you didn't request this, you can ignore this email.\n\n— The Bimbly Team`,
      html:    `<p>Hi ${business.name},</p><p>Click the link below to reset your password. This link expires in 1 hour.</p><p><a href="${resetLink}">Reset my password</a></p><p>If you didn't request this, you can ignore this email.</p><p>— The Bimbly Team</p>`,
    });

    console.log(`📧 Password reset email sent to ${email}`);
    return res.json({ message: 'If that email exists, a reset link has been sent' });
  } catch (err) {
    console.error('❌ /auth/forgot-password error:', err.message);
    return res.status(500).json({ error: 'Failed to send reset email' });
  }
});

// GET /auth/reset-password — serve the reset-password form page
router.get('/auth/reset-password', (req, res) => {
  const { token } = req.query;
  const base = process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000';

  // Validate token before rendering the form
  if (!token) {
    return res.redirect(`/auth/dashboard/login?error=auth_failed`);
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.purpose !== 'password-reset') {
      return res.redirect(`/auth/dashboard/login?error=auth_failed`);
    }
  } catch {
    return res.redirect(`/auth/dashboard/login?error=auth_failed`);
  }

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reset Password — Bimbly</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f9fafb; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 24px; }
    .card { background: #fff; border-radius: 16px; padding: 40px; width: 100%; max-width: 420px; box-shadow: 0 4px 24px rgba(0,0,0,0.08); }
    h1 { font-size: 24px; font-weight: 700; color: #111827; margin-bottom: 8px; }
    p.sub { font-size: 15px; color: #6b7280; margin-bottom: 28px; }
    label { display: block; font-size: 14px; font-weight: 600; color: #374151; margin-bottom: 6px; }
    input { width: 100%; padding: 12px 14px; border: 1.5px solid #d1d5db; border-radius: 8px; font-size: 15px; outline: none; transition: border-color 0.15s; }
    input:focus { border-color: #534AB7; }
    .field { margin-bottom: 18px; }
    button { width: 100%; padding: 13px; background: #534AB7; color: #fff; border: none; border-radius: 10px; font-size: 16px; font-weight: 600; cursor: pointer; transition: background 0.15s; }
    button:hover { background: #4338b0; }
    .msg { margin-top: 16px; padding: 12px 16px; border-radius: 8px; font-size: 14px; display: none; }
    .msg--success { background: #f0fdf4; border: 1.5px solid #86efac; color: #166534; }
    .msg--error   { background: #fef2f2; border: 1.5px solid #fca5a5; color: #b91c1c; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Reset your password</h1>
    <p class="sub">Enter a new password for your Bimbly account.</p>
    <form id="form">
      <div class="field">
        <label for="password">New password</label>
        <input type="password" id="password" placeholder="At least 8 characters" required minlength="8">
      </div>
      <div class="field">
        <label for="confirm">Confirm new password</label>
        <input type="password" id="confirm" placeholder="Repeat your new password" required minlength="8">
      </div>
      <button type="submit" id="btn">Reset password</button>
      <div class="msg msg--success" id="ok">Password reset! <a href="/auth/dashboard/login">Sign in →</a></div>
      <div class="msg msg--error"   id="err"></div>
    </form>
  </div>
  <script>
    document.getElementById('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = document.getElementById('password').value;
      const confirm  = document.getElementById('confirm').value;
      const ok       = document.getElementById('ok');
      const err      = document.getElementById('err');
      const btn      = document.getElementById('btn');

      ok.style.display  = 'none';
      err.style.display = 'none';

      if (password !== confirm) {
        err.textContent   = 'Passwords do not match.';
        err.style.display = 'block';
        return;
      }

      btn.disabled    = true;
      btn.textContent = 'Resetting…';

      try {
        const res = await fetch('/auth/reset-password', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ token: '${token}', password }),
        });
        const data = await res.json();
        if (res.ok) {
          ok.style.display      = 'block';
          document.getElementById('form').querySelector('button').style.display = 'none';
        } else {
          err.textContent   = data.error || 'Something went wrong.';
          err.style.display = 'block';
          btn.disabled      = false;
          btn.textContent   = 'Reset password';
        }
      } catch {
        err.textContent   = 'Network error. Please try again.';
        err.style.display = 'block';
        btn.disabled      = false;
        btn.textContent   = 'Reset password';
      }
    });
  </script>
</body>
</html>`);
});

// POST /auth/reset-password — verify reset token and update password_hash
router.post('/auth/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) {
    return res.status(400).json({ error: 'Token and new password are required' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(400).json({ error: 'Invalid or expired reset token' });
  }

  if (decoded.purpose !== 'password-reset') {
    return res.status(400).json({ error: 'Invalid reset token' });
  }

  try {
    const hash = await bcrypt.hash(password, 10);
    const { error } = await supabase
      .from('businesses')
      .update({ password_hash: hash })
      .eq('email', decoded.email);

    if (error) throw error;

    console.log(`🔑 Password reset for ${decoded.email}`);
    return res.json({ message: 'Password reset successfully' });
  } catch (err) {
    console.error('❌ /auth/reset-password error:', err.message);
    return res.status(500).json({ error: 'Failed to reset password' });
  }
});

module.exports = router;
