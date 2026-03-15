const express = require('express');
const { google } = require('googleapis');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const COOKIE_NAME = 'bimbly_session';
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

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
  const base = process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000';

  if (state !== 'dashboard') {
    return res.redirect(`${base}/dashboard/login?error=invalid_state`);
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
      return res.redirect(`${base}/dashboard/login?error=no_email`);
    }

    // Look up business by email
    const { data: business, error } = await supabase
      .from('businesses')
      .select('id, email, name, is_active')
      .eq('email', email)
      .single();

    if (error || !business) {
      console.log(`⚠️  Dashboard login attempt for unknown email: ${email}`);
      return res.redirect(`${base}/dashboard/login?error=no_account`);
    }

    // Create JWT session token
    const token = jwt.sign(
      { businessId: business.id, email: business.email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Set session cookie
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: COOKIE_MAX_AGE
    });

    console.log(`✅ Dashboard login: ${business.name} (${email})`);
    res.redirect(`${base}/dashboard`);
  } catch (err) {
    console.error('❌ Dashboard OAuth callback error:', err.message);
    const base = process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000';
    res.redirect(`${base}/dashboard/login?error=auth_failed`);
  }
});

// GET /auth/logout — clear session and redirect to login
router.get('/auth/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  const base = process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000';
  res.redirect(`${base}/dashboard/login`);
});

module.exports = router;
