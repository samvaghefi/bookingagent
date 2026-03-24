const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const authMiddleware = require('./authMiddleware');
const { cancelSubscription } = require('./billingService');
const depositService = require('./depositService');
const QRCode = require('qrcode');
const queueService = require('./queueService');
const { rebuildAndPatchVapiPrompt } = require('./vapiService');
const bcrypt = require('bcryptjs');

const BASE_URL = process.env.RENDER_EXTERNAL_URL || 'https://bookingagent-gmo2.onrender.com';

const router = express.Router();
router.use(authMiddleware);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// ── Business ─────────────────────────────────────────────────────────────────

// GET /api/business — return authenticated business (no sensitive fields)
router.get('/api/business', async (req, res) => {
  try {
    const { data: business, error } = await supabase
      .from('businesses')
      .select([
        'id', 'name', 'owner_name', 'email', 'phone', 'address',
        'business_hours', 'ai_name', 'business_type', 'billing_email',
        'subscription_status', 'trial_ends_at', 'stripe_customer_id',
        'stripe_subscription_id', 'is_active', 'created_at', 'call_recording_enabled', 'supported_languages',
        'twilio_phone', 'timezone', 'barbers', 'team_members', 'plan',
        'deposit_enabled', 'deposit_amount',
        'queue_enabled', 'queue_notify_timeout',
        'booking_slug', 'logo_url'
      ].join(', '))
      .eq('id', req.business.id)
      .single();

    if (error) throw error;
    // Normalise team_members: merge from barbers if team_members is empty, add role field if missing
    const teamMembers = normalizeTeamMembers(business.team_members || business.barbers);
    res.json({ business: { ...business, team_members: teamMembers, barbers: teamMembers } });
  } catch (err) {
    console.error('GET /api/business error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/business — update allowed business fields
// Fields that require a Vapi system-prompt rebuild when changed:
const VAPI_PROMPT_FIELDS = new Set(['name', 'address', 'business_hours', 'ai_name', 'barbers', 'team_members', 'deposit_enabled', 'deposit_amount']);

// Normalise a raw team_members/barbers value to [{name, role, calendarId}]
function normalizeTeamMembers(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(m =>
    typeof m === 'string'
      ? { name: m, role: '', calendarId: '' }
      : { role: '', calendarId: '', ...m }
  ).filter(m => m.name);
}

router.put('/api/business', async (req, res) => {
  const allowed = ['name', 'phone', 'address', 'business_hours', 'ai_name', 'business_type', 'timezone', 'barbers', 'team_members', 'deposit_enabled', 'deposit_amount', 'queue_enabled', 'queue_notify_timeout'];
  const updates = {};
  allowed.forEach(field => {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  });

  // Normalise team_members: write to both columns for transition period
  if (updates.team_members !== undefined) {
    updates.team_members = normalizeTeamMembers(updates.team_members);
    updates.barbers = updates.team_members;
  } else if (updates.barbers !== undefined) {
    updates.team_members = normalizeTeamMembers(updates.barbers);
    updates.barbers = updates.team_members;
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid fields to update.' });
  }

  try {
    const { data: business, error } = await supabase
      .from('businesses')
      .update(updates)
      .eq('id', req.business.id)
      .select('id, name, phone, address, business_hours, ai_name')
      .single();

    if (error) throw error;
    res.json({ business });

    // Fire-and-forget Vapi prompt rebuild if any Vapi-relevant field changed
    const needsVapiSync = Object.keys(updates).some(f => VAPI_PROMPT_FIELDS.has(f));
    if (needsVapiSync) {
      (async () => {
        try {
          const [{ data: fullBiz }, { data: services }] = await Promise.all([
            supabase.from('businesses').select('*').eq('id', req.business.id).single(),
            supabase.from('services').select('*').eq('business_id', req.business.id),
          ]);
          if (fullBiz) await rebuildAndPatchVapiPrompt(fullBiz, services || []);
        } catch (vapiErr) {
          console.error('Vapi prompt sync failed (non-fatal):', vapiErr.message);
        }
      })();
    }
  } catch (err) {
    console.error('PUT /api/business error:', err);
    res.status(500).json({ error: err.message || JSON.stringify(err) });
  }
});

// ── Bookings ──────────────────────────────────────────────────────────────────

// GET /api/bookings — fetch bookings with optional date filters
router.get('/api/bookings', async (req, res) => {
  const { date, from, to, limit = 50 } = req.query;

  try {
    let query = supabase
      .from('bookings')
      .select('*')
      .eq('business_id', req.business.id)
      .order('appointment_date', { ascending: false })
      .order('appointment_time', { ascending: false })
      .limit(parseInt(limit));

    if (date) {
      query = query.eq('appointment_date', date);
    } else if (from && to) {
      query = query.gte('appointment_date', from).lte('appointment_date', to);
    } else {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      query = query.gte('appointment_date', thirtyDaysAgo.toISOString().split('T')[0]);
    }

    const { data: bookings, error } = await query;
    if (error) throw error;
    res.json({ bookings });
  } catch (err) {
    console.error('GET /api/bookings error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Analytics ─────────────────────────────────────────────────────────────────

// GET /api/analytics — compute booking analytics for the authenticated business
router.get('/api/analytics', async (req, res) => {
  try {
    const today = new Date();
    const startOfThisMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const startOfLastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const eightWeeksAgo = new Date(today.getTime() - 8 * 7 * 24 * 60 * 60 * 1000);
    const sevenDaysAhead = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);

    const fetchFrom = startOfLastMonth.toISOString().split('T')[0];
    const fetchTo = sevenDaysAhead.toISOString().split('T')[0];
    const todayStr = today.toISOString().split('T')[0];
    const thisMonthStr = startOfThisMonth.toISOString().split('T')[0];
    const lastMonthStr = startOfLastMonth.toISOString().split('T')[0];
    const nextWeekStr = sevenDaysAhead.toISOString().split('T')[0];

    // Fetch all bookings for the analysis window
    const { data: bookings, error } = await supabase
      .from('bookings')
      .select('*')
      .eq('business_id', req.business.id)
      .gte('appointment_date', fetchFrom)
      .lte('appointment_date', fetchTo)
      .order('appointment_date', { ascending: true });

    if (error) throw error;

    const PRICE_LOOKUP = {
      "men's haircut": 35,
      "beard trim": 20,
      "men's haircut + beard trim": 50,
      "kid's haircut": 25,
      "men's haircut and beard trim": 50,
      "haircut": 35,
    };

    // Partition bookings
    const thisMonthBookings = bookings.filter(b => b.appointment_date >= thisMonthStr && b.appointment_date <= todayStr);
    const lastMonthBookings = bookings.filter(b => b.appointment_date >= lastMonthStr && b.appointment_date < thisMonthStr);
    const todayBookings = bookings.filter(b => b.appointment_date === todayStr);
    const upcomingBookings = bookings.filter(b => b.appointment_date > todayStr && b.appointment_date <= nextWeekStr);
    const recentBookings = bookings.filter(b => b.appointment_date >= eightWeeksAgo.toISOString().split('T')[0] && b.appointment_date <= todayStr);

    // Revenue estimate this month
    const revenueEstimateThisMonth = thisMonthBookings.reduce((sum, b) => {
      const raw = b.service_ids;
      const name = Array.isArray(raw) ? raw[0] : raw;
      const price = PRICE_LOOKUP[(name || '').toLowerCase().trim()] ?? 35;
      return sum + price;
    }, 0);

    // Busiest days of week
    const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayCounts = {};
    recentBookings.forEach(b => {
      const day = DAY_NAMES[new Date(b.appointment_date + 'T12:00:00').getDay()];
      dayCounts[day] = (dayCounts[day] || 0) + 1;
    });
    const busiestDays = Object.entries(dayCounts)
      .map(([day, count]) => ({ day, count }))
      .sort((a, b) => b.count - a.count);

    // Popular services
    const serviceCounts = {};
    recentBookings.forEach(b => {
      (b.service_ids || []).forEach(name => {
        serviceCounts[name] = (serviceCounts[name] || 0) + 1;
      });
    });
    const popularServices = Object.entries(serviceCounts)
      .map(([service, count]) => ({ service, count }))
      .sort((a, b) => b.count - a.count);

    // Peak hours
    const hourCounts = {};
    recentBookings.forEach(b => {
      if (b.appointment_time) {
        const hour = parseInt(b.appointment_time.split(':')[0]);
        hourCounts[hour] = (hourCounts[hour] || 0) + 1;
      }
    });
    const peakHours = Object.entries(hourCounts)
      .map(([hour, count]) => ({ hour: parseInt(hour), count }))
      .sort((a, b) => a.hour - b.hour);

    // Bookings by week (last 8 weeks)
    const weekCounts = {};
    recentBookings.forEach(b => {
      const date = new Date(b.appointment_date + 'T12:00:00');
      const weekStart = new Date(date);
      weekStart.setDate(date.getDate() - date.getDay()); // Sunday
      const weekKey = weekStart.toISOString().split('T')[0];
      weekCounts[weekKey] = (weekCounts[weekKey] || 0) + 1;
    });
    const bookingsByWeek = Object.entries(weekCounts)
      .map(([week, count]) => ({ week, count }))
      .sort((a, b) => a.week.localeCompare(b.week));

    res.json({
      totalBookingsThisMonth: thisMonthBookings.length,
      totalBookingsLastMonth: lastMonthBookings.length,
      todayBookings,
      upcomingBookings,
      revenueEstimateThisMonth,
      busiestDays,
      popularServices,
      peakHours,
      bookingsByWeek
    });
  } catch (err) {
    console.error('GET /api/analytics error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Services ──────────────────────────────────────────────────────────────────

// GET /api/services
router.get('/api/services', async (req, res) => {
  try {
    const { data: services, error } = await supabase
      .from('services')
      .select('*')
      .eq('business_id', req.business.id)
      .order('name', { ascending: true });

    if (error) throw error;
    res.json({ services });
  } catch (err) {
    console.error('GET /api/services error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/services
router.post('/api/services', async (req, res) => {
  const { name, price, duration_minutes, description } = req.body;
  if (!name) return res.status(400).json({ error: 'Service name is required.' });

  try {
    const { data: service, error } = await supabase
      .from('services')
      .insert({ business_id: req.business.id, name, price, duration_minutes, description })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ service });
  } catch (err) {
    console.error('POST /api/services error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/services/replace — must be defined BEFORE /:id to avoid Express matching 'replace' as :id
router.put('/api/services/replace', async (req, res) => {
  const { services } = req.body;
  if (!Array.isArray(services)) {
    return res.status(400).json({ error: 'services must be an array.' });
  }

  try {
    // Step 1: Delete ALL existing services for this business
    const { error: deleteError } = await supabase
      .from('services')
      .delete()
      .eq('business_id', req.business.id);

    if (deleteError) throw deleteError;

    // Step 2: Build insert payload — strip id/business_id/created_at so Supabase generates fresh IDs
    const toInsert = services
      .map(s => ({
        business_id:      req.business.id,
        name:             s.name,
        price:            s.price,
        duration_minutes: s.duration_minutes,
        description:      s.description || null,
      }))
      .filter(s => s.name && s.name.trim());

    // Step 3: Insert (only if there's something to insert)
    let inserted = [];
    if (toInsert.length > 0) {
      const { data, error: insertError } = await supabase
        .from('services')
        .insert(toInsert)
        .select();
      if (insertError) throw insertError;
      inserted = data || [];
    }

    res.json({ success: true, count: inserted.length, services: inserted });
  } catch (err) {
    console.error('PUT /api/services/replace error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/services/:id
router.put('/api/services/:id', async (req, res) => {
  try {
    // Verify ownership
    const { data: existing, error: fetchError } = await supabase
      .from('services')
      .select('id, business_id')
      .eq('id', req.params.id)
      .single();

    if (fetchError || !existing || existing.business_id !== req.business.id) {
      return res.status(404).json({ error: 'Service not found.' });
    }

    const allowed = ['name', 'price', 'duration_minutes', 'description'];
    const updates = {};
    allowed.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });

    const { data: service, error } = await supabase
      .from('services')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json({ service });
  } catch (err) {
    console.error('PUT /api/services/:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/services/:id
router.delete('/api/services/:id', async (req, res) => {
  try {
    const { data: existing, error: fetchError } = await supabase
      .from('services')
      .select('id, business_id')
      .eq('id', req.params.id)
      .single();

    if (fetchError || !existing || existing.business_id !== req.business.id) {
      return res.status(404).json({ error: 'Service not found.' });
    }

    const { error } = await supabase.from('services').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/services/:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/services/replace — delete all existing services and insert new list atomically


// ── Clients ───────────────────────────────────────────────────────────────────

// Helper: compute per-phone stats from a bookings array
function computeClientStats(bookings) {
  const stats = {};
  for (const b of bookings) {
    const phone = b.customer_phone;
    if (!phone) continue;
    if (!stats[phone]) {
      stats[phone] = { visit_count: 0, last_visit: null, services: {}, barbers: {} };
    }
    const s = stats[phone];
    s.visit_count++;
    if (!s.last_visit || b.appointment_date > s.last_visit) {
      s.last_visit = b.appointment_date;
    }
    const svc = Array.isArray(b.service_ids) ? b.service_ids[0] : null;
    if (svc) s.services[svc] = (s.services[svc] || 0) + 1;
    if (b.preferred_barber) s.barbers[b.preferred_barber] = (s.barbers[b.preferred_barber] || 0) + 1;
  }
  // Reduce to preferred values
  const result = {};
  for (const [phone, s] of Object.entries(stats)) {
    result[phone] = {
      visit_count: s.visit_count,
      last_visit: s.last_visit,
      preferred_service: Object.keys(s.services).sort((a, b) => s.services[b] - s.services[a])[0] || null,
      preferred_barber: Object.keys(s.barbers).sort((a, b) => s.barbers[b] - s.barbers[a])[0] || null,
    };
  }
  return result;
}

// GET /api/clients — list all clients with computed stats
router.get('/api/clients', async (req, res) => {
  try {
    const [{ data: clients, error: cErr }, { data: bookings, error: bErr }] = await Promise.all([
      supabase.from('clients').select('*').eq('business_id', req.business.id).order('name'),
      supabase.from('bookings')
        .select('customer_phone, appointment_date, service_ids, preferred_barber')
        .eq('business_id', req.business.id)
    ]);

    if (cErr) throw cErr;
    if (bErr) throw bErr;

    const stats = computeClientStats(bookings || []);

    const enriched = (clients || []).map(c => ({
      ...c,
      ...(stats[c.phone] || { visit_count: 0, last_visit: null, preferred_service: null, preferred_barber: null })
    }));

    res.json({ clients: enriched });
  } catch (err) {
    console.error('GET /api/clients error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/clients — manually create a client
router.post('/api/clients', async (req, res) => {
  const { name, phone, notes, tags } = req.body;
  if (!name || !phone) {
    return res.status(400).json({ error: 'name and phone are required.' });
  }
  if (tags !== undefined && !Array.isArray(tags)) {
    return res.status(400).json({ error: 'tags must be an array of strings.' });
  }

  try {
    const { data: client, error } = await supabase
      .from('clients')
      .insert({ business_id: req.business.id, name, phone, notes: notes || null, tags: tags || [] })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'A client with this phone number already exists.' });
      }
      throw error;
    }

    res.status(201).json({ client });
  } catch (err) {
    console.error('POST /api/clients error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/clients/:id — single client with stats + booking history
router.get('/api/clients/:id', async (req, res) => {
  try {
    const { data: client, error: cErr } = await supabase
      .from('clients')
      .select('*')
      .eq('id', req.params.id)
      .eq('business_id', req.business.id)
      .single();

    if (cErr || !client) return res.status(404).json({ error: 'Client not found.' });

    const { data: bookings, error: bErr } = await supabase
      .from('bookings')
      .select('*')
      .eq('business_id', req.business.id)
      .eq('customer_phone', client.phone)
      .order('appointment_date', { ascending: false })
      .order('appointment_time', { ascending: false });

    if (bErr) throw bErr;

    const stats = computeClientStats(bookings || []);
    const enriched = { ...client, ...(stats[client.phone] || { visit_count: 0, last_visit: null, preferred_service: null, preferred_barber: null }) };

    res.json({ client: enriched, bookings: bookings || [] });
  } catch (err) {
    console.error('GET /api/clients/:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/clients/:id — update name, notes, tags (phone is not updatable)
router.put('/api/clients/:id', async (req, res) => {
  if (req.body.phone !== undefined) {
    return res.status(400).json({ error: 'Phone number cannot be changed. Delete and re-add this client to change their number.' });
  }

  const allowed = ['name', 'notes', 'tags'];
  const updates = { updated_at: new Date().toISOString() };
  allowed.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });

  if (Object.keys(updates).length === 1) {
    return res.status(400).json({ error: 'No valid fields to update.' });
  }

  try {
    const { data: client, error } = await supabase
      .from('clients')
      .update(updates)
      .eq('id', req.params.id)
      .eq('business_id', req.business.id)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Client not found.' });
      }
      throw error;
    }
    if (!client) return res.status(404).json({ error: 'Client not found.' });
    res.json({ client });
  } catch (err) {
    console.error('PUT /api/clients/:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/clients/:id — delete client only (bookings preserved)
router.delete('/api/clients/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('clients')
      .delete()
      .eq('id', req.params.id)
      .eq('business_id', req.business.id)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Client not found.' });
      }
      throw error;
    }
    if (!data) return res.status(404).json({ error: 'Client not found.' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/clients/:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Billing ───────────────────────────────────────────────────────────────────

// GET /api/billing — subscription info from Stripe
router.get('/api/billing', async (req, res) => {
  const { stripe_subscription_id, subscription_status, trial_ends_at, plan } = req.business;
  const PLAN_PRICES = { solo: 39, starter: 99, pro: 199 };
  const planAmount = PLAN_PRICES[plan] || 39;

  if (!stripe_subscription_id) {
    return res.json({
      subscription_status: subscription_status || 'inactive',
      trial_end: trial_ends_at ? Math.floor(new Date(trial_ends_at).getTime() / 1000) : null,
      current_period_end: null,
      amount: planAmount,
      currency: 'CAD',
      cancel_at_period_end: false
    });
  }

  try {
    const sub = await stripe.subscriptions.retrieve(stripe_subscription_id, {
      expand: ['items.data.price']
    });
    const unitAmount = sub.items?.data?.[0]?.price?.unit_amount;
    const amount = unitAmount != null ? unitAmount / 100 : null;
    res.json({
      subscription_status: subscription_status,
      trial_end: sub.trial_end || null,
      current_period_end: sub.current_period_end || null,
      amount,
      currency: 'CAD',
      cancel_at_period_end: sub.cancel_at_period_end
    });
  } catch (err) {
    console.error('GET /api/billing error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/billing/cancel — cancel at period end
router.post('/api/billing/cancel', async (req, res) => {
  const { stripe_subscription_id } = req.business;

  if (!stripe_subscription_id) {
    return res.status(400).json({ error: 'No active subscription found.' });
  }

  try {
    await cancelSubscription(stripe_subscription_id);

    await supabase
      .from('businesses')
      .update({ subscription_status: 'cancelling' })
      .eq('id', req.business.id);

    res.json({ success: true, message: 'Subscription will cancel at the end of the current billing period.' });
  } catch (err) {
    console.error('POST /api/billing/cancel error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Booking Page Slug ─────────────────────────────────────────────────────────

// PUT /api/business/slug — update the booking page slug
router.put('/api/business/slug', async (req, res) => {
  const { slug } = req.body;
  if (!slug) return res.status(400).json({ error: 'Slug is required.' });
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return res.status(400).json({ error: 'Invalid slug format. Use lowercase letters, numbers, and hyphens only.' });
  }
  try {
    const { data: existing } = await supabase
      .from('businesses')
      .select('id')
      .eq('booking_slug', slug)
      .neq('id', req.business.id)
      .maybeSingle();

    if (existing) return res.status(409).json({ error: 'Slug already taken. Please choose another.' });

    const { data: business, error } = await supabase
      .from('businesses')
      .update({ booking_slug: slug })
      .eq('id', req.business.id)
      .select('id, booking_slug')
      .single();

    if (error) throw error;
    res.json({ business });
  } catch (err) {
    console.error('PUT /api/business/slug error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

// ── Call Recording Toggle ─────────────────────────────────────────────────────

// PUT /api/business/recording — toggle call recording on/off
router.put('/api/business/recording', async (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be a boolean.' });
  }

  try {
    // 1. Get business to find vapi_assistant_id
    const { data: business, error: fetchError } = await supabase
      .from('businesses')
      .select('id, vapi_assistant_id')
      .eq('id', req.business.id)
      .single();

    if (fetchError) throw fetchError;

    // 2. Update Supabase
    const { error: updateError } = await supabase
      .from('businesses')
      .update({ call_recording_enabled: enabled })
      .eq('id', req.business.id);

    if (updateError) throw updateError;

    // 3. Update Vapi assistant if we have an assistant ID
    if (business.vapi_assistant_id) {
      const vapiRes = await fetch(`https://api.vapi.ai/assistant/${business.vapi_assistant_id}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${process.env.VAPI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          artifactPlan: {
            recordingEnabled: enabled
          }
        })
      });

      if (!vapiRes.ok) {
        const vapiErr = await vapiRes.text();
        console.error('Vapi update error:', vapiErr);
        return res.status(500).json({ error: 'Vapi update failed: ' + vapiErr });
      }
    }

    res.json({ success: true, call_recording_enabled: enabled });
  } catch (err) {
    console.error('PUT /api/business/recording error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── No-Show Deposits ──────────────────────────────────────────────────────────
router.post('/api/bookings/:id/no-show', async (req, res) => {
  try {
    const { data: booking, error } = await supabase
      .from('bookings')
      .select('*')
      .eq('id', req.params.id)
      .eq('business_id', req.business.id)
      .single();
    if (error || !booking) return res.status(404).json({ error: 'Booking not found.' });
    if (booking.deposit_status !== 'secured') {
      return res.status(400).json({ error: 'Booking does not have a secured deposit.' });
    }
    const { data: business } = await supabase
      .from('businesses')
      .select('deposit_amount')
      .eq('id', req.business.id)
      .single();
    await depositService.chargeNoShow(booking, business);
    const { data: updated } = await supabase
      .from('bookings')
      .select('*')
      .eq('id', booking.id)
      .single();
    res.json({ booking: updated });
  } catch (err) {
    console.error('POST /api/bookings/:id/no-show error:', err.message);
    const status = err.type === 'StripeCardError' ? 402 : 500;
    res.status(status).json({ error: err.message || 'Failed to charge no-show deposit.' });
  }
});

router.post('/api/bookings/:id/waive-deposit', async (req, res) => {
  try {
    const { data: booking, error } = await supabase
      .from('bookings')
      .select('*')
      .eq('id', req.params.id)
      .eq('business_id', req.business.id)
      .single();
    if (error || !booking) return res.status(404).json({ error: 'Booking not found.' });
    if (!['pending', 'secured'].includes(booking.deposit_status)) {
      return res.status(400).json({ error: 'Deposit cannot be waived in its current state.' });
    }
    await supabase.from('bookings').update({ deposit_status: 'waived' }).eq('id', booking.id);
    const { data: updated } = await supabase
      .from('bookings')
      .select('*')
      .eq('id', booking.id)
      .single();
    res.json({ booking: updated });
  } catch (err) {
    console.error('POST /api/bookings/:id/waive-deposit error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Walk-in Queue ─────────────────────────────────────────────────────────────

// IMPORTANT: /api/queue/qr MUST be registered before /api/queue/:id/* routes
// to prevent Express from matching "qr" as an :id parameter.

// GET /api/queue/qr — generate QR code image pointing to the public walk-in form
router.get('/api/queue/qr', async (req, res) => {
  try {
    const url = `${BASE_URL}/q/${req.business.id}`;
    const qrBuffer = await QRCode.toBuffer(url, { width: 300, margin: 2 });
    res.set('Content-Type', 'image/png');
    res.send(qrBuffer);
  } catch (err) {
    console.error('GET /api/queue/qr error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/queue — fetch active queue for this business
router.get('/api/queue', async (req, res) => {
  try {
    const queue = await queueService.getActiveQueue(req.business.id);
    res.json({ queue });
  } catch (err) {
    console.error('GET /api/queue error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/queue/:id/notify — send "you're up" SMS
router.post('/api/queue/:id/notify', async (req, res) => {
  try {
    const entry = await queueService.notifyCustomer(
      req.params.id,
      req.business.id,
      req.business.name,
      req.business.twilio_phone
    );
    res.json({ entry });
  } catch (err) {
    console.error('POST /api/queue/:id/notify error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// POST /api/queue/:id/serve — mark as served
router.post('/api/queue/:id/serve', async (req, res) => {
  try {
    const { data: entry, error } = await supabase
      .from('walk_in_queue')
      .update({ status: 'served', served_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('business_id', req.business.id)
      .select()
      .single();
    if (error) throw error;
    res.json({ entry });
  } catch (err) {
    console.error('POST /api/queue/:id/serve error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/queue/:id/no-show — mark as no_show
router.post('/api/queue/:id/no-show', async (req, res) => {
  try {
    const { data: entry, error } = await supabase
      .from('walk_in_queue')
      .update({ status: 'no_show' })
      .eq('id', req.params.id)
      .eq('business_id', req.business.id)
      .select()
      .single();
    if (error) throw error;
    res.json({ entry });
  } catch (err) {
    console.error('POST /api/queue/:id/no-show error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/queue/:id/remove — remove from queue (cancel/mistake)
router.post('/api/queue/:id/remove', async (req, res) => {
  try {
    const { data: entry, error } = await supabase
      .from('walk_in_queue')
      .update({ status: 'removed', removed_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('business_id', req.business.id)
      .select()
      .single();
    if (error) throw error;
    res.json({ entry });
  } catch (err) {
    console.error('POST /api/queue/:id/remove error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Password management ────────────────────────────────────────────────────────

// POST /api/auth/change-password — change password for authenticated user
router.post('/api/auth/change-password', async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;

  if (!currentPassword || !newPassword || !confirmPassword) {
    return res.status(400).json({ error: 'currentPassword, newPassword, and confirmPassword are required' });
  }

  if (newPassword !== confirmPassword) {
    return res.status(400).json({ error: 'New password and confirmation do not match' });
  }

  try {
    // Fetch the full business row (req.business from authMiddleware may not include password_hash)
    const { data: business, error } = await supabase
      .from('businesses')
      .select('id, email, password_hash')
      .eq('id', req.business.id)
      .single();

    if (error || !business) throw error || new Error('Business not found');

    if (!business.password_hash) {
      return res.status(400).json({ error: 'No password set — this account uses Google sign-in' });
    }

    const match = await bcrypt.compare(currentPassword, business.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const hash = await bcrypt.hash(newPassword, 10);
    const { error: updateError } = await supabase
      .from('businesses')
      .update({ password_hash: hash })
      .eq('id', business.id);

    if (updateError) throw updateError;

    console.log(`🔑 Password changed for business ${business.id}`);
    return res.json({ message: 'Password updated successfully' });
  } catch (err) {
    console.error('POST /api/auth/change-password error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;