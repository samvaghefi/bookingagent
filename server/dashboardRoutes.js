const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const authMiddleware = require('./authMiddleware');
const { cancelSubscription } = require('./billingService');

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
        'stripe_subscription_id', 'is_active', 'created_at', 'call_recording_enabled', 'supported_languages'
      ].join(', '))
      .eq('id', req.business.id)
      .single();

    if (error) throw error;
    res.json({ business });
  } catch (err) {
    console.error('GET /api/business error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/business — update allowed business fields
router.put('/api/business', async (req, res) => {
  const allowed = ['name', 'phone', 'address', 'business_hours', 'ai_name', 'business_type', 'timezone', 'barbers'];
  const updates = {};
  allowed.forEach(field => {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  });

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
  } catch (err) {
    console.error('PUT /api/business error:', err.message);
    res.status(500).json({ error: err.message });
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

// ── Billing ───────────────────────────────────────────────────────────────────

// GET /api/billing — subscription info from Stripe
router.get('/api/billing', async (req, res) => {
  const { stripe_subscription_id, subscription_status, trial_ends_at } = req.business;

  if (!stripe_subscription_id) {
    return res.json({
      subscription_status: subscription_status || 'inactive',
      trial_end: trial_ends_at ? Math.floor(new Date(trial_ends_at).getTime() / 1000) : null,
      current_period_end: null,
      amount: null,
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
