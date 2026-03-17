'use strict';

const { useState, useEffect, useCallback, useRef } = React;

const API_BASE = 'https://bookingagent-gmo2.onrender.com';

// ── API helper ────────────────────────────────────────────────────────────────
async function apiFetch(path, options = {}) {
  const token = localStorage.getItem('bimbly_token');
  const res = await fetch(API_BASE + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) {
    localStorage.removeItem('bimbly_token');
    window.location.href = API_BASE + '/auth/dashboard/google';
    throw new Error('Unauthorized');
  }
  return res;
}

// ── Spinner ───────────────────────────────────────────────────────────────────
function Spinner() {
  return (
    <div className="spinner-wrap">
      <div className="spinner"></div>
    </div>
  );
}

// ── Sidebar ───────────────────────────────────────────────────────────────────
function Sidebar({ page, setPage, business }) {
  const navItems = [
    { id: 'home',      label: 'Dashboard', icon: '◫' },
    { id: 'bookings',  label: 'Bookings',  icon: '📅' },
    { id: 'settings',  label: 'Settings',  icon: '⚙' },
    { id: 'billing',   label: 'Billing',   icon: '💳' },
    { id: 'onboarding', label: 'Setup Wizard', icon: '✨' },
  ];

  return (
    <aside className="sidebar">
      <div className="sidebar-logo">
        <a href="https://bimblyai.com" style={{display:'block'}}>
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 340 90" width="180" height="48" style={{display:'block'}}>
          <g transform="translate(8, 10)">
            <path d="M22 38 Q22 14 42 14 Q62 14 62 38 Q62 62 82 62 Q102 62 102 38 Q102 14 82 14 Q62 14 62 38 Q62 62 42 62 Q22 62 22 38Z"
                  fill="none" stroke="#7F77DD" strokeWidth="5.5" strokeLinecap="round" strokeLinejoin="round"/>
            <circle cx="42" cy="27" r="8" fill="#7F77DD"/>
            <circle cx="43" cy="28" r="3.5" fill="white"/>
            <circle cx="82" cy="27" r="8" fill="#7F77DD"/>
            <circle cx="83" cy="28" r="3.5" fill="white"/>
            <path d="M52 48 Q62 56 72 48" fill="none" stroke="#7F77DD" strokeWidth="2.5" strokeLinecap="round" opacity="0.5"/>
            <line x1="62" y1="14" x2="62" y2="3" stroke="#F0997B" strokeWidth="3" strokeLinecap="round"/>
            <circle cx="62" cy="3" r="6" fill="#F0997B"/>
          </g>
          <text x="130" y="58" fontFamily="'Helvetica Neue', Helvetica, Arial, sans-serif" fontSize="34" fontWeight="700" letterSpacing="-1">
            <tspan fill="#AFA9EC">bimbly</tspan><tspan fill="#F0997B" fontWeight="300">ai</tspan>
          </text>
        </svg>
        </a>
      </div>
      <nav className="sidebar-nav">
        {navItems.map(item => (
          <button
            key={item.id}
            className={`nav-item ${page === item.id ? 'active' : ''}`}
            onClick={() => setPage(item.id)}
          >
            <span className="nav-icon">{item.icon}</span>
            {item.label}
          </button>
        ))}
      </nav>
      <div className="sidebar-footer">
        <div className="business-name">{business?.name || 'Your Business'}</div>
        <button
          className="logout-btn"
          onClick={() => {
            localStorage.removeItem('bimbly_token');
            window.location.href = API_BASE + '/auth/logout';
          }}
        >
          Sign out
        </button>
      </div>
    </aside>
  );
}

// ── TopBar ────────────────────────────────────────────────────────────────────
function TopBar({ title }) {
  const today = new Date().toLocaleDateString('en-CA', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  return (
    <div className="topbar">
      <h1 className="topbar-title">{title}</h1>
      <span className="topbar-date">Today is {today}</span>
    </div>
  );
}

// ── StatCard ──────────────────────────────────────────────────────────────────
function StatCard({ label, value, accent, sub }) {
  return (
    <div className="stat-card" style={{ borderLeftColor: accent }}>
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={{ color: accent }}>{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

// ── CSS Bar Chart ─────────────────────────────────────────────────────────────
function BarChart({ data, color }) {
  if (!data || !data.length) return <div className="empty-chart">No data yet</div>;
  const max = Math.max(...data.map(d => d.count), 1);
  return (
    <div className="bar-chart">
      {data.map((item, i) => (
        <div key={i} className="bar-row">
          <div className="bar-label">{item.label || item.day || item.service || item.name}</div>
          <div className="bar-track">
            <div
              className="bar-fill"
              style={{ width: `${(item.count / max) * 100}%`, background: color }}
            ></div>
          </div>
          <div className="bar-count">{item.count}</div>
        </div>
      ))}
    </div>
  );
}

// ── Bookings Table ────────────────────────────────────────────────────────────
function BookingsTable({ bookings }) {
  if (!bookings.length) {
    return (
      <div className="empty-state">
        <div className="empty-icon">📞</div>
        <div className="empty-title">No bookings yet</div>
        <div className="empty-sub">Your AI receptionist is ready to take calls</div>
      </div>
    );
  }
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>Customer</th>
            <th>Phone</th>
            <th>Service</th>
            <th>Date</th>
            <th>Time</th>
            <th>Barber</th>
            <th>Special Requests</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {bookings.map(b => (
            <tr key={b.id}>
              <td>
                <div className="cell-name">{String(b.customer_name || '—')}</div>
              </td>
              <td>{String(b.customer_phone || '—')}</td>
              <td>{Array.isArray(b.service_ids) ? b.service_ids.join(', ') : String(b.service_ids || '—')}</td>
              <td>
                {b.appointment_date
                  ? new Date(b.appointment_date + 'T00:00:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' })
                  : '—'}
              </td>
              <td>{String(b.appointment_time || '—')}</td>
              <td>{String(b.preferred_barber || '—')}</td>
              <td className="cell-requests">{String(b.special_requests || '—')}</td>
              <td>{String(b.status || '—')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Dashboard Home ────────────────────────────────────────────────────────────
function DashboardHome() {
  const [analytics, setAnalytics] = useState(null);
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    Promise.all([
      apiFetch('/api/analytics').then(r => r.json()),
      apiFetch('/api/bookings?limit=10').then(r => r.json()),
    ])
      .then(([a, b]) => {
        setAnalytics(a);
        setBookings(b.bookings || []);
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Spinner />;
  if (error) return <div className="error-msg" style={{ margin: 24 }}>{error}</div>;

  const a = analytics || {};
  const busiestDays = (a.busiestDays || []).map(d => ({ ...d, label: d.day }));
  const popularServices = (a.popularServices || []).map(s => ({ ...s, label: s.service }));

  return (
    <div className="page-content">
      <div className="stats-row">
        <StatCard label="Today's Bookings"   value={Array.isArray(a.todayBookings) ? a.todayBookings.length : (a.todayBookings ?? 0)}         accent="#D85A30" />
        <StatCard label="This Month"          value={a.totalBookingsThisMonth ?? 0} accent="#534AB7" />
        <StatCard label="Est. Revenue"        value={`$${(a.revenueEstimateThisMonth ?? 0).toLocaleString()}`} accent="#10b981" sub="this month" />
        <StatCard label="Upcoming This Week"  value={Array.isArray(a.upcomingBookings) ? a.upcomingBookings.length : (a.upcomingBookings ?? 0)}       accent="#f59e0b" />
      </div>

      <div className="charts-row">
        <div className="card">
          <div className="card-header">Bookings by Day of Week</div>
          <BarChart data={busiestDays} color="#534AB7" />
        </div>
        <div className="card">
          <div className="card-header">Popular Services</div>
          <BarChart data={popularServices} color="#D85A30" />
        </div>
      </div>

      <div className="card">
        <div className="card-header">Recent Bookings</div>
        <BookingsTable bookings={bookings} />
      </div>
    </div>
  );
}

// ── Bookings Page ─────────────────────────────────────────────────────────────
function BookingsPage() {
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('month');

  useEffect(() => {
    setLoading(true);
    let query = '/api/bookings';
    const today = new Date().toISOString().slice(0, 10);
    if (filter === 'today') {
      query += `?date=${today}`;
    } else if (filter === 'week') {
      const from = new Date();
      from.setDate(from.getDate() - 7);
      query += `?from=${from.toISOString().slice(0, 10)}&to=${today}`;
    }
    apiFetch(query)
      .then(r => r.json())
      .then(d => setBookings(d.bookings || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [filter]);

  return (
    <div className="page-content">
      <div className="filter-bar">
        {[
          { id: 'today', label: 'Today' },
          { id: 'week',  label: 'This Week' },
          { id: 'month', label: 'This Month' },
        ].map(f => (
          <button
            key={f.id}
            className={`filter-btn ${filter === f.id ? 'active' : ''}`}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>
      <div className="card">
        {loading ? <Spinner /> : <BookingsTable bookings={bookings} />}
      </div>
    </div>
  );
}

// ── Settings Page ─────────────────────────────────────────────────────────────
const DAYS = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];

function SettingsPage() {
  const [business, setBusiness]   = useState(null);
  const [services, setServices]   = useState([]);
  const [loading, setLoading]     = useState(true);
  const [saving, setSaving]       = useState(false);
  const [saveMsg, setSaveMsg]     = useState('');
  const [newService, setNewService] = useState(null);
  const [barbers, setBarbers]     = useState([]);
  const [newBarber, setNewBarber]   = useState('');
  const [recordSaving, setRecordSaving] = useState(false);
  const [recordMsg, setRecordMsg]       = useState('');
  const recordDebounceRef = useRef(null);

  useEffect(() => {
    Promise.all([
      apiFetch('/api/business').then(r => r.json()),
      apiFetch('/api/services').then(r => r.json()),
    ])
      .then(([b, s]) => {
        const biz = b.business || b;
        setBusiness(biz);
        setServices(s.services || s || []);
        setBarbers(biz.barbers || []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setSaveMsg('');
    try {
      await apiFetch('/api/business', {
        method: 'PUT',
        body: JSON.stringify({
          name:           business.name,
          phone:          business.phone,
          address:        business.address,
          business_hours: business.business_hours,
          ai_name:        business.ai_name,
          barbers,
        }),
      });
      setSaveMsg('Saved!');
      setTimeout(() => setSaveMsg(''), 2500);
    } catch {
      setSaveMsg('Failed to save.');
    } finally {
      setSaving(false);
    }
  };

  const handleRecordingToggle = (enabled) => {
    setBusiness(b => ({ ...b, call_recording_enabled: enabled }));
    clearTimeout(recordDebounceRef.current);
    recordDebounceRef.current = setTimeout(async () => {
      setRecordSaving(true);
      setRecordMsg('');
      try {
        await apiFetch('/api/business/recording', {
          method: 'PUT',
          body: JSON.stringify({ enabled }),
        });
        setRecordMsg('Recording setting updated');
        setTimeout(() => setRecordMsg(''), 2500);
      } catch {
        setRecordMsg('Failed to update recording setting.');
        setBusiness(b => ({ ...b, call_recording_enabled: !enabled }));
      } finally {
        setRecordSaving(false);
      }
    }, 500);
  };

  const addService = async () => {
    if (!newService?.name) return;
    try {
      const res = await apiFetch('/api/services', {
        method: 'POST',
        body: JSON.stringify(newService),
      });
      const data = await res.json();
      setServices(s => [...s, data.service || data]);
      setNewService(null);
    } catch {}
  };

  const deleteService = async id => {
    try {
      await apiFetch(`/api/services/${id}`, { method: 'DELETE' });
      setServices(s => s.filter(x => x.id !== id));
    } catch {}
  };

  const updateHours = (day, field, value) => {
    setBusiness(b => ({
      ...b,
      business_hours: {
        ...(b.business_hours || {}),
        [day]: {
          ...(b.business_hours?.[day] || { open: '09:00', close: '18:00', closed: false }),
          [field]: value,
        },
      },
    }));
  };

  if (loading) return <Spinner />;
  const hours = business?.business_hours || {};

  return (
    <div className="page-content settings-page">

      {/* ── Business Info ── */}
      <div className="card">
        <div className="card-header">Business Info</div>
        <div className="settings-grid">
          <div className="form-group">
            <label>Business Name</label>
            <input
              value={business?.name || ''}
              onChange={e => setBusiness(b => ({ ...b, name: e.target.value }))}
            />
          </div>
          <div className="form-group">
            <label>Phone Number</label>
            <input
              value={business?.phone || ''}
              onChange={e => setBusiness(b => ({ ...b, phone: e.target.value }))}
            />
          </div>
          <div className="form-group full-width">
            <label>Address</label>
            <input
              value={business?.address || ''}
              onChange={e => setBusiness(b => ({ ...b, address: e.target.value }))}
            />
          </div>
          <div className="form-group">
            <label>AI Receptionist Name</label>
            <input
              value={business?.ai_name || ''}
              onChange={e => setBusiness(b => ({ ...b, ai_name: e.target.value }))}
              placeholder="e.g. Sarah"
            />
          </div>
        </div>

        <div className="card-subheader">Business Hours</div>
        <div className="hours-grid">
          {DAYS.map(day => {
            const h = hours[day] || { open: '09:00', close: '18:00', closed: false };
            return (
              <div key={day} className="hours-row">
                <span className="day-label">
                  {day.charAt(0).toUpperCase() + day.slice(1)}
                </span>
                <label className="toggle-label">
                  <input
                    type="checkbox"
                    checked={!h.closed}
                    onChange={e => updateHours(day, 'closed', !e.target.checked)}
                  />
                  <span className="toggle-text">{h.closed ? 'Closed' : 'Open'}</span>
                </label>
                {!h.closed && (
                  <>
                    <input
                      type="time"
                      value={h.open}
                      className="time-input"
                      onChange={e => updateHours(day, 'open', e.target.value)}
                    />
                    <span className="time-sep">to</span>
                    <input
                      type="time"
                      value={h.close}
                      className="time-input"
                      onChange={e => updateHours(day, 'close', e.target.value)}
                    />
                  </>
                )}
              </div>
            );
          })}
        </div>

        <div className="save-row">
          {saveMsg && (
            <span className={`save-msg ${saveMsg === 'Saved!' ? 'success' : 'error'}`}>
              {saveMsg}
            </span>
          )}
          <button className="btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>

      {/* ── Services ── */}
      <div className="card">
        <div className="card-header">Services</div>
        <div className="services-list">
          {services.length === 0 && (
            <div style={{ color: '#9ca3af', fontSize: 13, padding: '8px 0' }}>
              No services yet — add your first one below.
            </div>
          )}
          {services.map(s => (
            <div key={s.id} className="service-row">
              <div className="service-info">
                <span className="service-name">{s.name}</span>
                <span className="service-meta">
                  {s.duration_minutes ? `${s.duration_minutes} min` : ''}
                  {s.duration_minutes && s.price ? ' · ' : ''}
                  {s.price ? `$${parseFloat(s.price).toFixed(0)}` : ''}
                </span>
              </div>
              <button className="btn-icon-danger" onClick={() => deleteService(s.id)}>
                Remove
              </button>
            </div>
          ))}
        </div>

        {newService === null ? (
          <div style={{ padding: '12px 24px' }}>
            <button
              className="btn-outline"
              onClick={() => setNewService({ name: '', price: '', duration_minutes: '' })}
            >
              + Add Service
            </button>
          </div>
        ) : (
          <div className="add-service-form">
            <input
              placeholder="Service name"
              value={newService.name}
              onChange={e => setNewService(s => ({ ...s, name: e.target.value }))}
              style={{ flex: 2 }}
            />
            <input
              placeholder="Price ($)"
              type="number"
              value={newService.price}
              onChange={e => setNewService(s => ({ ...s, price: e.target.value }))}
              style={{ flex: 1, minWidth: 90 }}
            />
            <input
              placeholder="Duration (min)"
              type="number"
              value={newService.duration_minutes}
              onChange={e => setNewService(s => ({ ...s, duration_minutes: e.target.value }))}
              style={{ flex: 1, minWidth: 110 }}
            />
            <button className="btn-primary" onClick={addService}>Add</button>
            <button className="btn-ghost" onClick={() => setNewService(null)}>Cancel</button>
          </div>
        )}
      </div>

      {/* ── Barbers / Team ── */}
      <div className="card">
        <div className="card-header">Your Team</div>
        <p className="card-note">
          These names are used by your AI receptionist when customers request a specific barber.
        </p>
        <div className="barbers-list">
          {barbers.map((name, i) => (
            <div key={i} className="barber-chip">
              {name}
              <button
                className="chip-remove"
                onClick={() => setBarbers(b => b.filter((_, j) => j !== i))}
              >×</button>
            </div>
          ))}
          {barbers.length === 0 && (
            <span style={{ color: '#9ca3af', fontSize: 13 }}>No team members added yet.</span>
          )}
        </div>
        <div className="add-barber-row">
          <input
            placeholder="Barber name"
            value={newBarber}
            onChange={e => setNewBarber(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && newBarber.trim()) {
                setBarbers(b => [...b, newBarber.trim()]);
                setNewBarber('');
              }
            }}
          />
          <button
            className="btn-outline"
            onClick={() => {
              if (newBarber.trim()) {
                setBarbers(b => [...b, newBarber.trim()]);
                setNewBarber('');
              }
            }}
          >
            Add
          </button>
        </div>
        <div className="save-row">
          <button className="btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Save Team'}
          </button>
        </div>
      </div>

      {/* ── AI Agent Settings ── */}
      <div className="card">
        <div className="card-header">AI Agent Settings</div>

        <div className="settings-grid">
          <div className="form-group full-width">
            <label>Call Recording</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
              <input
                type="checkbox"
                id="recordingToggle"
                checked={!!business?.call_recording_enabled}
                disabled={recordSaving}
                onChange={e => handleRecordingToggle(e.target.checked)}
                style={{ width: 16, height: 16, cursor: 'pointer', accentColor: '#534AB7' }}
              />
              <label htmlFor="recordingToggle" style={{ margin: 0, fontWeight: 400, fontSize: 14, color: '#374151', cursor: 'pointer' }}>
                Record calls for quality purposes
              </label>
            </div>
            {recordMsg && (
              <span className={`save-msg ${recordMsg.includes('updated') ? 'success' : 'error'}`} style={{ display: 'block', marginTop: 6 }}>
                {recordMsg}
              </span>
            )}
          </div>

          <div className="form-group full-width">
            <label>Supported Languages</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
              {(business?.supported_languages || ['en']).map(code => {
                const names = { en: 'English', fa: 'Farsi', ko: 'Korean' };
                return (
                  <span key={code} className="status-badge" style={{ background: '#ede9fe', color: '#534AB7', fontWeight: 600, fontSize: 13 }}>
                    {names[code] || code}
                  </span>
                );
              })}
            </div>
            <p className="card-note" style={{ marginTop: 8 }}>Configured by Bimbly. Contact support to change supported languages.</p>
          </div>
        </div>
      </div>


    </div>
  );
}

// ── Billing Page ──────────────────────────────────────────────────────────────
function BillingPage() {
  const [billing, setBilling]       = useState(null);
  const [business, setBusiness]     = useState(null);
  const [loading, setLoading]       = useState(true);
  const [showModal, setShowModal]   = useState(false);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    Promise.all([
      apiFetch('/api/billing').then(r => r.json()),
      apiFetch('/api/business').then(r => r.json()),
    ])
      .then(([bil, biz]) => {
        setBilling(bil);
        setBusiness(biz.business || biz);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const cancelSub = async () => {
    setCancelling(true);
    try {
      await apiFetch('/api/billing/cancel', { method: 'POST' });
      setBilling(b => ({ ...b, subscription_status: 'cancelling' }));
      setShowModal(false);
    } catch {}
    setCancelling(false);
  };

  if (loading) return <Spinner />;

  const statusMap = {
    trial:      { color: '#534AB7', label: 'Trial' },
    trialing:   { color: '#534AB7', label: 'Trial' },
    active:     { color: '#10b981', label: 'Active' },
    cancelling: { color: '#f59e0b', label: 'Cancelling' },
    cancelled:  { color: '#6b7280', label: 'Cancelled' },
    past_due:   { color: '#ef4444', label: 'Past Due' },
    pending:    { color: '#9ca3af', label: 'Pending' },
  };

  const PLAN_LABELS = {
    solo:    'Solo',
    starter: 'Starter',
    pro:     'Pro',
  };

  const UPGRADE_INFO = {
    solo:    { to: 'starter', label: 'Starter', price: '$99/mo', desc: 'Unlock walk-in waitlist, no-show deposits, and full analytics for up to 4 barbers.' },
    starter: { to: 'pro',     label: 'Pro',     price: '$199/mo', desc: 'Unlimited barbers, priority support, and advanced analytics.' },
    pro:     null,
  };

  const status      = billing?.subscription_status || 'unknown';
  const statusInfo  = statusMap[status] || { color: '#6b7280', label: status };
  const plan        = business?.plan || 'solo';
  const planLabel   = PLAN_LABELS[plan] || plan;
  const upgradeInfo = UPGRADE_INFO[plan];
  // Amount from API: real Stripe amount (grandfathered) or plan-derived for trial users
  const displayAmount = billing?.amount != null ? billing.amount : null;
  const isTrial = status === 'trial' || status === 'trialing';
  const displayPrice = displayAmount != null
    ? `CA$${Number(displayAmount).toFixed(2)}${isTrial ? ' (after trial ends)' : ''}`
    : '';

  const features = [
    '24/7 AI receptionist answers every call',
    'Automated SMS confirmations to customers',
    'Email notifications straight to you',
    'Google Calendar integration',
    'Online dashboard & analytics',
    'Unlimited bookings',
  ];

  const periodEnd = billing?.current_period_end
    ? new Date(billing.current_period_end * 1000).toLocaleDateString('en-CA', { month: 'long', day: 'numeric', year: 'numeric' })
    : null;

  const trialEnd = billing?.trial_end
    ? new Date(billing.trial_end * 1000).toLocaleDateString('en-CA', { month: 'long', day: 'numeric', year: 'numeric' })
    : null;

  const UPGRADE_FEATURES = {
    solo:    ['Walk-in waitlist management', 'No-show deposit collection', 'Full analytics dashboard', 'Up to 4 team members'],
    starter: ['Unlimited team members', 'Priority support', 'Advanced multi-location analytics', 'Custom AI voice & persona'],
  };

  return (
    <div className="page-content">
      {/* Current plan card */}
      <div className="card billing-card">
        <div className="billing-header">
          <div>
            <div className="billing-plan" style={{ fontSize: 22, fontWeight: 800, color: '#1f2937', marginBottom: 2 }}>
              Bimbly {planLabel}
            </div>
            <div className="billing-amount" style={{ fontSize: 28, fontWeight: 700, color: '#534AB7' }}>
              {displayAmount != null ? `CA$${Number(displayAmount).toFixed(0)}` : '—'}
              <span style={{ fontSize: 15, fontWeight: 400, color: '#6b7280' }}> / month</span>
            </div>
            {isTrial && (
              <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>after trial ends</div>
            )}
          </div>
          <span
            className="status-badge"
            style={{ background: statusInfo.color + '20', color: statusInfo.color, alignSelf: 'flex-start' }}
          >
            {statusInfo.label}
          </span>
        </div>

        {isTrial && trialEnd && (
          <div className="billing-info-row" style={{ background: '#f3f0ff', borderRadius: 8, padding: '10px 16px', margin: '0 28px 16px', fontSize: 13 }}>
            🎉 Your free trial ends <strong>{trialEnd}</strong> — no action needed, you'll be billed automatically.
          </div>
        )}
        {periodEnd && !isTrial && (
          <div className="billing-info-row">
            Next billing date: <strong>{periodEnd}</strong>
          </div>
        )}

        <div className="features-list">
          {features.map((f, i) => (
            <div key={i} className="feature-item">
              <span className="feature-check">✓</span>
              {f}
            </div>
          ))}
        </div>

        {status === 'cancelling' && (
          <div style={{ padding: '16px 28px', fontSize: 13, color: '#f59e0b' }}>
            Your subscription is set to cancel at the end of the billing period.
          </div>
        )}

        {status !== 'cancelled' && status !== 'cancelling' && (
          <div style={{ padding: '8px 28px 20px', textAlign: 'right' }}>
            <button
              style={{ background: 'none', border: 'none', color: '#9ca3af', fontSize: 12, cursor: 'pointer', textDecoration: 'underline' }}
              onClick={() => setShowModal(true)}
            >
              Cancel subscription
            </button>
          </div>
        )}
      </div>

      {/* Upgrade card */}
      {upgradeInfo && (
        <div style={{ marginTop: 20, background: '#F3F0FF', borderRadius: 12, padding: '24px 28px' }}>
          <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 1, color: '#534AB7', textTransform: 'uppercase', marginBottom: 8 }}>Ready to grow?</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 16 }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: '#1f2937', marginBottom: 4 }}>
                {upgradeInfo.label} <span style={{ color: '#534AB7' }}>{upgradeInfo.price}</span>
              </div>
              <ul style={{ margin: '10px 0 0', padding: '0 0 0 18px', fontSize: 13, color: '#374151', lineHeight: 1.8 }}>
                {(UPGRADE_FEATURES[plan] || []).map((f, i) => <li key={i}>{f}</li>)}
              </ul>
            </div>
            <a
              href={`/billing/checkout?businessId=${business?.id}&plan=${upgradeInfo.to}`}
              className="btn-primary"
              style={{ display: 'inline-block', textDecoration: 'none', alignSelf: 'center', whiteSpace: 'nowrap' }}
            >
              Upgrade Now
            </a>
          </div>
        </div>
      )}

      {plan === 'pro' && (
        <div className="card" style={{ marginTop: 16, textAlign: 'center', padding: '24px 28px' }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: '#10b981', marginBottom: 4 }}>You're on our best plan.</div>
          <div style={{ fontSize: 14, color: '#6b7280' }}>Thank you for being a Pro member!</div>
        </div>
      )}

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Cancel subscription?</div>
            <p className="modal-body">
              Your service will continue until{' '}
              <strong>{periodEnd || 'the end of the billing period'}</strong>.
              After that, your AI receptionist will stop answering calls.
            </p>
            <div className="modal-actions">
              <button className="btn-ghost" onClick={() => setShowModal(false)}>
                Keep Subscription
              </button>
              <button className="btn-danger" onClick={cancelSub} disabled={cancelling}>
                {cancelling ? 'Cancelling...' : 'Yes, Cancel'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Onboarding Page ───────────────────────────────────────────────────────────
const SERVICE_DEFAULTS = {
  'Barbershop': [
    { name: "Men's Haircut", price: '35', duration_minutes: '30' },
    { name: 'Beard Trim',    price: '20', duration_minutes: '20' },
    { name: "Kid's Haircut", price: '25', duration_minutes: '20' },
    { name: 'Shape Up',      price: '25', duration_minutes: '20' },
  ],
  'Hair Salon': [
    { name: 'Haircut',     price: '55',  duration_minutes: '45' },
    { name: 'Blowout',     price: '45',  duration_minutes: '45' },
    { name: 'Colour',      price: '120', duration_minutes: '120' },
    { name: 'Highlights',  price: '150', duration_minutes: '150' },
  ],
  'Nail Salon': [
    { name: 'Manicure',        price: '35', duration_minutes: '30' },
    { name: 'Pedicure',        price: '45', duration_minutes: '45' },
    { name: 'Gel Manicure',    price: '50', duration_minutes: '45' },
    { name: 'Acrylic Full Set',price: '65', duration_minutes: '60' },
  ],
};

const TEAM_LABEL = {
  'Barbershop': 'Who are your barbers?',
  'Hair Salon':  'Who are your stylists?',
  'Nail Salon':  'Who are your nail technicians?',
};

function OnboardingPage({ setPage }) {
  const [step, setStep]     = useState(1);
  const [saving, setSaving] = useState(false);
  const [newBarber, setNewBarber] = useState('');
  const [bizPhone, setBizPhone]   = useState(null);
  const [stepError, setStepError] = useState('');
  const [loadingData, setLoadingData] = useState(true);
  const [plan, setPlan]               = useState('solo');
  const [ownerName, setOwnerName]     = useState('');
  const [data, setData]   = useState({
    name:          '',
    phone:         '',
    address:       '',
    ai_name:       'Sarah',
    business_type: 'Barbershop',
    timezone:      'America/Toronto',
    business_hours: {},
    services:      SERVICE_DEFAULTS['Barbershop'],
    barbers:       [],
  });

  const setField = (key, val) => setData(d => ({ ...d, [key]: val }));

  // Pre-populate form with existing business data on mount
  useEffect(() => {
    const BIZ_TYPE_MAP = {
      'barbershop': 'Barbershop',
      'hair-salon': 'Hair Salon',
      'hair salon': 'Hair Salon',
      'nail-salon': 'Nail Salon',
      'nail salon': 'Nail Salon',
    };
    Promise.all([
      apiFetch('/api/business').then(r => r.json()),
      apiFetch('/api/services').then(r => r.json()),
    ])
      .then(([b, s]) => {
        const biz = b.business || b;
        const svcs = s.services || s || [];
        const bizType = BIZ_TYPE_MAP[(biz.business_type || '').toLowerCase()] || biz.business_type || 'Barbershop';
        setPlan(biz.plan || 'solo');
        setOwnerName(biz.owner_name || '');
        setData({
          name:           biz.name          || '',
          phone:          biz.phone         || '',
          address:        biz.address       || '',
          ai_name:        biz.ai_name       || 'Sarah',
          business_type:  bizType,
          timezone:       biz.timezone      || 'America/Toronto',
          business_hours: biz.business_hours || {},
          barbers:        biz.barbers && biz.barbers.length > 0
                            ? biz.barbers
                            : (biz.plan !== 'solo' && biz.owner_name ? [biz.owner_name] : []),
          services:       svcs.length > 0 ? svcs : (SERVICE_DEFAULTS[bizType] || SERVICE_DEFAULTS['Barbershop']),
        });
      })
      .catch(() => {})
      .finally(() => setLoadingData(false));
  }, []);

  // Reset services when business type changes (skip on initial mount — handled by pre-populate effect)
  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) { isFirstRender.current = false; return; }
    setData(d => ({ ...d, services: SERVICE_DEFAULTS[d.business_type] || SERVICE_DEFAULTS['Barbershop'] }));
  }, [data.business_type]);

  // Fetch actual business phone for the final step (step 3 for solo, step 4 for others)
  useEffect(() => {
    const lastStep = plan === 'solo' ? 3 : 4;
    if (step === lastStep) {
      apiFetch('/api/business')
        .then(r => r.json())
        .then(res => setBizPhone((res.business || res).phone || null))
        .catch(() => {});
    }
  }, [step, plan]);

  const updateSvc = (i, key, val) =>
    setData(d => ({
      ...d,
      services: d.services.map((s, j) => j === i ? { ...s, [key]: val } : s),
    }));

  const removeSvc = i =>
    setData(d => ({ ...d, services: d.services.filter((_, j) => j !== i) }));

  const addBarber = () => {
    if (newBarber.trim()) {
      setData(d => ({ ...d, barbers: [...d.barbers, newBarber.trim()] }));
      setNewBarber('');
    }
  };

  const complete = async () => {
    setSaving(true);
    try {
      await apiFetch('/api/business', {
        method: 'PUT',
        body: JSON.stringify({
          name:           data.name,
          phone:          data.phone,
          address:        data.address,
          ai_name:        data.ai_name,
          business_type:  data.business_type,
          timezone:       data.timezone,
          business_hours: data.business_hours,
          barbers:        data.barbers,
        }),
      });
      console.log('[complete] data.services to save:', JSON.stringify(data.services));
      await apiFetch('/api/services/replace', {
        method: 'PUT',
        body: JSON.stringify({ services: data.services }),
      });
      setPage('home');
    } catch {}
    setSaving(false);
  };

  const validate = (stepNum) => {
    if (stepNum === 1) {
      if (!data.name.trim()) return 'Business Name is required.';
      if (!data.phone.trim()) return 'Business Phone is required.';
      if (!data.business_type) return 'Business Type is required.';
      if (!data.timezone) return 'Timezone is required.';
    }
    if (stepNum === 2) {
      if (data.services.length === 0) return 'Add at least one service.';
      for (const svc of data.services) {
        if (!svc.name.trim()) return 'Each service must have a name.';
        if (!svc.price) return 'Each service must have a price.';
      }
    }
    return '';
  };

  if (loadingData) return <Spinner />;

  return (
    <div className="onboarding-wrap">
      <div className="onboarding-card">
        <div className="step-indicator">
          {(plan === 'solo' ? [1, 2, 3] : [1, 2, 3, 4]).map(s => (
            <div key={s} className={`step-dot ${s === step ? 'active' : s < step ? 'done' : ''}`}>
              {s < step ? '✓' : s}
            </div>
          ))}
        </div>

        {/* Step 1 */}
        {step === 1 && (
          <div className="step-content">
            <h2>Let's set up your AI receptionist</h2>
            <p className="step-sub">Tell us about your business so we can personalize your AI.</p>
            <div className="form-group">
              <label>Business Name</label>
              <input
                value={data.name}
                onChange={e => setField('name', e.target.value)}
                placeholder="Sam's Barbershop"
              />
            </div>
            <div className="form-group">
              <label>Business Phone</label>
              <input
                value={data.phone}
                onChange={e => setField('phone', e.target.value)}
                placeholder="+1 (416) 555-0000"
              />
            </div>
            <div className="form-group">
              <label>Address</label>
              <input
                value={data.address}
                onChange={e => setField('address', e.target.value)}
                placeholder="123 Main St, Toronto, ON"
              />
            </div>
            <div className="form-group">
              <label>AI Receptionist Name</label>
              <input
                value={data.ai_name}
                onChange={e => setField('ai_name', e.target.value)}
                placeholder="Sarah"
              />
            </div>
            <div className="form-group">
              <label>Business Type</label>
              <select value={data.business_type} onChange={e => setField('business_type', e.target.value)}>
                <option value="Barbershop">Barbershop</option>
                <option value="Hair Salon">Hair Salon</option>
                <option value="Nail Salon">Nail Salon</option>
              </select>
            </div>
            <div className="form-group">
              <label>Your Timezone</label>
              <select value={data.timezone} onChange={e => setField('timezone', e.target.value)}>
                <option value="America/Toronto">Eastern Time (Toronto)</option>
                <option value="America/Vancouver">Pacific Time (Vancouver)</option>
                <option value="America/Edmonton">Mountain Time (Calgary)</option>
                <option value="America/Winnipeg">Central Time (Winnipeg)</option>
                <option value="America/Halifax">Atlantic Time (Halifax)</option>
              </select>
            </div>
          </div>
        )}

        {/* Step 2 */}
        {step === 2 && (
          <div className="step-content">
            <h2>What services do you offer?</h2>
            <p className="step-sub">
              Add your services so customers can book the right appointment.
            </p>
            {data.services.map((svc, i) => (
              <div key={i} className="svc-row">
                <input
                  placeholder="Service name"
                  value={svc.name}
                  onChange={e => updateSvc(i, 'name', e.target.value)}
                />
                <input
                  placeholder="$ Price"
                  type="number"
                  value={svc.price}
                  style={{ width: 90 }}
                  onChange={e => updateSvc(i, 'price', e.target.value)}
                />
                <button className="btn-ghost" style={{ height: 40, padding: '0 12px' }} onClick={() => removeSvc(i)}>×</button>
              </div>
            ))}
            <button
              className="btn-outline"
              style={{ marginTop: 8 }}
              onClick={() => setData(d => ({
                ...d,
                services: [...d.services, { name: '', price: '', duration_minutes: '30' }],
              }))}
            >
              + Add Service
            </button>
          </div>
        )}

        {/* Step 3 — team (solo skips this, goes to step 3 = final/forwarding) */}
        {step === 3 && plan !== 'solo' && (
          <div className="step-content">
            <h2>{TEAM_LABEL[data.business_type] || 'Who is your team?'}</h2>
            <p className="step-sub">
              Customers can request a specific team member when they call.
              {plan === 'starter' && <span style={{ display: 'block', fontSize: 12, color: '#9ca3af', marginTop: 4 }}>Starter plan includes up to 4 team members.</span>}
            </p>
            <div className="barbers-list" style={{ marginBottom: 16 }}>
              {data.barbers.map((name, i) => (
                <div key={i} className="barber-chip">
                  {name}
                  {/* Prevent removing the owner (index 0) */}
                  {i > 0 && (
                    <button
                      className="chip-remove"
                      onClick={() => setData(d => ({ ...d, barbers: d.barbers.filter((_, j) => j !== i) }))}
                    >×</button>
                  )}
                </div>
              ))}
              {data.barbers.length === 0 && (
                <span style={{ color: '#9ca3af', fontSize: 13 }}>No team members yet.</span>
              )}
            </div>
            {(plan === 'pro' || data.barbers.length < 4) && (
              <div className="add-barber-row" style={{ padding: 0 }}>
                <input
                  placeholder="Name"
                  value={newBarber}
                  onChange={e => setNewBarber(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addBarber()}
                />
                <button className="btn-outline" onClick={addBarber}>Add</button>
              </div>
            )}
            {plan === 'starter' && data.barbers.length >= 4 && (
              <p style={{ fontSize: 12, color: '#9ca3af', marginTop: 8 }}>Team member limit reached for Starter plan.</p>
            )}
          </div>
        )}

        {/* Step 3 (solo) = forwarding step */}

        {/* Step 4 (or step 3 for solo) */}
        {((plan === 'solo' && step === 3) || (plan !== 'solo' && step === 4)) && (
          <div className="step-content">
            <h2>You're almost live!</h2>
            <p className="step-sub">
              Forward your business phone number to your Bimbly number to start receiving bookings.
            </p>
            <div className="forward-box">
              <div className="forward-label">Your Bimbly Number</div>
              <div className="forward-number">{bizPhone || '...'}</div>
            </div>
            <div className="instructions">
              <div className="instr-title">iPhone</div>
              <ol>
                <li>Go to <strong>Settings → Phone → Call Forwarding</strong></li>
                <li>Turn on <strong>Call Forwarding</strong></li>
                <li>Enter your Bimbly number above</li>
              </ol>
              <div className="instr-title" style={{ marginTop: 20 }}>Android</div>
              <ol>
                <li>Open <strong>Phone app → Settings → Calls</strong></li>
                <li>Tap <strong>Call forwarding → Always forward</strong></li>
                <li>Enter your Bimbly number above</li>
              </ol>
            </div>
          </div>
        )}

        {stepError && (
          <div style={{ color: '#ef4444', fontSize: 13, padding: '8px 0 0', marginTop: 4 }}>{stepError}</div>
        )}

        <div className="step-actions">
          {step > 1 && (
            <button className="btn-ghost" onClick={() => {
              setStepError('');
              // Solo: back from step 3 goes to step 2 (skipping team step)
              setStep(s => s - 1);
            }}>Back</button>
          )}
          {((plan === 'solo' && step < 3) || (plan !== 'solo' && step < 4)) && (
            <button className="btn-primary" onClick={() => {
              const err = validate(step);
              if (err) { setStepError(err); return; }
              setStepError('');
              // Solo: jump from step 2 to step 3 (forwarding), skip team step
              setStep(s => s + 1);
            }}>
              Continue →
            </button>
          )}
          {((plan === 'solo' && step === 3) || (plan !== 'solo' && step === 4)) && (
            <button className="btn-primary" onClick={complete} disabled={saving}>
              {saving ? 'Setting up...' : "I've forwarded my number →"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────
function App() {
  const [authed, setAuthed]     = useState(false);
  const [page, setPage]         = useState('home');
  const [business, setBusiness] = useState(null);

  useEffect(() => {
    // Pick up token from URL (sent by OAuth callback)
    const params   = new URLSearchParams(window.location.search);
    const urlToken = params.get('token');
    if (urlToken) {
      localStorage.setItem('bimbly_token', urlToken);
      const url = new URL(window.location.href);
      url.searchParams.delete('token');
      window.history.replaceState({}, '', url);
    }

    const token = localStorage.getItem('bimbly_token');
    if (!token) {
      window.location.href = API_BASE + '/auth/dashboard/google';
      return;
    }

    setAuthed(true);

    apiFetch('/api/business')
      .then(r => r.json())
      .then(data => setBusiness(data.business || data))
      .catch(() => {});
  }, []);

  if (!authed) {
    return (
      <div className="loading-screen">
        <div className="spinner"></div>
      </div>
    );
  }

  const titles = {
    home:        'Dashboard',
    bookings:    'Bookings',
    settings:    'Settings',
    billing:     'Billing',
    onboarding:  'Setup',
  };

  return (
    <div className="app-layout">
      <Sidebar page={page} setPage={setPage} business={business} />
      <div className="main-area">
        <TopBar title={titles[page] || 'Dashboard'} />
        <div className="content-area">
          {page === 'home'       && <DashboardHome />}
          {page === 'bookings'   && <BookingsPage />}
          {page === 'settings'   && <SettingsPage />}
          {page === 'billing'    && <BillingPage />}
          {page === 'onboarding' && <OnboardingPage setPage={setPage} />}
        </div>
      </div>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
