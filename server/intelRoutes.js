/**
 * Intel Reports Portal — /intel
 *
 * Required environment variables:
 *   INTEL_USERNAME        — username for the /intel portal login
 *   INTEL_PASSWORD        — password for the /intel portal login
 *   INTEL_SESSION_SECRET  — a random string used to sign session cookies
 *   SUPABASE_URL          — already set in Render
 *   SUPABASE_SERVICE_ROLE_KEY — already set in Render (used here for report reads)
 */

const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();

// Supabase with service role key for reading competitor_report_log
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY
);

// ── Auth middleware ────────────────────────────────────────────────────────────
function requireIntelAuth(req, res, next) {
  if (req.session && req.session.intelAuthed) return next();
  return res.redirect('/intel/login');
}

// ── Shared styles ─────────────────────────────────────────────────────────────
const BASE_STYLES = `
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, sans-serif; background: #f8fafc; color: #111827; }
  a { text-decoration: none; }
`;

const HEADER_HTML = `
  <div style="background:#0f172a;padding:16px 32px;display:flex;justify-content:space-between;align-items:center;">
    <img src="https://bimblyai.com/assets/bimblyai-logo-primary.svg" alt="bimblyai" style="height:48px;display:block;">
    <div style="display:flex;align-items:center;gap:24px;">
      <span style="color:#f1f5f9;font-size:15px;font-weight:600;">Intel Reports</span>
      <a href="/intel/logout" style="color:#9ca3af;font-size:13px;">Logout</a>
    </div>
  </div>
`;

// ── GET /intel/login ──────────────────────────────────────────────────────────
router.get('/intel/login', (req, res) => {
  res.send(renderLoginPage());
});

// ── POST /intel/login ─────────────────────────────────────────────────────────
router.post('/intel/login', (req, res) => {
  const { username, password } = req.body || {};
  console.log('DEBUG LOGIN:', {
    envUser: (process.env.INTEL_USERNAME || '').substring(0, 3),
    envPass: (process.env.INTEL_PASSWORD || '').substring(0, 3),
    submittedUser: (username || '').substring(0, 3),
    submittedPass: (password || '').substring(0, 3),
    bodyKeys: Object.keys(req.body || {}),
    contentType: req.headers['content-type'],
    match: username.trim() === (process.env.INTEL_USERNAME || '').trim() &&
    password.trim() === (process.env.INTEL_PASSWORD || '').trim(),
  });
  if (
    username === process.env.INTEL_USERNAME &&
    password === process.env.INTEL_PASSWORD
  ) {
    req.session.intelAuthed = true;
    return res.redirect('/intel');
  }
  res.send(renderLoginPage('Invalid credentials. Try again.'));
});

// ── GET /intel/logout ─────────────────────────────────────────────────────────
router.get('/intel/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/intel/login'));
});

// ── GET /intel/report/:id ─────────────────────────────────────────────────────
router.get('/intel/report/:id', requireIntelAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('competitor_report_log')
    .select('id, run_date, report_html')
    .eq('id', req.params.id)
    .maybeSingle();

  if (error || !data) {
    return res.status(404).send('<p>Report not found.</p>');
  }

  const backBar = `<div style="background:#f8fafc;padding:8px 16px;font-size:13px;border-bottom:1px solid #e2e8f0;">
    <a href="/intel" style="color:#2563eb;">&#8592; Back to Archive</a>
  </div>`;

  if (!data.report_html) {
    return res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Report</title></head><body>
      ${backBar}
      <div style="padding:32px;font-family:system-ui,sans-serif;color:#6b7280;font-size:14px;">
        This report was generated before HTML storage was enabled.
      </div>
    </body></html>`);
  }

  // Inject the back bar before the report HTML
  const page = data.report_html.replace(
    /<body/i,
    `<body><div style="position:sticky;top:0;z-index:999;background:#f8fafc;padding:8px 16px;font-size:13px;border-bottom:1px solid #e2e8f0;"><a href="/intel" style="color:#2563eb;">&#8592; Back to Archive</a></div><div`
  ).replace(/<\/body>/i, '</div></body>');

  // If the replace didn't find <body>, just prepend the bar
  const output = page.includes('Back to Archive')
    ? page
    : backBar + data.report_html;

  res.send(output);
});

// ── GET /intel ────────────────────────────────────────────────────────────────
router.get('/intel', requireIntelAuth, async (req, res) => {
  const { data: reports, error } = await supabase
    .from('competitor_report_log')
    .select('id, run_date, changes_detected, urgent_flag, email_sent')
    .order('run_date', { ascending: false });

  if (error) {
    return res.status(500).send(`<p>Database error: ${error.message}</p>`);
  }

  const rows = (reports || []).map(r => {
    const date = new Date(r.run_date + 'T00:00:00');
    const formattedDate = date.toLocaleDateString('en-CA', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      timeZone: 'UTC',
    });

    const changesBadge = r.changes_detected > 0
      ? `<span style="background:#eff6ff;color:#2563eb;border:1px solid #bfdbfe;border-radius:999px;font-size:11px;font-weight:600;padding:2px 10px;display:inline-block;">${r.changes_detected}</span>`
      : `<span style="background:#f3f4f6;color:#6b7280;border:1px solid #e5e7eb;border-radius:999px;font-size:11px;font-weight:600;padding:2px 10px;display:inline-block;">0</span>`;

    const urgentCell = r.urgent_flag
      ? `<div><span style="background:#fee2e2;color:#dc2626;border:1px solid #fca5a5;border-radius:999px;font-size:11px;font-weight:700;padding:2px 10px;display:inline-block;margin-bottom:4px;">URGENT</span>
         <div style="font-size:12px;color:#374151;margin-top:3px;">${String(r.urgent_flag).slice(0, 60)}${r.urgent_flag.length > 60 ? '…' : ''}</div></div>`
      : `<span style="color:#9ca3af;">—</span>`;

    const rowBorder = r.urgent_flag
      ? 'border-left:3px solid #ef4444;'
      : 'border-left:3px solid transparent;';

    return `<tr style="${rowBorder}background:#fff;">
      <td style="padding:14px 16px;font-size:14px;font-weight:600;color:#111827;white-space:nowrap;">${formattedDate}</td>
      <td style="padding:14px 16px;text-align:center;">${changesBadge}</td>
      <td style="padding:14px 16px;">${urgentCell}</td>
      <td style="padding:14px 16px;">
        <a href="/intel/report/${r.id}" style="background:#0f172a;color:#fff;font-size:12px;font-weight:600;padding:6px 14px;border-radius:6px;display:inline-block;white-space:nowrap;">View Report</a>
      </td>
    </tr>`;
  }).join('');

  const emptyState = (reports || []).length === 0
    ? `<tr><td colspan="4" style="padding:40px;text-align:center;color:#9ca3af;font-size:14px;">No reports yet. Run the intel monitor to generate the first report.</td></tr>`
    : '';

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Intel Reports — bimblyai</title>
  <style>${BASE_STYLES}
    table { width: 100%; border-collapse: collapse; }
    th { background: #f9fafb; text-align: left; padding: 10px 16px; font-size: 11px; font-weight: 700; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #e5e7eb; }
    tr + tr td { border-top: 1px solid #f3f4f6; }
  </style>
</head>
<body>
  ${HEADER_HTML}
  <div style="max-width:1000px;margin:0 auto;padding:40px 24px;">
    <div style="margin-bottom:32px;">
      <h1 style="font-size:24px;font-weight:700;color:#111827;margin:0 0 8px;">Competitive Intelligence Archive</h1>
      <p style="color:#6b7280;font-size:14px;margin:0;">Daily reports on competitor activity. Click any report to read it in full.</p>
    </div>
    <div style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th style="text-align:center;">Changes</th>
            <th>Urgent Flag</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
          ${emptyState}
        </tbody>
      </table>
    </div>
  </div>
</body>
</html>`);
});

// ── Login page renderer ───────────────────────────────────────────────────────
function renderLoginPage(errorMsg) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Intel Login — bimblyai</title>
  <style>
    ${BASE_STYLES}
    .login-wrap { min-height: 100vh; display: flex; flex-direction: column; }
    .login-body { flex: 1; display: flex; align-items: center; justify-content: center; padding: 24px; }
    .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 40px; width: 100%; max-width: 400px; box-shadow: 0 4px 24px rgba(0,0,0,0.06); }
    label { display: block; font-size: 13px; font-weight: 600; color: #374151; margin-bottom: 6px; }
    input { width: 100%; padding: 10px 14px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; color: #111827; outline: none; transition: border-color 0.15s; }
    input:focus { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,0.1); }
    .field { margin-bottom: 20px; }
    .btn { width: 100%; padding: 11px; background: #0f172a; color: #fff; border: none; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; }
    .btn:hover { background: #1e293b; }
    .error { background: #fee2e2; color: #dc2626; border: 1px solid #fca5a5; border-radius: 6px; padding: 10px 14px; font-size: 13px; margin-bottom: 20px; }
    h2 { margin: 0 0 28px; font-size: 20px; font-weight: 700; color: #111827; }
  </style>
</head>
<body>
  <div class="login-wrap">
    <div style="background:#0f172a;padding:16px 32px;">
      <img src="https://bimblyai.com/assets/bimblyai-logo-primary.svg" alt="bimblyai" style="height:40px;display:block;">
    </div>
    <div class="login-body">
      <div class="card">
        <h2>Intel Portal</h2>
        ${errorMsg ? `<div class="error">${errorMsg}</div>` : ''}
        <form method="POST" action="/intel/login">
          <div class="field">
            <label for="username">Username</label>
            <input type="text" id="username" name="username" autocomplete="username" required>
          </div>
          <div class="field">
            <label for="password">Password</label>
            <input type="password" id="password" name="password" autocomplete="current-password" required>
          </div>
          <button type="submit" class="btn">Sign in</button>
        </form>
      </div>
    </div>
  </div>
</body>
</html>`;
}

module.exports = router;
