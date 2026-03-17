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
    envUser: (process.env.INTEL_USERNAME || '').trim().substring(0, 6),
    envPass: (process.env.INTEL_PASSWORD || '').trim().substring(0, 6),
    envPassLength: (process.env.INTEL_PASSWORD || '').trim().length,
    submittedUser: (username || '').trim().substring(0, 6),
    submittedPass: (password || '').trim().substring(0, 6),
    submittedPassLength: (password || '').trim().length,
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
  const sort    = req.query.sort === 'asc' ? 'asc' : 'desc';
  const fromDate = req.query.from || '';
  const toDate   = req.query.to   || '';
  const deleted  = parseInt(req.query.deleted, 10) || 0;

  // Build query
  let query = supabase
    .from('competitor_report_log')
    .select('id, run_date, changes_detected, urgent_flag, email_sent')
    .order('run_date', { ascending: sort === 'asc' });

  if (fromDate) query = query.gte('run_date', fromDate);
  if (toDate)   query = query.lte('run_date', toDate);

  const { data: reports, error } = await query;

  if (error) {
    return res.status(500).send(`<p>Database error: ${error.message}</p>`);
  }

  // Helper: build URL preserving current params but overriding some
  function buildUrl(overrides) {
    const params = new URLSearchParams();
    const merged = { sort, from: fromDate, to: toDate, ...overrides };
    if (merged.sort && merged.sort !== 'desc') params.set('sort', merged.sort);
    if (merged.from) params.set('from', merged.from);
    if (merged.to)   params.set('to',   merged.to);
    const qs = params.toString();
    return '/intel' + (qs ? '?' + qs : '');
  }

  // Sort toggle URL: flips sort, keeps filter
  const toggleSort  = sort === 'desc' ? 'asc' : 'desc';
  const sortArrow   = sort === 'desc' ? '↓' : '↑';
  const sortLabel   = sort === 'desc' ? 'Newest first' : 'Oldest first';
  const sortToggleUrl = buildUrl({ sort: toggleSort });

  // Clear filter URL: keeps sort, clears dates
  const clearFilterUrl = buildUrl({ from: '', to: '' });

  // Delete form action — preserve sort+filter in redirect
  const deleteRedirectBase = buildUrl({});

  // Banners
  const deleteBanner = deleted > 0
    ? `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:10px 16px;margin-bottom:16px;font-size:13px;color:#15803d;font-weight:500;">
        ✓ ${deleted} report${deleted !== 1 ? 's' : ''} successfully deleted.
       </div>`
    : '';

  const filterBanner = (fromDate || toDate)
    ? `<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;padding:10px 16px;margin-bottom:16px;font-size:13px;color:#1d4ed8;">
        Showing reports${fromDate ? ` from <strong>${fromDate}</strong>` : ''}${toDate ? ` to <strong>${toDate}</strong>` : ''}.
        <a href="${clearFilterUrl}" style="margin-left:12px;color:#2563eb;font-weight:600;">Clear filter</a>
       </div>`
    : '';

  // Table rows
  const INPUT_STYLE = 'padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;color:#111827;background:#fff;';

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
         <div style="font-size:12px;color:#374151;margin-top:3px;">${String(r.urgent_flag).slice(0, 60)}${String(r.urgent_flag).length > 60 ? '…' : ''}</div></div>`
      : `<span style="color:#9ca3af;">—</span>`;

    const rowBorder = r.urgent_flag ? 'border-left:3px solid #ef4444;' : 'border-left:3px solid transparent;';

    return `<tr style="${rowBorder}background:#fff;" data-id="${r.id}">
      <td style="padding:12px 10px 12px 14px;width:32px;"><input type="checkbox" name="ids" value="${r.id}" class="row-cb" style="width:15px;height:15px;cursor:pointer;accent-color:#0f172a;" onchange="updateDeleteBtn()"></td>
      <td style="padding:12px 16px;font-size:14px;font-weight:600;color:#111827;white-space:nowrap;">${formattedDate}</td>
      <td style="padding:12px 16px;text-align:center;">${changesBadge}</td>
      <td style="padding:12px 16px;">${urgentCell}</td>
      <td style="padding:12px 16px;white-space:nowrap;">
        <a href="/intel/report/${r.id}" style="background:#0f172a;color:#fff;font-size:12px;font-weight:600;padding:6px 14px;border-radius:6px;display:inline-block;">View Report</a>
      </td>
    </tr>`;
  }).join('');

  const emptyState = (reports || []).length === 0
    ? `<tr><td colspan="5" style="padding:40px;text-align:center;color:#9ca3af;font-size:14px;">No reports found.</td></tr>`
    : '';

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Intel Reports — bimblyai</title>
  <style>
    ${BASE_STYLES}
    table { width: 100%; border-collapse: collapse; }
    th { background: #f9fafb; text-align: left; padding: 10px 16px; font-size: 11px; font-weight: 700; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #e5e7eb; }
    tr + tr td { border-top: 1px solid #f3f4f6; }
    input[type="date"] { ${INPUT_STYLE} }
  </style>
</head>
<body>
  ${HEADER_HTML}
  <div style="max-width:1100px;margin:0 auto;padding:40px 24px;">

    <div style="margin-bottom:24px;">
      <h1 style="font-size:24px;font-weight:700;color:#111827;margin:0 0 6px;">Competitive Intelligence Archive</h1>
      <p style="color:#6b7280;font-size:14px;margin:0;">Daily reports on competitor activity. Click any report to read it in full.</p>
    </div>

    ${deleteBanner}
    ${filterBanner}

    <!-- Filter bar -->
    <form method="GET" action="/intel" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:16px;background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px;">
      <input type="hidden" name="sort" value="${sort}">
      <label style="font-size:13px;font-weight:600;color:#374151;white-space:nowrap;">From</label>
      <input type="date" name="from" value="${fromDate}" style="${INPUT_STYLE}">
      <label style="font-size:13px;font-weight:600;color:#374151;white-space:nowrap;">To</label>
      <input type="date" name="to" value="${toDate}" style="${INPUT_STYLE}">
      <button type="submit" style="background:#0f172a;color:#fff;font-size:13px;font-weight:600;padding:8px 18px;border:none;border-radius:6px;cursor:pointer;">Filter</button>
      <a href="${clearFilterUrl}" style="font-size:13px;color:#6b7280;text-decoration:none;margin-left:4px;">Clear</a>
    </form>

    <!-- Toolbar: delete button (hidden until checkbox checked) -->
    <div style="display:flex;justify-content:flex-end;margin-bottom:10px;min-height:34px;">
      <form id="delete-form" method="POST" action="/intel/delete">
        <input type="hidden" name="_redirectBase" value="${deleteRedirectBase}">
        <div id="delete-btn-wrap" style="display:none;">
          <button type="submit" onclick="return confirm('Delete selected reports? This cannot be undone.')"
            style="background:#dc2626;color:#fff;font-size:13px;font-weight:600;padding:7px 16px;border:none;border-radius:6px;cursor:pointer;">
            Delete Selected
          </button>
        </div>
      </form>
    </div>

    <!-- Table (inside the same delete form via JS — checkboxes submit with the form above) -->
    <div style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
      <table id="reports-table">
        <thead>
          <tr>
            <th style="width:40px;padding:10px 10px 10px 14px;">
              <input type="checkbox" id="select-all" style="width:15px;height:15px;cursor:pointer;accent-color:#0f172a;" onchange="toggleAll(this)">
            </th>
            <th>
              <a href="${sortToggleUrl}" style="color:#6b7280;text-decoration:none;display:flex;align-items:center;gap:5px;">
                Date <span style="font-size:13px;">${sortArrow}</span>
                <span style="font-size:10px;font-weight:400;color:#9ca3af;">(${sortLabel})</span>
              </a>
            </th>
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

  <script>
    // Move checkbox inputs into the delete form on submit so they are included
    var deleteForm = document.getElementById('delete-form');
    var table = document.getElementById('reports-table');

    function updateDeleteBtn() {
      var checked = table.querySelectorAll('.row-cb:checked');
      document.getElementById('delete-btn-wrap').style.display = checked.length > 0 ? 'block' : 'none';
      // Sync select-all state
      var all = table.querySelectorAll('.row-cb');
      document.getElementById('select-all').indeterminate = checked.length > 0 && checked.length < all.length;
      document.getElementById('select-all').checked = all.length > 0 && checked.length === all.length;
    }

    function toggleAll(cb) {
      table.querySelectorAll('.row-cb').forEach(function(c) { c.checked = cb.checked; });
      updateDeleteBtn();
    }

    // On delete form submit, inject checked IDs as hidden inputs
    deleteForm.addEventListener('submit', function(e) {
      // Remove any previously injected id inputs
      deleteForm.querySelectorAll('input[name="ids"]').forEach(function(el) { el.remove(); });
      table.querySelectorAll('.row-cb:checked').forEach(function(cb) {
        var inp = document.createElement('input');
        inp.type = 'hidden';
        inp.name = 'ids';
        inp.value = cb.value;
        deleteForm.appendChild(inp);
      });
    });
  </script>
</body>
</html>`);
});

// ── POST /intel/delete ────────────────────────────────────────────────────────
router.post('/intel/delete', requireIntelAuth, async (req, res) => {
  let ids = req.body.ids || [];
  if (!Array.isArray(ids)) ids = [ids];
  ids = ids.filter(Boolean);

  if (ids.length === 0) return res.redirect('/intel');

  const { error } = await supabase
    .from('competitor_report_log')
    .delete()
    .in('id', ids);

  if (error) {
    console.error('[intel/delete] Supabase error:', error.message);
    return res.status(500).send(`<p>Delete failed: ${error.message}</p>`);
  }

  // Redirect back preserving sort/filter, adding deleted count
  const redirectBase = req.body._redirectBase || '/intel';
  const sep = redirectBase.includes('?') ? '&' : '?';
  res.redirect(`${redirectBase}${sep}deleted=${ids.length}`);
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
