'use strict';

const { useState, useEffect, useCallback, useRef } = React;

const API_BASE = 'https://bookingagent-gmo2.onrender.com';

// ── API helper ────────────────────────────────────────────────────────────────
async function apiFetch(path, options = {}) {
  const token = localStorage.getItem('bimbly_token');
  const isFormData = options.body instanceof FormData;
  const res = await fetch(API_BASE + path, {
    ...options,
    headers: {
      ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
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
    { id: 'queue',     label: 'Walk-in Queue', icon: '🪑' },
    { id: 'clients',   label: 'Clients',   icon: '👤' },
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
// ── DepositBadge ─────────────────────────────────────────────────────────────
function DepositBadge({ status }) {
  if (!status || status === 'none') return null;
  const styles = {
    pending:  { background: '#fef3c7', color: '#92400e', label: 'Deposit Pending' },
    secured:  { background: '#d1fae5', color: '#065f46', label: 'Secured' },
    charged:  { background: '#fee2e2', color: '#991b1b', label: 'Charged' },
    waived:   { background: '#f3f4f6', color: '#6b7280', label: 'Waived' },
  };
  const s = styles[status];
  if (!s) return null;
  return (
    <span className="status-badge" style={{ background: s.background, color: s.color, fontWeight: 600, fontSize: 12 }}>
      {s.label}
    </span>
  );
}

function BookingsTable({ bookings, clients = [], onClientClick, onDepositAction }) {
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
            <th>Team Member</th>
            <th>Special Requests</th>
            <th>Status</th>
            <th>Deposit</th>
          </tr>
        </thead>
        <tbody>
          {bookings.map(b => (
            <tr key={b.id}>
              <td>
                <div
                  className="cell-name"
                  style={onClientClick && b.customer_phone ? { color: '#6366f1', textDecoration: 'underline', cursor: 'pointer' } : {}}
                  onClick={() => {
                    if (!onClientClick || !b.customer_phone) return;
                    const match = clients.find(c => c.phone === b.customer_phone);
                    onClientClick(match ? match.id : null, b.customer_phone);
                  }}
                >
                  {String(b.customer_name || '—')}
                </div>
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
              <td>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <DepositBadge status={b.deposit_status} />
                  {b.deposit_status === 'secured' && onDepositAction && (
                    <div style={{ display: 'flex', gap: 4, marginTop: 2 }}>
                      <button
                        className="btn-outline"
                        style={{ fontSize: 12, padding: '2px 8px', color: '#dc2626', borderColor: '#dc2626' }}
                        onClick={() => {
                          if (confirm(`Charge $${(b.deposit_amount_cents || 0) / 100 || 'deposit'} deposit for no-show?`)) {
                            onDepositAction(b.id, 'no-show');
                          }
                        }}
                      >
                        No-Show
                      </button>
                      <button
                        className="btn-outline"
                        style={{ fontSize: 12, padding: '2px 8px' }}
                        onClick={() => onDepositAction(b.id, 'waive')}
                      >
                        Waive
                      </button>
                    </div>
                  )}
                </div>
              </td>
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
  const [queue, setQueue] = useState([]);

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

  // Independent queue poll — runs regardless of analytics load state
  useEffect(() => {
    const fetchQueue = () => {
      apiFetch('/api/queue')
        .then(r => r.json())
        .then(d => setQueue(d.queue || []))
        .catch(() => {});
    };
    fetchQueue();
    const interval = setInterval(fetchQueue, 30000);
    return () => clearInterval(interval);
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

      {queue.length > 0 && (
        <div className="card">
          <div className="card-header">
            Walk-in Queue
            <span className="status-badge" style={{ background: '#fef3c7', color: '#92400e', marginLeft: 10 }}>
              {queue.length} waiting
            </span>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr><th>#</th><th>Name</th><th>Service</th><th>Waited</th><th>Status</th></tr>
              </thead>
              <tbody>
                {queue.map(entry => {
                  const waited = Math.floor((Date.now() - new Date(entry.created_at).getTime()) / 60000);
                  return (
                    <tr key={entry.id}>
                      <td style={{ fontWeight: 700, color: '#534AB7' }}>{entry.position}</td>
                      <td>{entry.customer_name}</td>
                      <td>{entry.service || '—'}</td>
                      <td style={{ color: waited > 20 ? '#ef4444' : '#374151' }}>{waited}m</td>
                      <td>
                        <span className="status-badge" style={{
                          background: entry.status === 'notified' ? '#d1fae5' : '#fef3c7',
                          color: entry.status === 'notified' ? '#065f46' : '#92400e',
                        }}>
                          {entry.status === 'notified' ? 'Notified' : 'Waiting'}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-header">Recent Bookings</div>
        <BookingsTable bookings={bookings} />
      </div>
    </div>
  );
}

// ── Bookings Page ─────────────────────────────────────────────────────────────
function BookingsPage({ clients = [], setPage }) {
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('month');

  const handleDepositAction = async (bookingId, action) => {
    const endpoint = action === 'no-show' ? 'no-show' : 'waive-deposit';
    try {
      const res = await apiFetch(`/api/bookings/${bookingId}/${endpoint}`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) { alert(data.error || 'Action failed.'); return; }
      setBookings(bs => bs.map(b => b.id === bookingId ? data.booking : b));
    } catch { alert('Action failed. Please try again.'); }
  };

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
        {loading ? <Spinner /> : (
          <BookingsTable
            bookings={bookings}
            clients={clients}
            onDepositAction={handleDepositAction}
            onClientClick={(clientId, phone) => {
              if (clientId) {
                window._clientProfileId = clientId;
                setPage('client-profile');
              } else {
                window._clientsSearch = phone;
                setPage('clients');
              }
            }}
          />
        )}
      </div>
    </div>
  );
}

// ── WalkInQueueSettings ───────────────────────────────────────────────────────
function WalkInQueueSettings({ business, setBusiness }) {
  const [saving, setSaving]     = useState(false);
  const [msg, setMsg]           = useState('');
  const [qrUrl, setQrUrl]       = useState(null);
  const qrBlobRef               = useRef(null);

  // Load QR when queue_enabled is true
  useEffect(() => {
    if (!business?.queue_enabled) return;
    apiFetch('/api/queue/qr')
      .then(r => r.blob())
      .then(blob => {
        // Revoke previous blob URL to avoid memory leaks
        if (qrBlobRef.current) URL.revokeObjectURL(qrBlobRef.current);
        const url = URL.createObjectURL(blob);
        qrBlobRef.current = url;
        setQrUrl(url);
      })
      .catch(() => {});
    return () => {
      if (qrBlobRef.current) {
        URL.revokeObjectURL(qrBlobRef.current);
        qrBlobRef.current = null;
      }
    };
  }, [business?.queue_enabled]);

  const handleSave = async () => {
    setSaving(true); setMsg('');
    try {
      await apiFetch('/api/business', {
        method: 'PUT',
        body: JSON.stringify({
          queue_enabled:        business.queue_enabled,
          queue_notify_timeout: parseInt(business.queue_notify_timeout || 10, 10),
        }),
      });
      setMsg('Saved!');
      setTimeout(() => setMsg(''), 2500);
    } catch {
      setMsg('Failed to save.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card">
      <div className="card-header">Walk-in Queue</div>
      <div className="settings-grid">
        <div className="form-group full-width">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
            <input
              type="checkbox"
              id="queueToggle"
              checked={!!business?.queue_enabled}
              onChange={e => setBusiness(b => ({ ...b, queue_enabled: e.target.checked }))}
              style={{ width: 16, height: 16, cursor: 'pointer', accentColor: '#534AB7' }}
            />
            <label htmlFor="queueToggle" style={{ margin: 0, fontWeight: 400, fontSize: 14, color: '#374151', cursor: 'pointer' }}>
              Enable walk-in queue (QR code check-in)
            </label>
          </div>
        </div>

        {business?.queue_enabled && (
          <>
            <div className="form-group">
              <label>No-show timeout (minutes)</label>
              <input
                type="number"
                min="1"
                max="60"
                step="1"
                value={business?.queue_notify_timeout ?? 10}
                onChange={e => setBusiness(b => ({ ...b, queue_notify_timeout: parseInt(e.target.value) || 10 }))}
                style={{ width: 120 }}
              />
              <p style={{ fontSize: 12, color: '#9ca3af', margin: '4px 0 0' }}>
                Customers are auto-marked no-show this many minutes after being notified.
              </p>
            </div>

            <div className="form-group full-width">
              <label>Walk-in QR Code</label>
              {qrUrl ? (
                <div style={{ marginTop: 8 }}>
                  <img src={qrUrl} alt="Walk-in queue QR code" style={{ width: 180, height: 180, display: 'block', marginBottom: 10 }} />
                  <a
                    href={qrUrl}
                    download="walkin-qr.png"
                    className="btn-outline"
                    style={{ fontSize: 13, display: 'inline-block', textDecoration: 'none' }}
                  >
                    Download QR
                  </a>
                </div>
              ) : (
                <div style={{ color: '#9ca3af', fontSize: 13, marginTop: 6 }}>Loading QR code...</div>
              )}
            </div>
          </>
        )}
      </div>
      <div className="save-row">
        <button className="btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save Queue Settings'}
        </button>
        {msg && (
          <span className={`save-msg ${msg === 'Saved!' ? 'success' : 'error'}`}>{msg}</span>
        )}
      </div>
    </div>
  );
}

// ── Settings Page ─────────────────────────────────────────────────────────────
const DAYS = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];

function SettingsPage({ setPage }) {
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
  const [depositSaving, setDepositSaving] = useState(false);
  const [depositMsg, setDepositMsg]       = useState('');
  const [logoUploading, setLogoUploading] = useState(false);
  const [logoMsg, setLogoMsg]             = useState('');
  const recordDebounceRef = useRef(null);

  useEffect(() => {
    Promise.all([
      apiFetch('/api/business').then(r => r.json()),
      apiFetch('/api/services').then(r => r.json()),
    ])
      .then(([b, s]) => {
        const biz = b.business || b;
        setBusiness({ ...biz, deposit_amount_display: biz.deposit_amount != null ? biz.deposit_amount / 100 : 25 });
        setServices(s.services || s || []);
        setBarbers((biz.team_members || biz.barbers || []).map(b => typeof b === 'string' ? { name: b, role: '', calendarId: '' } : { role: '', calendarId: '', ...b }));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setSaveMsg('');
    try {
      const normalizedHours = {};
      DAYS.forEach(day => {
        normalizedHours[day] = business.business_hours?.[day] || { open: '09:00', close: '18:00', closed: false };
      });
      await apiFetch('/api/business', {
        method: 'PUT',
        body: JSON.stringify({
          name:           business.name,
          phone:          business.phone,
          address:        business.address,
          business_hours: normalizedHours,
          ai_name:        business.ai_name,
          team_members:   barbers,
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

  const handleDepositSave = async () => {
    setDepositSaving(true);
    setDepositMsg('');
    try {
      await apiFetch('/api/business', {
        method: 'PUT',
        body: JSON.stringify({
          deposit_enabled: business.deposit_enabled,
          deposit_amount:  Math.round((business.deposit_amount_display || 0) * 100),
        }),
      });
      setBusiness(b => ({ ...b, deposit_amount: Math.round((b.deposit_amount_display || 0) * 100) }));
      setDepositMsg('Saved!');
      setTimeout(() => setDepositMsg(''), 2500);
    } catch {
      setDepositMsg('Failed to save.');
    } finally {
      setDepositSaving(false);
    }
  };

  const handleLogoUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setLogoUploading(true);
    setLogoMsg('');
    try {
      const form = new FormData();
      form.append('logo', file);
      const res = await apiFetch('/api/business/logo', { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) { setLogoMsg(data.error || 'Upload failed.'); return; }
      setBusiness(b => ({ ...b, logo_url: data.logo_url }));
      setLogoMsg('Logo uploaded!');
      setTimeout(() => setLogoMsg(''), 2500);
    } catch {
      setLogoMsg('Upload failed.');
    } finally {
      setLogoUploading(false);
      e.target.value = '';
    }
  };

  const handleLogoDelete = async () => {
    setLogoUploading(true);
    setLogoMsg('');
    try {
      await apiFetch('/api/business/logo', { method: 'DELETE' });
      setBusiness(b => ({ ...b, logo_url: null }));
      setLogoMsg('Logo removed.');
      setTimeout(() => setLogoMsg(''), 2500);
    } catch {
      setLogoMsg('Failed to remove logo.');
    } finally {
      setLogoUploading(false);
    }
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

      {/* ── Your Booking Page ── */}
      <div className="card">
        <div className="card-header">Your Booking Page</div>
        {business.booking_slug ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 10, padding: '10px 14px', marginBottom: 14 }}>
            <span style={{ flex: 1, fontSize: 14, color: '#374151', wordBreak: 'break-all' }}>
              {window.location.origin}/book/{business.booking_slug}
            </span>
            <button
              onClick={() => navigator.clipboard.writeText(`${window.location.origin}/book/${business.booking_slug}`)}
              style={{ padding: '6px 12px', background: '#534AB7', color: '#fff', border: 'none', borderRadius: 6, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' }}
            >Copy link</button>
            <a href={`/book/${business.booking_slug}`} target="_blank" rel="noopener noreferrer"
              style={{ padding: '6px 12px', background: '#f3f4f6', color: '#374151', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 13, textDecoration: 'none', whiteSpace: 'nowrap' }}>
              Open ↗
            </a>
          </div>
        ) : (
          <p style={{ fontSize: 14, color: '#6b7280', marginBottom: 14 }}>
            Set a slug below to activate your public booking page.
          </p>
        )}
        <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Booking page slug</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="text"
            id="slugInput"
            defaultValue={business.booking_slug || ''}
            placeholder="e.g. sams-barbershop"
            style={{ flex: 1, padding: '10px 12px', border: '1.5px solid #e5e7eb', borderRadius: 10, fontSize: 15 }}
          />
          <button
            onClick={async () => {
              const slug = document.getElementById('slugInput').value.trim().toLowerCase();
              const res = await fetch('/api/business/slug', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('bimbly_token')}` },
                body: JSON.stringify({ slug }),
              });
              const data = await res.json();
              if (!res.ok) { alert(data.error || 'Failed to save.'); }
              else { setBusiness(b => ({ ...b, booking_slug: data.business.booking_slug })); }
            }}
            style={{ padding: '10px 16px', background: '#534AB7', color: '#fff', border: 'none', borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: 'pointer' }}
          >Save</button>
        </div>
        <p style={{ fontSize: 12, color: '#9ca3af', marginTop: 4 }}>Lowercase letters, numbers, and hyphens only.</p>
      </div>

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
              placeholder="e.g. Alex"
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

      {/* ── Team Members ── */}
      {(() => {
        const bizType = (business?.business_type || '').toLowerCase();
        const memberWord = bizType.includes('barber') ? 'barbers'
          : bizType.includes('hair') ? 'stylists'
          : bizType.includes('nail') ? 'technicians'
          : 'team members';
        const roleOptions = bizType.includes('barber')
          ? ['Barber', 'Apprentice', 'Manager']
          : bizType.includes('hair')
          ? ['Stylist', 'Colorist', 'Apprentice', 'Manager']
          : bizType.includes('nail')
          ? ['Technician', 'Apprentice', 'Manager']
          : ['Team Member', 'Manager'];
        const plan = business?.plan || 'solo';
        const maxMembers = plan === 'pro' ? Infinity : plan === 'starter' ? 4 : 1;
        const atLimit = barbers.length >= maxMembers;
        const upgradeMsg = plan === 'solo'
          ? 'Upgrade to Starter to add more team members'
          : plan === 'starter'
          ? 'Upgrade to Pro to add more team members'
          : null;
        return (
          <div className="card">
            <div className="card-header">Team Members</div>
            <p className="card-note">
              These names are used by your AI receptionist when customers request a specific {memberWord.slice(0, -1)}.
            </p>
            <div className="barbers-list">
              {barbers.map((barber, i) => (
                <div key={i} style={{ marginBottom: 12 }}>
                  <div className="barber-chip" style={{ marginBottom: 4 }}>
                    {barber.name}{i === 0 && <span style={{ fontSize: 11, color: '#9ca3af', marginLeft: 4 }}>(you)</span>}
                    {barber.role && <span style={{ fontSize: 11, background: '#ede9fe', color: '#6d28d9', borderRadius: 4, padding: '1px 6px', marginLeft: 6 }}>{barber.role}</span>}
                    {i !== 0 && (
                      <button
                        className="chip-remove"
                        onClick={() => setBarbers(b => b.filter((_, j) => j !== i))}
                      >×</button>
                    )}
                  </div>
                  <select
                    value={barber.role || ''}
                    onChange={e => setBarbers(b => b.map((x, j) => j === i ? { ...x, role: e.target.value } : x))}
                    style={{ fontSize: 12, padding: '5px 10px', border: '1px solid #e5e7eb', borderRadius: 6, width: '100%', color: '#374151', marginBottom: 4 }}
                  >
                    <option value="">Role (optional)</option>
                    {roleOptions.map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                  <input
                    type="text"
                    placeholder="Google Calendar ID (optional, e.g. name@gmail.com)"
                    value={barber.calendarId || ''}
                    onChange={e => setBarbers(b => b.map((x, j) => j === i ? { ...x, calendarId: e.target.value } : x))}
                    style={{ fontSize: 12, padding: '5px 10px', border: '1px solid #e5e7eb', borderRadius: 6, width: '100%', color: '#6b7280' }}
                  />
                </div>
              ))}
              {barbers.length === 0 && (
                <span style={{ color: '#9ca3af', fontSize: 13 }}>No {memberWord} added yet.</span>
              )}
            </div>
            {atLimit ? (
              upgradeMsg && <p className="card-note" style={{ marginTop: 10, color: '#9ca3af' }}>
                {upgradeMsg}. <a href="#" onClick={e => { e.preventDefault(); setPage('billing'); }} style={{ color: '#534ab7' }}>Upgrade your plan →</a>
              </p>
            ) : (
              <div className="add-barber-row">
                <input
                  placeholder="Team member name"
                  value={newBarber}
                  onChange={e => setNewBarber(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && newBarber.trim()) {
                      setBarbers(b => [...b, { name: newBarber.trim(), role: '', calendarId: '' }]);
                      setNewBarber('');
                    }
                  }}
                />
                <button
                  className="btn-outline"
                  onClick={() => {
                    if (newBarber.trim()) {
                      setBarbers(b => [...b, { name: newBarber.trim(), role: '', calendarId: '' }]);
                      setNewBarber('');
                    }
                  }}
                >
                  Add
                </button>
              </div>
            )}
            <div className="save-row">
              <button className="btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving...' : 'Save Team Members'}
              </button>
            </div>
          </div>
        );
      })()}

      {/* ── Logo ── */}
      {(() => {
        const plan = business?.plan || 'solo';
        return (
          <div className="card">
            <div className="card-header">Booking Page Logo</div>
            {plan === 'solo' ? (
              <p style={{ color: '#6B7280', fontSize: 14, margin: '12px 0' }}>
                Logo upload is available on the Starter plan and above.{' '}
                <a href="#" onClick={e => { e.preventDefault(); setPage('billing'); }} style={{ color: '#534AB7' }}>
                  Upgrade to Starter
                </a>
              </p>
            ) : (
              <div className="settings-grid">
                <div className="form-group full-width">
                  {business?.logo_url && (
                    <div style={{ marginBottom: 12 }}>
                      <img src={business.logo_url} alt="Business logo" style={{ maxHeight: 80, maxWidth: 240, borderRadius: 6, border: '1px solid #e5e7eb', objectFit: 'contain' }} />
                    </div>
                  )}
                  <input
                    type="file"
                    accept="image/png,image/jpeg"
                    onChange={handleLogoUpload}
                    disabled={logoUploading}
                    style={{ fontSize: 14 }}
                  />
                  <p style={{ color: '#6B7280', fontSize: 12, marginTop: 6 }}>PNG or JPG, max 2MB. Displayed at the top of your public booking page.</p>
                  {business?.logo_url && (
                    <button
                      className="btn-danger"
                      style={{ marginTop: 8 }}
                      onClick={handleLogoDelete}
                      disabled={logoUploading}
                    >
                      Remove Logo
                    </button>
                  )}
                  {logoMsg && (
                    <span className={`save-msg ${logoMsg.includes('!') ? 'success' : logoMsg.includes('removed') ? 'success' : 'error'}`} style={{ marginLeft: 8 }}>{logoMsg}</span>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {/* ── Export Data ── */}
      {(() => {
        const plan = business?.plan || 'solo';
        return (
          <div className="card">
            <div className="card-header">Export Data</div>
            {plan === 'solo' ? (
              <div style={{ color: '#6B7280', fontSize: 14 }}>
                <p style={{ margin: '0 0 12px' }}>Export your bookings and client data as CSV. Available on Starter and Pro plans.</p>
                <a href="#" onClick={e => { e.preventDefault(); setPage('billing'); }} className="btn-primary" style={{ display: 'inline-block', opacity: 0.7 }}>
                  Upgrade to Starter
                </a>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 4 }}>
                <a
                  href={`${typeof API_BASE !== 'undefined' ? API_BASE : ''}/api/export/bookings`}
                  onClick={e => {
                    e.preventDefault();
                    const token = localStorage.getItem('bimbly_token');
                    fetch((typeof API_BASE !== 'undefined' ? API_BASE : '') + '/api/export/bookings', {
                      headers: { Authorization: `Bearer ${token}` },
                    }).then(r => r.blob()).then(blob => {
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = 'bookings.csv';
                      a.click();
                      URL.revokeObjectURL(url);
                    });
                  }}
                  className="btn-primary"
                  style={{ display: 'inline-block' }}
                >
                  Export Bookings (CSV)
                </a>
                <a
                  href="#"
                  onClick={e => {
                    e.preventDefault();
                    const token = localStorage.getItem('bimbly_token');
                    fetch((typeof API_BASE !== 'undefined' ? API_BASE : '') + '/api/export/clients', {
                      headers: { Authorization: `Bearer ${token}` },
                    }).then(r => r.blob()).then(blob => {
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = 'clients.csv';
                      a.click();
                      URL.revokeObjectURL(url);
                    });
                  }}
                  className="btn-primary"
                  style={{ display: 'inline-block' }}
                >
                  Export Clients (CSV)
                </a>
              </div>
            )}
          </div>
        );
      })()}

      {/* ── No-Show Deposits ── */}
      <div className="card">
        <div className="card-header">No-Show Deposits</div>
        <div className="settings-grid">
          <div className="form-group full-width">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
              <input
                type="checkbox"
                id="depositToggle"
                checked={!!business?.deposit_enabled}
                onChange={e => setBusiness(b => ({ ...b, deposit_enabled: e.target.checked }))}
                style={{ width: 16, height: 16, cursor: 'pointer', accentColor: '#534AB7' }}
              />
              <label htmlFor="depositToggle" style={{ margin: 0, fontWeight: 400, fontSize: 14, color: '#374151', cursor: 'pointer' }}>
                Require a deposit to secure bookings
              </label>
            </div>
          </div>
          {business?.deposit_enabled && (
            <div className="form-group">
              <label>Deposit Amount (CA$)</label>
              <input
                type="number"
                min="1"
                step="1"
                value={business?.deposit_amount_display ?? 25}
                onChange={e => setBusiness(b => ({ ...b, deposit_amount_display: parseFloat(e.target.value) || 0 }))}
                style={{ width: 120 }}
              />
            </div>
          )}
        </div>
        <div className="save-row">
          <button className="btn-primary" onClick={handleDepositSave} disabled={depositSaving}>
            {depositSaving ? 'Saving...' : 'Save Deposit Settings'}
          </button>
          {depositMsg && (
            <span className={`save-msg ${depositMsg === 'Saved!' ? 'success' : 'error'}`}>{depositMsg}</span>
          )}
        </div>
      </div>

      {/* ── Walk-in Queue ── */}
      <WalkInQueueSettings business={business} setBusiness={setBusiness} />

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
    solo:    { to: 'starter', label: 'Starter', price: '$99/mo', desc: 'Unlock full analytics and add up to 4 team members.' },
    starter: { to: 'pro',     label: 'Pro',     price: '$199/mo', desc: 'Unlimited team members, priority support, and advanced analytics.' },
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

  const CARD_STYLE = {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    border: '1px solid #e5e7eb',
    borderRadius: 12,
    padding: '24px',
    minHeight: 380,
    background: '#fff',
  };

  return (
    <div className="page-content">
      <style>{`@media(max-width:768px){.billing-row{flex-direction:column!important;}}`}</style>

      <div className="billing-row" style={{ display: 'flex', gap: 24, alignItems: 'stretch', maxWidth: 900, margin: '0 auto' }}>

        {/* Left: Current plan card */}
        <div style={CARD_STYLE}>
          {/* Header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
            <div>
              <div style={{ fontSize: 22, fontWeight: 800, color: '#1f2937', marginBottom: 2 }}>
                Bimbly {planLabel}
              </div>
              <div style={{ fontSize: 28, fontWeight: 700, color: '#534AB7' }}>
                {displayAmount != null ? `CA$${Number(displayAmount).toFixed(0)}` : '—'}
                <span style={{ fontSize: 15, fontWeight: 400, color: '#6b7280' }}> / month</span>
              </div>
              {isTrial && (
                <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>after trial ends</div>
              )}
            </div>
            <span className="status-badge" style={{ background: statusInfo.color + '20', color: statusInfo.color }}>
              {statusInfo.label}
            </span>
          </div>

          {isTrial && trialEnd && (
            <div style={{ background: '#f3f0ff', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 13 }}>
              🎉 Your free trial ends <strong>{trialEnd}</strong> — you'll be billed automatically.
            </div>
          )}
          {periodEnd && !isTrial && (
            <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 16 }}>
              Next billing date: <strong>{periodEnd}</strong>
            </div>
          )}

          {/* Features */}
          <div style={{ flex: 1 }}>
            {features.map((f, i) => (
              <div key={i} className="feature-item">
                <span className="feature-check">✓</span>
                {f}
              </div>
            ))}
          </div>

          {/* Footer */}
          <div style={{ marginTop: 20 }}>
            {status === 'cancelling' && (
              <div style={{ fontSize: 13, color: '#f59e0b' }}>
                Subscription cancels at end of billing period.
              </div>
            )}
            {status !== 'cancelled' && status !== 'cancelling' && (
              <button
                style={{ background: 'none', border: 'none', color: '#9ca3af', fontSize: 12, cursor: 'pointer', textDecoration: 'underline', padding: 0 }}
                onClick={() => setShowModal(true)}
              >
                Cancel subscription
              </button>
            )}
          </div>
        </div>

        {/* Right: Upgrade card or Pro message */}
        {upgradeInfo ? (
          <div style={{ ...CARD_STYLE, background: '#F3F0FF', border: '1px solid #e5e7eb' }}>
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 22, fontWeight: 800, color: '#1f2937', marginBottom: 2 }}>
                Bimbly {upgradeInfo.label}
              </div>
              <div style={{ fontSize: 28, fontWeight: 700, color: '#534AB7' }}>
                {upgradeInfo.price}
                <span style={{ fontSize: 15, fontWeight: 400, color: '#6b7280' }}> / month</span>
              </div>
            </div>

            <ul style={{ flex: 1, margin: '0', padding: '0 0 0 18px', fontSize: 14, color: '#374151', lineHeight: 2 }}>
              {(UPGRADE_FEATURES[plan] || []).map((f, i) => <li key={i}>{f}</li>)}
            </ul>

            <div style={{ marginTop: 'auto', paddingTop: 24 }}>
              <button
                className="btn-primary"
                style={{ width: '100%' }}
                onClick={() => window.location.href = `/billing/checkout?businessId=${business?.id}&plan=${upgradeInfo.to}`}
              >
                Upgrade Now
              </button>
            </div>
          </div>
        ) : (
          <div style={{ ...CARD_STYLE, background: '#F3F0FF', border: '1px solid #e5e7eb', justifyContent: 'center', alignItems: 'center', textAlign: 'center' }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#10b981', marginBottom: 8 }}>You're on our best plan.</div>
            <div style={{ fontSize: 14, color: '#6b7280' }}>Thank you for being a Pro member!</div>
          </div>
        )}

      </div>

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
  'Barbershop': 'Who are your team members?',
  'Hair Salon':  'Who are your team members?',
  'Nail Salon':  'Who are your team members?',
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
    ai_name:       '',
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
          ai_name:        biz.ai_name       || '',
          business_type:  bizType,
          timezone:       biz.timezone      || 'America/Toronto',
          business_hours: biz.business_hours || {},
          barbers:        (() => {
                            const src = biz.team_members || biz.barbers;
                            if (src && src.length > 0) {
                              return src.map(m => typeof m === 'string' ? { name: m, role: '', calendarId: '' } : { role: '', calendarId: '', ...m });
                            }
                            return biz.owner_name ? [{ name: biz.owner_name, role: '', calendarId: '' }] : [];
                          })(),
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
        .then(res => setBizPhone((res.business || res).twilio_phone || (res.business || res).phone || null))
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
      setData(d => ({ ...d, barbers: [...d.barbers, { name: newBarber.trim(), role: '', calendarId: '' }] }));
      setNewBarber('');
    }
  };

  const complete = async () => {
    console.log('[complete] called with:', {
      name: data.name,
      phone: data.phone,
      address: data.address,
      ai_name: data.ai_name,
      business_type: data.business_type,
      timezone: data.timezone,
      barbers: data.barbers,
    });
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
          team_members:   data.barbers,
        }),
      });
      console.log('[complete] data.services to save:', JSON.stringify(data.services));
      await apiFetch('/api/services/replace', {
        method: 'PUT',
        body: JSON.stringify({ services: data.services }),
      });
      // Notify server to update Vapi assistant with finalised config
      try {
        await apiFetch('/onboarding/complete', {
          method: 'POST',
          body: JSON.stringify({
            services: data.services,
            barbers: data.barbers,
            timezone: data.timezone,
            supported_languages: data.supported_languages,
          }),
        });
      } catch (vapiErr) {
        // Non-fatal — log but don't block the user from proceeding
        console.warn('[complete] Vapi update failed (non-fatal):', vapiErr);
      }
      setPage('home');
    } catch(err) {
      console.error('[complete] failed:', err);
    }
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
              <label>Your Business Phone Number</label>
              <input
                value={data.phone}
                onChange={e => setField('phone', e.target.value)}
                placeholder="+1 (416) 555-0000"
              />
              <p style={{ fontSize: 12, color: '#9ca3af', margin: '4px 0 0' }}>
                This is your current number that customers call. You'll forward this to your Bimbly number in the last step.
              </p>
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
                placeholder="e.g. Alex"
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
            <h2>{TEAM_LABEL[data.business_type] || 'Who are your team members?'}</h2>
            <p className="step-sub">
              Customers can request a specific team member by name when they call.
              {plan === 'starter' && <span style={{ display: 'block', fontSize: 12, color: '#9ca3af', marginTop: 4 }}>Starter plan includes up to 4 team members.</span>}
            </p>
            <div className="barbers-list" style={{ marginBottom: 16 }}>
              {data.barbers.map((barber, i) => (
                <div key={i} className="barber-chip">
                  {typeof barber === 'string' ? barber : barber.name}
                  {i === 0 && <span style={{ fontSize: 11, color: '#9ca3af', marginLeft: 4 }}>(you)</span>}
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

// ── ClientsPage ───────────────────────────────────────────────────────────────
function ClientsPage({ clients, setClients, setPage }) {
  const [search, setSearch]       = useState(window._clientsSearch || '');
  const [tagFilter, setTagFilter] = useState(null);
  useEffect(() => { window._clientsSearch = null; }, []);
  const [showForm, setShowForm]   = useState(false);
  const [form, setForm]           = useState({ name: '', phone: '', notes: '', tags: '' });
  const [saving, setSaving]       = useState(false);
  const [error, setError]         = useState('');

  // Collect all unique tags across all clients
  const allTags = [...new Set(clients.flatMap(c => c.tags || []))].sort();

  const filtered = clients.filter(c => {
    const q = search.toLowerCase();
    const matchSearch = !q || c.name.toLowerCase().includes(q) || (c.phone || '').includes(q);
    const matchTag = !tagFilter || (c.tags || []).includes(tagFilter);
    return matchSearch && matchTag;
  });

  async function handleCreate(e) {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      const r = await apiFetch('/api/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name,
          phone: form.phone,
          notes: form.notes || undefined,
          tags: form.tags ? form.tags.split(',').map(t => t.trim()).filter(Boolean) : []
        })
      });
      const d = await r.json();
      if (!r.ok) { setError(d.error || 'Failed to create client.'); return; }
      setClients(prev => [d.client, ...prev]);
      setShowForm(false);
      setForm({ name: '', phone: '', notes: '', tags: '' });
    } catch (err) {
      setError('Network error.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page-content">
      <div className="filter-bar" style={{ gap: '8px', flexWrap: 'wrap' }}>
        <input
          placeholder="Search by name or phone..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ padding: '6px 12px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', minWidth: '220px' }}
        />
        {allTags.map(tag => (
          <button
            key={tag}
            className={`filter-btn ${tagFilter === tag ? 'active' : ''}`}
            onClick={() => setTagFilter(tagFilter === tag ? null : tag)}
          >
            {tag}
          </button>
        ))}
        <button className="filter-btn" style={{ marginLeft: 'auto' }} onClick={() => setShowForm(s => !s)}>
          + Add Client
        </button>
      </div>

      {showForm && (
        <div className="card" style={{ marginBottom: '16px' }}>
          <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: '10px', maxWidth: '480px' }}>
            <input required placeholder="Name *" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              style={{ padding: '8px', border: '1px solid #e2e8f0', borderRadius: '6px' }} />
            <input required placeholder="Phone * (e.g. +16471234567)" value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
              style={{ padding: '8px', border: '1px solid #e2e8f0', borderRadius: '6px' }} />
            <textarea placeholder="Notes (optional)" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              style={{ padding: '8px', border: '1px solid #e2e8f0', borderRadius: '6px', resize: 'vertical', minHeight: '60px' }} />
            <input placeholder="Tags (comma-separated, e.g. VIP, regular)" value={form.tags} onChange={e => setForm(f => ({ ...f, tags: e.target.value }))}
              style={{ padding: '8px', border: '1px solid #e2e8f0', borderRadius: '6px' }} />
            {error && <div style={{ color: '#e53e3e', fontSize: '13px' }}>{error}</div>}
            <div style={{ display: 'flex', gap: '8px' }}>
              <button type="submit" className="filter-btn active" disabled={saving}>{saving ? 'Saving...' : 'Add Client'}</button>
              <button type="button" className="filter-btn" onClick={() => { setShowForm(false); setError(''); }}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      <div className="card">
        {filtered.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">👤</div>
            <div className="empty-title">No clients yet</div>
            <div className="empty-sub">Clients are created automatically when bookings come in</div>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th><th>Phone</th><th>Last Visit</th><th>Visits</th>
                  <th>Preferred Service</th><th>Preferred Barber</th><th>Tags</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(c => (
                  <tr key={c.id} style={{ cursor: 'pointer' }}
                    onClick={() => { window._clientProfileId = c.id; setPage('client-profile'); }}>
                    <td><div className="cell-name" style={{ color: '#6366f1', textDecoration: 'underline' }}>{c.name}</div></td>
                    <td>{c.phone || '—'}</td>
                    <td>{c.last_visit ? new Date(c.last_visit + 'T00:00:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}</td>
                    <td>{c.visit_count || 0}</td>
                    <td>{c.preferred_service || '—'}</td>
                    <td>{c.preferred_barber || '—'}</td>
                    <td>{(c.tags || []).join(', ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}


// ── ClientProfilePage ─────────────────────────────────────────────────────────
function ClientProfilePage({ clients, setClients, setPage }) {
  const clientId = window._clientProfileId;
  const [client, setClient]     = useState(null);
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [editing, setEditing]   = useState(false);
  const [form, setForm]         = useState({ name: '', notes: '', tags: '' });
  const [saving, setSaving]     = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [error, setError]       = useState('');

  const handleDepositAction = async (bookingId, action) => {
    const endpoint = action === 'no-show' ? 'no-show' : 'waive-deposit';
    try {
      const res = await apiFetch(`/api/bookings/${bookingId}/${endpoint}`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) { alert(data.error || 'Action failed.'); return; }
      setBookings(bs => bs.map(b => b.id === bookingId ? data.booking : b));
    } catch { alert('Action failed. Please try again.'); }
  };

  useEffect(() => {
    if (!clientId) { setPage('clients'); return; }
    apiFetch(`/api/clients/${clientId}`)
      .then(r => r.json())
      .then(d => {
        if (d.client) {
          setClient(d.client);
          setBookings(d.bookings || []);
          setForm({ name: d.client.name, notes: d.client.notes || '', tags: (d.client.tags || []).join(', ') });
        } else {
          setPage('clients');
        }
      })
      .catch(() => setPage('clients'))
      .finally(() => setLoading(false));
  }, [clientId]);

  async function handleSave() {
    setSaving(true); setError('');
    try {
      const r = await apiFetch(`/api/clients/${clientId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name,
          notes: form.notes || null,
          tags: form.tags ? form.tags.split(',').map(t => t.trim()).filter(Boolean) : []
        })
      });
      const d = await r.json();
      if (!r.ok) { setError(d.error); return; }
      setClient(d.client);
      setClients(prev => prev.map(c => c.id === clientId ? { ...c, ...d.client } : c));
      setEditing(false);
    } catch { setError('Network error.'); }
    finally { setSaving(false); }
  }

  async function handleDelete() {
    try {
      const r = await apiFetch(`/api/clients/${clientId}`, { method: 'DELETE' });
      if (!r.ok) { const d = await r.json(); setError(d.error || 'Delete failed.'); return; }
      setClients(prev => prev.filter(c => c.id !== clientId));
      setPage('clients');
    } catch { setError('Delete failed.'); }
  }

  if (loading) return <Spinner />;
  if (!client) return null;

  return (
    <div className="page-content">
      <button className="filter-btn" onClick={() => setPage('clients')} style={{ marginBottom: '16px' }}>← Back to Clients</button>

      <div className="card" style={{ marginBottom: '16px' }}>
        {editing ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', maxWidth: '480px' }}>
            <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              style={{ padding: '8px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '16px', fontWeight: 600 }} />
            <textarea placeholder="Notes" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              style={{ padding: '8px', border: '1px solid #e2e8f0', borderRadius: '6px', resize: 'vertical', minHeight: '80px' }} />
            <input placeholder="Tags (comma-separated)" value={form.tags} onChange={e => setForm(f => ({ ...f, tags: e.target.value }))}
              style={{ padding: '8px', border: '1px solid #e2e8f0', borderRadius: '6px' }} />
            {error && <div style={{ color: '#e53e3e', fontSize: '13px' }}>{error}</div>}
            <div style={{ display: 'flex', gap: '8px' }}>
              <button className="filter-btn active" onClick={handleSave} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
              <button className="filter-btn" onClick={() => { setEditing(false); setError(''); }}>Cancel</button>
            </div>
          </div>
        ) : (
          <div>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' }}>
              <div>
                <h2 style={{ margin: 0, fontSize: '22px' }}>{client.name}</h2>
                <div style={{ color: '#64748b', marginTop: '4px' }}>{client.phone}</div>
                {(client.tags || []).length > 0 && (
                  <div style={{ marginTop: '8px', display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    {client.tags.map(tag => (
                      <span key={tag} style={{ background: '#ede9fe', color: '#6d28d9', padding: '2px 10px', borderRadius: '12px', fontSize: '12px' }}>{tag}</span>
                    ))}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
                <button className="filter-btn" onClick={() => setEditing(true)}>Edit</button>
                <button className="filter-btn" style={{ color: '#e53e3e' }} onClick={() => setConfirmDel(true)}>Delete</button>
              </div>
            </div>

            {client.notes && (
              <div style={{ marginTop: '16px', padding: '12px', background: '#f8fafc', borderRadius: '8px', fontSize: '14px', color: '#475569' }}>
                {client.notes}
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '12px', marginTop: '20px' }}>
              {[
                { label: 'Total Visits', value: client.visit_count ?? 0 },
                { label: 'Last Visit', value: client.last_visit ? new Date(client.last_visit + 'T00:00:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' }) : '—' },
                { label: 'Preferred Service', value: client.preferred_service || '—' },
                { label: 'Preferred Barber', value: client.preferred_barber || '—' },
              ].map(stat => (
                <div key={stat.label} style={{ background: '#f8fafc', borderRadius: '8px', padding: '12px', textAlign: 'center' }}>
                  <div style={{ fontSize: '11px', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{stat.label}</div>
                  <div style={{ fontSize: '18px', fontWeight: 700, marginTop: '4px' }}>{stat.value}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {confirmDel && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div style={{ background: '#fff', borderRadius: '12px', padding: '24px', maxWidth: '380px', width: '90%' }}>
            <h3 style={{ margin: '0 0 8px' }}>Delete {client.name}?</h3>
            <p style={{ color: '#64748b', fontSize: '14px', margin: '0 0 20px' }}>
              The client record will be removed. Their booking history will be preserved.
            </p>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button className="filter-btn" onClick={() => setConfirmDel(false)}>Cancel</button>
              <button className="filter-btn" style={{ background: '#fee2e2', color: '#e53e3e', border: 'none' }} onClick={handleDelete}>Delete</button>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <h3 style={{ margin: '0 0 16px', fontSize: '16px' }}>Booking History</h3>
        {bookings.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">📅</div>
            <div className="empty-title">No bookings yet</div>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr><th>Date</th><th>Time</th><th>Service</th><th>Team Member</th><th>Special Requests</th><th>Deposit</th></tr>
              </thead>
              <tbody>
                {bookings.map(b => (
                  <tr key={b.id}>
                    <td>{b.appointment_date ? new Date(b.appointment_date + 'T00:00:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}</td>
                    <td>{b.appointment_time || '—'}</td>
                    <td>{Array.isArray(b.service_ids) ? b.service_ids.join(', ') : b.service_ids || '—'}</td>
                    <td>{b.preferred_barber || '—'}</td>
                    <td className="cell-requests">{b.special_requests || '—'}</td>
                    <td>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <DepositBadge status={b.deposit_status} />
                        {b.deposit_status === 'secured' && (
                          <div style={{ display: 'flex', gap: 4, marginTop: 2 }}>
                            <button
                              className="btn-outline"
                              style={{ fontSize: 12, padding: '2px 8px', color: '#dc2626', borderColor: '#dc2626' }}
                              onClick={() => {
                                if (confirm('Charge deposit for no-show?')) {
                                  handleDepositAction(b.id, 'no-show');
                                }
                              }}
                            >
                              No-Show
                            </button>
                            <button
                              className="btn-outline"
                              style={{ fontSize: 12, padding: '2px 8px' }}
                              onClick={() => handleDepositAction(b.id, 'waive')}
                            >
                              Waive
                            </button>
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ── QueuePage ─────────────────────────────────────────────────────────────────
function QueuePage() {
  const [queue, setQueue]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState({});

  const fetchQueue = () => {
    apiFetch('/api/queue')
      .then(r => r.json())
      .then(d => setQueue(d.queue || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchQueue();
    const interval = setInterval(fetchQueue, 15000);
    return () => clearInterval(interval);
  }, []);

  const action = async (id, endpoint, label) => {
    setActionLoading(s => ({ ...s, [id + endpoint]: true }));
    try {
      const res = await apiFetch(`/api/queue/${id}/${endpoint}`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) { alert(data.error || `${label} failed.`); return; }
      setQueue(q => q.filter(e => e.id !== id));
    } catch { alert(`${label} failed. Please try again.`); }
    finally { setActionLoading(s => ({ ...s, [id + endpoint]: false })); }
  };

  const STATUS_COLORS = {
    waiting:  { bg: '#fef3c7', color: '#92400e', label: 'Waiting' },
    notified: { bg: '#d1fae5', color: '#065f46', label: 'Notified' },
  };

  if (loading) return <Spinner />;

  return (
    <div className="page-content">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 13, color: '#6b7280' }}>
          {queue.length === 0 ? 'No one in queue' : `${queue.length} customer${queue.length > 1 ? 's' : ''} waiting`}
        </div>
        <button className="btn-outline" style={{ fontSize: 13 }} onClick={fetchQueue}>Refresh</button>
      </div>

      {queue.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-icon">🪑</div>
            <div className="empty-title">Queue is empty</div>
            <div className="empty-sub">Customers can join via QR code in Settings → Walk-in Queue</div>
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Name</th>
                  <th>Phone</th>
                  <th>Service</th>
                  <th>Team Member</th>
                  <th>Status</th>
                  <th>Waited</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {queue.map(entry => {
                  const s = STATUS_COLORS[entry.status] || { bg: '#f3f4f6', color: '#6b7280', label: entry.status };
                  const waited = Math.floor((Date.now() - new Date(entry.created_at).getTime()) / 60000);
                  const isNotifying = actionLoading[entry.id + 'notify'];
                  const isServing   = actionLoading[entry.id + 'serve'];
                  const isRemoving  = actionLoading[entry.id + 'remove'];
                  return (
                    <tr key={entry.id}>
                      <td style={{ fontWeight: 700, color: '#534AB7' }}>{entry.position}</td>
                      <td><div className="cell-name">{entry.customer_name}</div></td>
                      <td>{entry.customer_phone}</td>
                      <td>{entry.service || '—'}</td>
                      <td>{entry.preferred_barber || '—'}</td>
                      <td>
                        <span className="status-badge" style={{ background: s.bg, color: s.color }}>
                          {s.label}
                        </span>
                      </td>
                      <td style={{ color: waited > 20 ? '#ef4444' : '#374151' }}>{waited}m</td>
                      <td>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {entry.status === 'waiting' && (
                            <button
                              className="btn-outline"
                              style={{ fontSize: 12, padding: '3px 10px', color: '#059669', borderColor: '#059669' }}
                              disabled={isNotifying}
                              onClick={() => action(entry.id, 'notify', 'Notify')}
                            >
                              {isNotifying ? '...' : 'Notify'}
                            </button>
                          )}
                          <button
                            className="btn-outline"
                            style={{ fontSize: 12, padding: '3px 10px' }}
                            disabled={isServing}
                            onClick={() => action(entry.id, 'serve', 'Serve')}
                          >
                            {isServing ? '...' : 'Served'}
                          </button>
                          <button
                            className="btn-outline"
                            style={{ fontSize: 12, padding: '3px 10px', color: '#9ca3af', borderColor: '#d1d5db' }}
                            disabled={isRemoving}
                            onClick={() => action(entry.id, 'remove', 'Remove')}
                          >
                            {isRemoving ? '...' : 'Remove'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────
function App() {
  const [authed, setAuthed]     = useState(false);
  const [page, setPage]         = useState('home');
  const [business, setBusiness] = useState(null);
  const [clients, setClients]   = useState([]);

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
    apiFetch('/api/clients')
      .then(r => r.json())
      .then(d => setClients(d.clients || []))
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
    home:           'Dashboard',
    bookings:       'Bookings',
    queue:          'Walk-in Queue',
    clients:        'Clients',
    'client-profile': 'Client Profile',
    settings:       'Settings',
    billing:        'Billing',
    onboarding:     'Setup',
  };

  return (
    <div className="app-layout">
      <Sidebar page={page} setPage={setPage} business={business} />
      <div className="main-area">
        <TopBar title={titles[page] || 'Dashboard'} />
        <div className="content-area">
          {page === 'home'       && <DashboardHome />}
          {page === 'bookings'   && <BookingsPage clients={clients} setPage={setPage} />}
          {page === 'queue'      && <QueuePage />}
          {page === 'clients'    && <ClientsPage clients={clients} setClients={setClients} setPage={setPage} />}
          {page === 'client-profile' && <ClientProfilePage clients={clients} setClients={setClients} setPage={setPage} />}
          {page === 'settings'   && <SettingsPage setPage={setPage} />}
          {page === 'billing'    && <BillingPage />}
          {page === 'onboarding' && <OnboardingPage setPage={setPage} />}
        </div>
      </div>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
