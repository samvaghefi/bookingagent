const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Paths that bypass auth entirely
const SKIP_PATHS = [
  '/',
  '/health',
  '/signup',
  '/billing/webhook',
  '/billing/success',
  '/billing/cancel',
  '/billing/checkout',
  '/webhook/booking',
  '/auth/google',
  '/auth/google/callback',
  '/auth/dashboard/google',
  '/auth/dashboard/callback',
  '/auth/logout',
  '/api/businesses',   // legacy internal endpoints (secured at network level)
];

async function authMiddleware(req, res, next) {
  const skip = SKIP_PATHS.some(p => req.path === p || req.path.startsWith(p + '/'));
  if (skip || !req.path.startsWith('/api/')) return next();

  const token = req.cookies?.bimbly_session;
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const { data: business, error } = await supabase
      .from('businesses')
      .select('*')
      .eq('id', decoded.businessId)
      .single();

    if (error || !business) {
      return res.status(401).json({ error: 'Business not found' });
    }

    req.business = business;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

module.exports = authMiddleware;
