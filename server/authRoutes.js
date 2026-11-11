const express = require('express');
const { google } = require('googleapis');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { passwordError, normalizeEmail } = require('./signupValidation');
const { authHead, LOGO } = require('./authPageStyles');
const crypto = require('crypto');
const { validateSignup } = require('./signupValidation');
const { createBusiness } = require('./signupService');
const { createCheckoutSession } = require('./billingService');
const sgMail = require('@sendgrid/mail');
const { createClient } = require('@supabase/supabase-js');

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const router = express.Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const { dashboardUrl, loginUrl } = require('./appUrl');

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

// ── Sign up with Google ────────────────────────────────────────────────────
// The website form posts the plan and shop details here (a normal form
// submit, not fetch). We check them, carry them through Google inside a
// signed `state`, and bind that state to this browser with a short-lived
// cookie. The callback below creates the account from the Google name and
// email, then sends the person to Stripe checkout like the email signup.
// Reuses /auth/dashboard/callback so no new redirect URI is needed in Google.
const SITE_SIGNUP = 'https://bimblyai.com/signup';
const GSU_COOKIE  = 'bimbly_gsu';
const GSU_TTL_MS  = 15 * 60 * 1000;

function signupBounce(res, error) {
  res.clearCookie(GSU_COOKIE, { path: '/auth/dashboard/callback' });
  return res.redirect(303, `${SITE_SIGNUP}?error=${encodeURIComponent(error)}`);
}

// POST /signup/google — validate shop details, then send to Google
router.post('/signup/google', (req, res) => {
  const { errors, values } = validateSignup(req.body || {}, { method: 'google' });
  if (Object.keys(errors).length) {
    console.log('📝 Google signup rejected, invalid fields:', Object.keys(errors).join(', '));
    return signupBounce(res, 'invalid');
  }

  const nonce = crypto.randomBytes(16).toString('hex');
  const { businessName, phone, businessType, city, province, plan } = values;
  const state = 'signup.' + jwt.sign(
    { purpose: 'google-signup', nonce, shop: { businessName, phone, businessType, city, province, plan } },
    process.env.JWT_SECRET,
    { expiresIn: Math.floor(GSU_TTL_MS / 1000) }
  );

  res.cookie(GSU_COOKIE, nonce, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge:   GSU_TTL_MS,
    path:     '/auth/dashboard/callback',
  });

  const url = getDashboardOAuthClient().generateAuthUrl({
    access_type: 'online',
    scope: [
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile'
    ],
    prompt: 'select_account',
    state,
  });
  console.log(`📝 Google signup started: ${businessName} (${plan})`);
  res.redirect(303, url);
});

async function handleGoogleSignup(req, res) {
  const { code, state, error } = req.query;

  if (error) return signupBounce(res, 'google_cancelled');

  let payload;
  try {
    payload = jwt.verify(state.slice('signup.'.length), process.env.JWT_SECRET);
  } catch {
    return signupBounce(res, 'google_expired');
  }
  if (payload.purpose !== 'google-signup' || !payload.nonce || payload.nonce !== req.cookies?.[GSU_COOKIE]) {
    return signupBounce(res, 'google_expired');
  }
  res.clearCookie(GSU_COOKIE, { path: '/auth/dashboard/callback' });

  let userInfo;
  try {
    const oauth2Client = getDashboardOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    ({ data: userInfo } = await google.oauth2({ version: 'v2', auth: oauth2Client }).userinfo.get());
  } catch (err) {
    console.error('❌ Google signup token exchange failed:', err.message);
    return signupBounce(res, 'google_failed');
  }

  const email = normalizeEmail(userInfo.email);
  if (!email || userInfo.verified_email === false) {
    return signupBounce(res, 'google_no_email');
  }
  const ownerName = (userInfo.name || userInfo.given_name || email.split('@')[0]).trim();

  let business;
  try {
    business = await createBusiness({ ...payload.shop, ownerName, email, passwordHash: null });
  } catch (err) {
    if (err.isUserFacing) return signupBounce(res, 'exists');
    console.error('❌ Google signup createBusiness failed:', err.message);
    return signupBounce(res, 'google_failed');
  }

  try {
    const session = await createCheckoutSession(business.id, email, business.plan);
    console.log(`✅ Google signup: ${business.name} (${email}) → checkout`);
    return res.redirect(303, session.url);
  } catch (err) {
    console.error('❌ Google signup checkout failed for business:', business.id, err.message);
    return signupBounce(res, 'google_failed');
  }
}

// GET /auth/dashboard/callback — handle Google OAuth callback (sign in, or sign up)
router.get('/auth/dashboard/callback', async (req, res) => {
  const { code, state } = req.query;

  if (typeof state === 'string' && state.startsWith('signup.')) {
    return handleGoogleSignup(req, res);
  }

  if (state !== 'dashboard') {
    return res.redirect(loginUrl({ error: 'invalid_state' }));
  }

  try {
    const oauth2Client = getDashboardOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Get user email from Google
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data: userInfo } = await oauth2.userinfo.get();
    const email = normalizeEmail(userInfo.email);

    if (!email) {
      return res.redirect(loginUrl({ error: 'no_email' }));
    }

    // Look up business by email
    const { data: business, error } = await supabase
      .from('businesses')
      .select('id, email, name, is_active')
      .eq('email', email)
      .single();

    if (error || !business) {
      console.log(`⚠️  Dashboard login attempt for unknown email: ${email}`);
      return res.redirect(loginUrl({ error: 'no_account' }));
    }

    // Create JWT — React app reads this from URL and stores in localStorage
    const token = jwt.sign(
      { businessId: business.id, email: business.email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    console.log(`✅ Dashboard login: ${business.name} (${email})`);
    res.redirect(dashboardUrl({ token }));
  } catch (err) {
    console.error('❌ Dashboard OAuth callback error:', err.message);
    res.redirect(loginUrl({ error: 'auth_failed' }));
  }
});

// GET /auth/dashboard/login — sign-in page in the bimblyai.com style
router.get('/auth/dashboard/login', (req, res) => {
  const base = process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000';
  const googleAuthUrl = `${base}/auth/dashboard/google`;
  const error = req.query.error;

  const BANNERS = {
    no_account: `<div class="banner" role="alert">We couldn't find a Bimbly account for that Google email. <a href="https://bimblyai.com/signup">Start a free trial</a> or sign in with your email below.</div>`,
    no_email:   `<div class="banner" role="alert">Google didn't share an email address, so we couldn't sign you in. Please try again or use your email below.</div>`,
    auth_failed:`<div class="banner" role="alert">Sign in didn't work. Please try again.</div>`,
  };
  const errorBanner = BANNERS[error] || '';

  res.send(`<!DOCTYPE html>
<html lang="en-CA">
<head>
  ${authHead('Sign in | Bimbly')}
</head>
<body>
  <div class="split">
    <main class="split-main">
      <div class="split-inner">
        ${LOGO}

        <h1>Welcome back</h1>
        <p class="sub">Sign in to see today's bookings.</p>

        ${errorBanner}

        <a href="${googleAuthUrl}" class="btn btn-google">
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
            <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
            <path d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18z" fill="#34A853"/>
            <path d="M3.964 10.706c-.18-.54-.282-1.117-.282-1.706s.102-1.166.282-1.706V4.962H.957C.347 6.175 0 7.55 0 9s.348 2.825.957 4.038l3.007-2.332z" fill="#FBBC05"/>
            <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.962L3.964 7.294C4.672 5.167 6.656 3.58 9 3.58z" fill="#EA4335"/>
          </svg>
          Sign in with Google
        </a>

        <div class="or">or use your email</div>

        <form id="email-form" novalidate>
          <div class="banner form-error" id="form-error" role="alert"></div>
          <div class="field">
            <label for="email">Email</label>
            <input type="email" id="email" name="email" placeholder="you@yourshop.com" autocomplete="email" inputmode="email" required>
          </div>
          <div class="field">
            <label for="password">Password</label>
            <input type="password" id="password" name="password" autocomplete="current-password" required>
          </div>
          <div class="row-end"><a href="/auth/forgot-password-page">Forgot your password?</a></div>
          <button type="submit" id="login-btn">Sign in</button>
        </form>

        <p class="foot-link">New to Bimbly? <a href="https://bimblyai.com/signup">Start your free trial</a></p>
      </div>
    </main>

    <aside class="split-aside" aria-hidden="true">
      <p class="aside-title">Your book keeps filling while you work.</p>
      <figure class="book">
        <div class="book-head"><span class="book-day">Saturday</span><span class="book-date">An example day</span></div>
        <ol class="book-rows">
          <li class="slot"><time>9:00</time><div class="slot-body"><span class="hand">Andre, skin fade</span></div></li>
          <li class="slot slot--auto" style="--i:0"><time>10:00</time><div class="slot-body"><span class="entry"><span class="entry-text">Daniel, cut and beard</span><span class="stamp">Booked by phone, Thu 1:48pm</span></span></div></li>
          <li class="slot slot--auto" style="--i:1"><time>11:00</time><div class="slot-body"><span class="entry"><span class="entry-text">Aiden, kids cut</span><span class="stamp">Booked online, Thu 11:05pm</span></span></div></li>
          <li class="slot slot--auto" style="--i:2"><time>11:30</time><div class="slot-body"><span class="entry"><span class="entry-text">Kevin, fade with Jay</span><span class="stamp">Booked by phone, Thu 9:42pm</span></span></div></li>
          <li class="slot"><time>12:15</time><div class="slot-body"><span class="hand">Tony, cut</span></div></li>
        </ol>
      </figure>
      <p class="aside-note">Handwritten entries are yours. The stamped ones came in through Bimbly.</p>
    </aside>
  </div>

  <script>
    const DASHBOARD = ${JSON.stringify(dashboardUrl())};
    document.getElementById('email-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = document.getElementById('form-error');
      const btn   = document.getElementById('login-btn');
      const email    = document.getElementById('email').value.trim();
      const password = document.getElementById('password').value;
      const fail = (msg) => {
        errEl.textContent   = msg;
        errEl.style.display = 'block';
        btn.disabled        = false;
        btn.textContent     = 'Sign in';
      };
      errEl.style.display = 'none';
      if (!email || !password) return fail('Please enter your email and password.');

      btn.disabled = true;
      btn.textContent = 'Signing in...';
      try {
        const res  = await fetch('/auth/login', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ email, password }),
        });
        const data = await res.json();
        if (res.ok && data.token) {
          window.location.href = DASHBOARD + '?token=' + encodeURIComponent(data.token);
        } else {
          fail(data.error || 'Sign in didn\\'t work. Please try again.');
        }
      } catch {
        fail('Network error. Please check your connection and try again.');
      }
    });
  </script>
</body>
</html>`);
});

// GET /auth/logout — redirect to dashboard login
router.get('/auth/logout', (req, res) => {
  res.redirect(loginUrl());
});

// GET /auth/forgot-password-page — serve the forgot-password form
router.get('/auth/forgot-password-page', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  ${authHead('Forgot your password | Bimbly')}
</head>
<body>
  <div class="card-page"><div class="card-wrap">
  ${LOGO}
  <div class="card">
    <h1>Forgot your password?</h1>
    <p class="sub">Enter your email and we'll send you a link to reset your password.</p>
    <form id="form">
      <div class="field">
        <label for="email">Email address</label>
        <input type="email" id="email" placeholder="you@example.com" required autocomplete="email">
      </div>
      <button type="submit" id="btn">Send reset link</button>
      <div class="msg msg--success" id="ok">Check your inbox. If there's an account for that email, a reset link is on its way.</div>
      <div class="msg msg--error"   id="err"></div>
    </form>
    <a href="/auth/dashboard/login" class="back">← Back to sign in</a>
  </div>
  </div></div>
  <script>
    document.getElementById('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const ok  = document.getElementById('ok');
      const err = document.getElementById('err');
      const btn = document.getElementById('btn');
      ok.style.display  = 'none';
      err.style.display = 'none';
      btn.disabled    = true;
      btn.textContent = 'Sending...';

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
  const email = normalizeEmail(req.body.email);
  const { password } = req.body;
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
      return res.status(401).json({ error: 'This account uses Google sign-in. Use the Google button, or set a password with "Forgot your password?".' });
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
  const email = normalizeEmail(req.body.email);
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
    return res.redirect(loginUrl({ error: 'auth_failed' }));
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.purpose !== 'password-reset') {
      return res.redirect(loginUrl({ error: 'auth_failed' }));
    }
  } catch {
    return res.redirect(loginUrl({ error: 'auth_failed' }));
  }

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  ${authHead('Reset your password | Bimbly')}
</head>
<body>
  <div class="card-page"><div class="card-wrap">
  ${LOGO}
  <div class="card">
    <h1>Reset your password</h1>
    <p class="sub">Enter a new password for your Bimbly account.</p>
    <form id="form">
      <div class="field">
        <label for="password">New password</label>
        <input type="password" id="password" placeholder="Your new password" required minlength="8" aria-describedby="pwrules">
        <p id="pwrules" class="hint">At least 8 characters, with a capital letter, a number and a special character (like ! @ # $).</p>
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
  </div></div>
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
      btn.textContent = 'Resetting...';

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

  const pwErr = passwordError(password);
  if (pwErr) {
    return res.status(400).json({ error: pwErr });
  }

  try {
    const hash = await bcrypt.hash(password, 10);
    const { error } = await supabase
      .from('businesses')
      .update({ password_hash: hash })
      .eq('email', normalizeEmail(decoded.email));

    if (error) throw error;

    console.log(`🔑 Password reset for ${decoded.email}`);
    return res.json({ message: 'Password reset successfully' });
  } catch (err) {
    console.error('❌ /auth/reset-password error:', err.message);
    return res.status(500).json({ error: 'Failed to reset password' });
  }
});

module.exports = router;
