'use strict';

/**
 * Where shop owners use Bimbly (the dashboard and sign-in pages).
 *
 * Set APP_URL in Render to the dashboard's own domain, e.g.
 *   APP_URL=https://dashboard.bimblyai.com
 * Until it's set, everything stays on the Render address (no behaviour change).
 *
 * On a custom domain the dashboard lives at the root ("/", "/#/settings") and
 * sign-in at "/login". Old Render dashboard links forward there. API routes,
 * webhooks (Vapi, Stripe) and Google OAuth callbacks keep working on both hosts.
 */

const RENDER_URL = 'https://bookingagent-gmo2.onrender.com';

function trim(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function config() {
  const appUrl = trim(process.env.APP_URL) || RENDER_URL;
  let host = '';
  try { host = new URL(appUrl).host.toLowerCase(); } catch { /* bad value → treat as not custom */ }
  const custom = !!host && !/\.onrender\.com$/.test(host) && !/^localhost(:\d+)?$/.test(host);
  return { appUrl, host, custom };
}

// The dashboard, optionally with a query string (e.g. { token })
function dashboardUrl(query) {
  const { appUrl, custom } = config();
  const qs = query ? `?${new URLSearchParams(query)}` : '';
  return custom ? `${appUrl}/${qs}` : `${appUrl}/dashboard/${qs}`;
}

// The sign-in page, optionally with a query string (e.g. { error: 'no_account' })
function loginUrl(query) {
  const { appUrl, custom } = config();
  const qs = query ? `?${new URLSearchParams(query)}` : '';
  return custom ? `${appUrl}/login${qs}` : `${appUrl}/auth/dashboard/login${qs}`;
}

// Express middleware, mounted before all routes.
//  - On the dashboard domain: "/" serves the dashboard, "/login" the sign-in page,
//    "/logout" signs out. The long /auth/dashboard/login path forwards to /login.
//  - On the Render address: dashboard and sign-in pages forward to the dashboard domain.
function hostRouting() {
  return (req, res, next) => {
    const { appUrl, host, custom } = config();
    if (!custom || (req.method !== 'GET' && req.method !== 'HEAD')) return next();

    const reqHost = String(req.headers.host || '').toLowerCase();
    const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';

    if (reqHost === host) {
      if (req.path === '/') { req.url = `/dashboard/${query}`; return next(); }
      if (req.path === '/login') { req.url = `/auth/dashboard/login${query}`; return next(); }
      if (req.path === '/logout') { req.url = `/auth/logout${query}`; return next(); }
      if (req.path === '/auth/dashboard/login') return res.redirect(302, `/login${query}`);
      if (req.path === '/dashboard' || req.path === '/dashboard/') return res.redirect(301, `/${query}`);
      return next();
    }

    // Anyone still on the Render address for a page (not the API) goes to the new domain
    if (/\.onrender\.com$/.test(reqHost.replace(/:\d+$/, ''))) {
      if (req.path === '/dashboard' || req.path === '/dashboard/') return res.redirect(301, `${appUrl}/${query}`);
      if (req.path === '/auth/dashboard/login') return res.redirect(301, `${appUrl}/login${query}`);
    }
    return next();
  };
}

module.exports = { dashboardUrl, loginUrl, hostRouting, config, RENDER_URL };
