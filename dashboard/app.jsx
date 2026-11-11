'use strict';

const { useState, useEffect, useCallback, useRef, useMemo, useContext, createContext } = React;

// The dashboard is served by the same server as the API.
const API_BASE = window.location.origin;

// ── API helpers ───────────────────────────────────────────────────────────────
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
    window.location.href = API_BASE + '/auth/dashboard/login';
    throw new Error('Your session expired. Please sign in again.');
  }
  return res;
}

// Like apiFetch, but parses JSON and throws a readable error when the request fails.
async function api(path, options = {}) {
  let res;
  try {
    res = await apiFetch(path, options);
  } catch (err) {
    throw new Error(err.message === 'Failed to fetch' ? 'Could not reach Bimbly. Check your connection and try again.' : err.message);
  }
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
  return data;
}

async function downloadFile(path, filename) {
  const res = await apiFetch(path);
  if (!res.ok) {
    let msg = 'Download failed.';
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Formatting ────────────────────────────────────────────────────────────────
function localISODate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function fmtDate(iso, opts = { month: 'short', day: 'numeric', year: 'numeric' }) {
  if (!iso) return '';
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00');
  if (isNaN(d)) return String(iso);
  return d.toLocaleDateString('en-CA', opts);
}

function fmtDay(iso) {
  if (!iso) return '';
  const today = localISODate();
  const tomorrow = localISODate(addDays(new Date(), 1));
  if (iso === today) return 'Today';
  if (iso === tomorrow) return 'Tomorrow';
  return fmtDate(iso, { weekday: 'short', month: 'short', day: 'numeric' });
}

// "14:30", "14:30:00" -> "2:30 PM". Anything else is shown as-is.
function fmtTime(t) {
  if (!t) return '';
  const m = String(t).match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return String(t);
  let h = parseInt(m[1], 10);
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m[2]} ${ampm}`;
}

function timeToMinutes(t) {
  if (!t) return 9999;
  const s = String(t).trim().toUpperCase();
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return 9999;
  let h = parseInt(m[1], 10);
  if (s.includes('PM') && h < 12) h += 12;
  if (s.includes('AM') && h === 12) h = 0;
  return h * 60 + parseInt(m[2], 10);
}

function fmtServices(v) {
  if (Array.isArray(v)) return v.filter(Boolean).join(', ');
  return v ? String(v) : '';
}

function fmtMoney(n, decimals = 0) {
  const num = Number(n || 0);
  return '$' + num.toLocaleString('en-CA', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtPhone(p) {
  if (!p) return '';
  const digits = String(p).replace(/\D/g, '');
  const d = digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits;
  if (d.length !== 10) return String(p);
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

function initials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

const PLAN_LABELS = { solo: 'Solo', starter: 'Starter', pro: 'Pro' };

function teamWords(businessType) {
  const t = (businessType || '').toLowerCase();
  if (t.includes('barber')) return { one: 'barber', many: 'barbers', roles: ['Barber', 'Apprentice', 'Manager'] };
  if (t.includes('hair'))   return { one: 'stylist', many: 'stylists', roles: ['Stylist', 'Colorist', 'Apprentice', 'Manager'] };
  if (t.includes('nail'))   return { one: 'technician', many: 'technicians', roles: ['Technician', 'Apprentice', 'Manager'] };
  return { one: 'team member', many: 'team members', roles: ['Team Member', 'Manager'] };
}

function teamLimit(plan) {
  return plan === 'pro' ? Infinity : plan === 'starter' ? 4 : 1;
}

function normalizeTeam(list) {
  return (list || []).map(m => typeof m === 'string' ? { name: m, role: '', calendarId: '' } : { role: '', calendarId: '', ...m });
}

// ── Icons ─────────────────────────────────────────────────────────────────────
const ICONS = {
  home:     'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  calendar: 'M7 3v3M17 3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z',
  users:    'M16 20v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 20v-1a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  queue:    'M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01',
  settings: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  card:     'M3 5h18a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM2 10h20M6 15h4',
  sparkle:  'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
  logout:   'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  menu:     'M3 6h18M3 12h18M3 18h18',
  check:    'M20 6 9 17l-5-5',
  x:        'M18 6 6 18M6 6l12 12',
  plus:     'M12 5v14M5 12h14',
  trash:    'M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v5M14 11v5',
  copy:     'M9 9h11v11H9zM5 15H4V4h11v1',
  external: 'M14 3h7v7M10 14 21 3M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5',
  download: 'M12 3v12M7 10l5 5 5-5M5 21h14',
  upload:   'M12 21V9M7 14l5-5 5 5M5 3h14',
  search:   'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  phone:    'M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z',
  dollar:   'M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
  clock:    'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
  alert:    'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  info:     'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01',
  back:     'M19 12H5M12 19l-7-7 7-7',
  refresh:  'M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6',
  trend:    'M3 17l6-6 4 4 8-8M14 7h7v7',
  edit:     'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  bell:     'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0',
  arrow:    'M5 12h14M12 5l7 7-7 7',
};

function Icon({ name, className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={ICONS[name] || ''} />
    </svg>
  );
}

// ── Toasts ────────────────────────────────────────────────────────────────────
const ToastContext = createContext(() => {});
const useToast = () => useContext(ToastContext);

function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((text, type = 'success') => {
    const id = Date.now() + Math.random();
    setToasts(t => [...t, { id, text, type }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), type === 'error' ? 5000 : 3000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map(t => (
          <div key={t.id} className={`toast toast--${t.type}`}>
            <Icon name={t.type === 'error' ? 'alert' : 'check'} />
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// ── Primitives ────────────────────────────────────────────────────────────────
function Spinner() {
  return <div className="spinner-wrap"><div className="spinner" role="status" aria-label="Loading"></div></div>;
}

function Card({ title, description, action, children, footer, flush, className = '', badge }) {
  return (
    <section className={`card ${className}`}>
      {(title || action) && (
        <div className="card-head">
          <div>
            {title && <h2 className="card-title">{title}{badge}</h2>}
            {description && <p className="card-desc">{description}</p>}
          </div>
          {action && <div className="row">{action}</div>}
        </div>
      )}
      {children !== undefined && children !== null && children !== false && (
        <div className={flush ? 'card-body card-body--flush' : 'card-body'}>{children}</div>
      )}
      {footer && <div className="card-foot">{footer}</div>}
    </section>
  );
}

function Field({ label, hint, error, optional, htmlFor, children, className = '' }) {
  return (
    <div className={`field ${className}`}>
      {label && (
        <label className="field-label" htmlFor={htmlFor}>
          {label}{optional && <span className="optional"> (optional)</span>}
        </label>
      )}
      {children}
      {error ? <p className="field-error">{error}</p> : hint ? <p className="field-hint">{hint}</p> : null}
    </div>
  );
}

function Switch({ checked, onChange, disabled, label, id }) {
  return (
    <span className="switch">
      <input type="checkbox" role="switch" id={id} aria-label={label} checked={!!checked} disabled={disabled}
        onChange={e => onChange(e.target.checked)} />
      <span className="switch-track" aria-hidden="true"></span>
    </span>
  );
}

function SwitchRow({ title, description, checked, onChange, disabled, id }) {
  return (
    <div className="switch-row">
      <div className="switch-row-text">
        <label className="switch-row-title" htmlFor={id}>{title}</label>
        {description && <p className="field-hint">{description}</p>}
      </div>
      <Switch id={id} checked={checked} onChange={onChange} disabled={disabled} />
    </div>
  );
}

function Notice({ type = 'info', children }) {
  const icon = type === 'error' || type === 'warn' ? 'alert' : type === 'success' ? 'check' : 'info';
  return <div className={`notice notice--${type}`}><Icon name={icon} /><div>{children}</div></div>;
}

function EmptyState({ icon = 'calendar', title, sub, action }) {
  return (
    <div className="empty-state">
      <div className="empty-icon"><Icon name={icon} /></div>
      <div className="empty-title">{title}</div>
      {sub && <p className="empty-sub">{sub}</p>}
      {action}
    </div>
  );
}

function Modal({ title, children, actions, onClose }) {
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" onMouseDown={e => e.stopPropagation()}>
        <div className="modal-body">
          <h2 className="modal-title" id="modal-title">{title}</h2>
          <div className="modal-text">{children}</div>
        </div>
        <div className="modal-actions">{actions}</div>
      </div>
    </div>
  );
}

function ConfirmDialog({ title, children, confirmLabel, cancelLabel = 'Cancel', danger = true, busy, onConfirm, onCancel }) {
  return (
    <Modal title={title} onClose={onCancel} actions={<>
      <button className="btn btn--secondary" onClick={onCancel} disabled={busy}>{cancelLabel}</button>
      <button className={`btn ${danger ? 'btn--danger' : 'btn--primary'}`} onClick={onConfirm} disabled={busy} autoFocus>
        {busy ? 'Working…' : confirmLabel}
      </button>
    </>}>
      {children}
    </Modal>
  );
}

function SaveStatus({ status }) {
  if (!status) return null;
  return (
    <span className={`status status--${status.type}`} role="status">
      {status.type === 'success' && <Icon name="check" />}
      {status.text}
    </span>
  );
}

// Inline "Saved" / error message that clears itself.
function useStatus() {
  const [status, setStatus] = useState(null);
  const timer = useRef(null);
  const set = useCallback((type, text) => {
    clearTimeout(timer.current);
    setStatus(type ? { type, text } : null);
    if (type === 'success') timer.current = setTimeout(() => setStatus(null), 3000);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return [status, set];
}

// Tracks whether a value has changed since it was last saved.
function useDirty(value) {
  const baseline = useRef(JSON.stringify(value));
  const dirty = JSON.stringify(value) !== baseline.current;
  const markSaved = useCallback(v => { baseline.current = JSON.stringify(v); }, []);
  return [dirty, markSaved];
}

function SaveFooter({ saving, status, dirty, onSave, label = 'Save changes', disabled }) {
  return (
    <>
      {status ? <SaveStatus status={status} /> : dirty ? <span className="status muted small" style={{ marginRight: 'auto', fontWeight: 400 }}>Unsaved changes</span> : null}
      <button className="btn btn--primary" onClick={onSave} disabled={saving || disabled}>
        {saving ? 'Saving…' : label}
      </button>
    </>
  );
}

function StatusBadge({ status }) {
  if (!status) return <span className="muted">-</span>;
  const s = String(status).toLowerCase();
  const tone = { confirmed: 'green', booked: 'green', completed: 'blue', pending: 'amber', cancelled: 'red', canceled: 'red', 'no-show': 'red', no_show: 'red' }[s] || '';
  return <span className={`badge ${tone ? 'badge--' + tone : ''}`}>{capitalize(s.replace(/[_-]/g, ' '))}</span>;
}

function DepositBadge({ status }) {
  if (!status || status === 'none') return null;
  const map = {
    pending: { tone: 'amber', label: 'Deposit pending' },
    secured: { tone: 'green', label: 'Deposit secured' },
    charged: { tone: 'red', label: 'Deposit charged' },
    waived:  { tone: '', label: 'Deposit waived' },
  };
  const s = map[status];
  if (!s) return null;
  return <span className={`badge ${s.tone ? 'badge--' + s.tone : ''}`}>{s.label}</span>;
}

// ── Sidebar & top bar ─────────────────────────────────────────────────────────
const NAV = [
  { group: 'Your shop', items: [
    { id: 'home',     label: 'Dashboard', icon: 'home' },
    { id: 'bookings', label: 'Bookings',  icon: 'calendar' },
    { id: 'queue',    label: 'Walk-ins',  icon: 'queue' },
    { id: 'clients',  label: 'Clients',   icon: 'users' },
  ]},
  { group: 'Account', items: [
    { id: 'settings',   label: 'Settings',     icon: 'settings' },
    { id: 'billing',    label: 'Billing',      icon: 'card' },
    { id: 'onboarding', label: 'Setup wizard', icon: 'sparkle' },
  ]},
];

const PAGE_PARENT = { client: 'clients' };

function Sidebar({ page, go, business, open, onClose, queueCount }) {
  const active = PAGE_PARENT[page] || page;
  const plan = PLAN_LABELS[business?.plan] || '';
  return (
    <>
      {open && <div className="sidebar-scrim" onClick={onClose} aria-hidden="true"></div>}
      <aside className={`sidebar ${open ? 'open' : ''}`} aria-label="Main">
        <div className="sidebar-logo">
          <a href="https://bimblyai.com" aria-label="Bimbly home">
            <img src="/dashboard/brand/bimblyai-logo-primary.svg" alt="Bimblyai" width="133" height="32" />
          </a>
        </div>
        <nav className="sidebar-nav">
          {NAV.map(group => (
            <React.Fragment key={group.group}>
              <div className="nav-group-label">{group.group}</div>
              {group.items.map(item => (
                <button
                  key={item.id}
                  className={`nav-item ${active === item.id ? 'active' : ''}`}
                  aria-current={active === item.id ? 'page' : undefined}
                  onClick={() => go(item.id)}
                >
                  <Icon name={item.icon} />
                  {item.label}
                  {item.id === 'queue' && queueCount > 0 && <span className="nav-count" aria-label={`${queueCount} waiting`}>{queueCount}</span>}
                </button>
              ))}
            </React.Fragment>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="avatar" aria-hidden="true">{initials(business?.name)}</div>
          <div className="sidebar-biz">
            <div className="sidebar-biz-name">{business?.name || 'Your business'}</div>
            {plan && <div className="sidebar-biz-plan">{plan} plan</div>}
          </div>
          <button
            className="btn btn--ghost btn--icon btn--sm"
            title="Sign out"
            aria-label="Sign out"
            onClick={() => {
              localStorage.removeItem('bimbly_token');
              window.location.href = API_BASE + '/auth/logout';
            }}
          >
            <Icon name="logout" />
          </button>
        </div>
      </aside>
    </>
  );
}

function TopBar({ title, onMenu }) {
  const today = new Date().toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  return (
    <header className="topbar">
      <button className="btn btn--ghost btn--icon topbar-menu" onClick={onMenu} aria-label="Open menu">
        <Icon name="menu" />
      </button>
      <h1 className="topbar-title">{title}</h1>
      <span className="topbar-date">{today}</span>
    </header>
  );
}

// ── Charts ────────────────────────────────────────────────────────────────────
function BarChart({ data, empty = 'No bookings yet' }) {
  if (!data || !data.length || data.every(d => !d.count)) return <p className="empty-inline">{empty}</p>;
  const max = Math.max(...data.map(d => d.count), 1);
  return (
    <div className="bar-chart">
      {data.map((item, i) => (
        <div key={i} className="bar-row">
          <div className="bar-label" title={item.label}>{item.label}</div>
          <div className="bar-track"><div className="bar-fill" style={{ width: `${(item.count / max) * 100}%` }}></div></div>
          <div className="bar-count">{item.count}</div>
        </div>
      ))}
    </div>
  );
}

function StatCard({ icon, label, value, sub }) {
  return (
    <div className="card stat-card">
      <div className="stat-label"><Icon name={icon} />{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

// ── Bookings table (shared by Home, Bookings, Client profile) ────────────────
function BookingsTable({ bookings, showCustomer = true, compact = false, onClientClick, onDepositAction, emptyTitle = 'No bookings yet', emptySub = 'Your AI receptionist is ready to take calls.' }) {
  const [noShow, setNoShow] = useState(null);
  const [busy, setBusy] = useState(false);

  if (!bookings.length) return <EmptyState icon="phone" title={emptyTitle} sub={emptySub} />;

  const showDeposits = !compact && bookings.some(b => b.deposit_status && b.deposit_status !== 'none');

  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            {showCustomer && <th>Customer</th>}
            <th>Appointment</th>
            <th>Service</th>
            <th>Team member</th>
            {!compact && <th>Notes</th>}
            <th>Status</th>
            {showDeposits && <th className="col-actions">Deposit</th>}
          </tr>
        </thead>
        <tbody>
          {bookings.map(b => (
            <tr key={b.id}>
              {showCustomer && (
                <td>
                  {onClientClick && b.customer_phone ? (
                    <button className="link-name" onClick={() => onClientClick(b)}>{b.customer_name || 'Unknown caller'}</button>
                  ) : (
                    <div className="cell-name">{b.customer_name || 'Unknown caller'}</div>
                  )}
                  {b.customer_phone && <div className="cell-sub num">{fmtPhone(b.customer_phone)}</div>}
                </td>
              )}
              <td className="nowrap">
                <div className="cell-name">{fmtDay(b.appointment_date) || '-'}</div>
                <div className="cell-sub num">{fmtTime(b.appointment_time)}</div>
              </td>
              <td>{fmtServices(b.service_ids) || <span className="muted">-</span>}</td>
              <td>{b.preferred_barber || <span className="muted">Anyone</span>}</td>
              {!compact && <td><div className="cell-clip" title={b.special_requests || ''}>{b.special_requests || <span className="muted">-</span>}</div></td>}
              <td><StatusBadge status={b.status} /></td>
              {showDeposits && (
                <td className="col-actions">
                  <div className="row" style={{ justifyContent: 'flex-end' }}>
                    <DepositBadge status={b.deposit_status} />
                    {b.deposit_status === 'secured' && onDepositAction && (
                      <>
                        <button className="btn btn--danger-outline btn--sm" onClick={() => setNoShow(b)}>No-show</button>
                        <button className="btn btn--secondary btn--sm" onClick={() => onDepositAction(b.id, 'waive')}>Waive</button>
                      </>
                    )}
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {noShow && (
        <ConfirmDialog
          title="Charge the no-show deposit?"
          confirmLabel={`Charge ${noShow.deposit_amount_cents ? fmtMoney(noShow.deposit_amount_cents / 100, 2) : 'deposit'}`}
          busy={busy}
          onCancel={() => setNoShow(null)}
          onConfirm={async () => {
            setBusy(true);
            await onDepositAction(noShow.id, 'no-show');
            setBusy(false);
            setNoShow(null);
          }}
        >
          {noShow.customer_name || 'This customer'} will be charged their deposit for missing the appointment on {fmtDate(noShow.appointment_date)}. This can't be undone.
        </ConfirmDialog>
      )}
    </div>
  );
}

function useDepositAction(setBookings) {
  const toast = useToast();
  return useCallback(async (bookingId, action) => {
    const endpoint = action === 'no-show' ? 'no-show' : 'waive-deposit';
    try {
      const data = await api(`/api/bookings/${bookingId}/${endpoint}`, { method: 'POST' });
      setBookings(bs => bs.map(b => b.id === bookingId ? data.booking : b));
      toast(action === 'no-show' ? 'Deposit charged' : 'Deposit waived');
    } catch (err) {
      toast(err.message, 'error');
    }
  }, [setBookings, toast]);
}

// ── Dashboard home ────────────────────────────────────────────────────────────
const WEEK = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function DashboardHome({ business, go, queue }) {
  const [analytics, setAnalytics] = useState(null);
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    Promise.all([api('/api/analytics'), api('/api/bookings?limit=8')])
      .then(([a, b]) => { setAnalytics(a); setBookings(b.bookings || []); })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Spinner />;
  if (error) return <div className="page-content"><Notice type="error">{error}</Notice></div>;

  const a = analytics || {};
  const today = (Array.isArray(a.todayBookings) ? a.todayBookings : [])
    .slice().sort((x, y) => timeToMinutes(x.appointment_time) - timeToMinutes(y.appointment_time));
  const upcoming = Array.isArray(a.upcomingBookings) ? a.upcomingBookings.length : 0;
  const thisMonth = a.totalBookingsThisMonth ?? 0;
  const lastMonth = a.totalBookingsLastMonth ?? 0;
  const diff = thisMonth - lastMonth;

  const dayCounts = Object.fromEntries((a.busiestDays || []).map(d => [d.day, d.count]));
  const week = WEEK.map(d => ({ label: d, count: dayCounts[d] || 0 }));
  const services = (a.popularServices || []).slice(0, 5).map(s => ({ label: s.service, count: s.count }));

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const ownerFirst = (business?.owner_name || '').split(' ')[0];

  return (
    <div className="page-content">
      <div>
        <h2 style={{ fontSize: 22, fontWeight: 800 }}>{greeting}{ownerFirst ? `, ${ownerFirst}` : ''}.</h2>
        <p className="muted" style={{ marginTop: 4 }}>
          {today.length === 0
            ? 'Nothing booked for today yet. Bimbly is answering your calls.'
            : `You have ${today.length} appointment${today.length === 1 ? '' : 's'} today.`}
        </p>
      </div>

      <div className="stats-row">
        <StatCard icon="calendar" label="Today" value={today.length} sub={today.length === 1 ? 'appointment' : 'appointments'} />
        <StatCard icon="clock" label="Next 7 days" value={upcoming} sub="upcoming bookings" />
        <StatCard icon="trend" label="This month" value={thisMonth}
          sub={lastMonth || thisMonth ? <><span className={diff >= 0 ? 'trend-up' : 'trend-down'}>{diff >= 0 ? '+' : ''}{diff}</span> vs last month</> : 'bookings'} />
        <StatCard icon="dollar" label="Est. revenue" value={fmtMoney(a.revenueEstimateThisMonth)} sub="this month, from your prices" />
      </div>

      <div className="grid-home">
        <Card title="Today's book" description={new Date().toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric' })}
          action={<button className="btn btn--secondary btn--sm" onClick={() => go('bookings')}>All bookings</button>} flush>
          {today.length === 0 ? (
            <EmptyState icon="calendar" title="No appointments today" sub="New bookings show up here as soon as Bimbly takes the call." />
          ) : (
            <ul className="daybook">
              {today.map(b => (
                <li key={b.id} className="daybook-row">
                  <span className="daybook-time">{fmtTime(b.appointment_time)}</span>
                  <div className="daybook-body">
                    <div className="daybook-name">{b.customer_name || 'Unknown caller'}</div>
                    <div className="daybook-meta">{[fmtServices(b.service_ids), b.preferred_barber && `with ${b.preferred_barber}`].filter(Boolean).join(' · ')}</div>
                  </div>
                  <div className="daybook-aside"><StatusBadge status={b.status} /></div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="stack">
          {queue.length > 0 && (
            <Card title="Walk-ins waiting" badge={<span className="badge badge--amber">{queue.length}</span>}
              action={<button className="btn btn--secondary btn--sm" onClick={() => go('queue')}>Manage</button>} flush>
              <ul className="daybook">
                {queue.slice(0, 4).map(entry => {
                  const waited = Math.max(0, Math.floor((Date.now() - new Date(entry.created_at).getTime()) / 60000));
                  return (
                    <li key={entry.id} className="daybook-row">
                      <span className="daybook-time">#{entry.position}</span>
                      <div className="daybook-body">
                        <div className="daybook-name">{entry.customer_name}</div>
                        <div className="daybook-meta">{entry.service || 'Walk-in'} · waiting {waited} min</div>
                      </div>
                      <div className="daybook-aside">
                        <span className={`badge ${entry.status === 'notified' ? 'badge--green' : 'badge--amber'}`}>{entry.status === 'notified' ? 'Notified' : 'Waiting'}</span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}
          <Card title="Busiest days" description="Last 8 weeks">
            <BarChart data={week} />
          </Card>
          <Card title="Popular services" description="Last 8 weeks">
            <BarChart data={services} />
          </Card>
        </div>
      </div>

      <Card title="Recent bookings" action={<button className="btn btn--secondary btn--sm" onClick={() => go('bookings')}>View all</button>} flush>
        <BookingsTable bookings={bookings} compact />
      </Card>
    </div>
  );
}

// ── Bookings page ─────────────────────────────────────────────────────────────
const BOOKING_FILTERS = [
  { id: 'upcoming', label: 'Upcoming' },
  { id: 'today',    label: 'Today' },
  { id: 'week',     label: 'Last 7 days' },
  { id: 'month',    label: 'Last 30 days' },
];

function BookingsPage({ clients, go }) {
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('upcoming');
  const [search, setSearch] = useState('');
  const onDepositAction = useDepositAction(setBookings);

  useEffect(() => {
    setLoading(true);
    setError('');
    const today = new Date();
    const t = localISODate(today);
    let query = '/api/bookings?limit=200';
    if (filter === 'today') query += `&date=${t}`;
    else if (filter === 'upcoming') query += `&from=${t}&to=${localISODate(addDays(today, 90))}`;
    else if (filter === 'week') query += `&from=${localISODate(addDays(today, -7))}&to=${t}`;
    else query += `&from=${localISODate(addDays(today, -30))}&to=${t}`;
    api(query)
      .then(d => {
        let list = d.bookings || [];
        if (filter === 'upcoming' || filter === 'today') {
          list = list.slice().sort((a, b) =>
            (a.appointment_date || '').localeCompare(b.appointment_date || '') || timeToMinutes(a.appointment_time) - timeToMinutes(b.appointment_time));
        }
        setBookings(list);
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [filter]);

  const q = search.trim().toLowerCase();
  const shown = q
    ? bookings.filter(b => [b.customer_name, b.customer_phone, fmtServices(b.service_ids), b.preferred_barber].some(v => String(v || '').toLowerCase().includes(q)))
    : bookings;

  const emptyCopy = {
    upcoming: ['Nothing booked ahead yet', 'Upcoming appointments appear here as Bimbly books them.'],
    today:    ['No appointments today', 'Bookings for today will show up here.'],
    week:     ['No bookings in the last 7 days', 'Try a longer date range.'],
    month:    ['No bookings in the last 30 days', 'Once customers call, their bookings show up here.'],
  }[filter];

  return (
    <div className="page-content">
      <div className="toolbar">
        <div className="segmented" role="tablist" aria-label="Date range">
          {BOOKING_FILTERS.map(f => (
            <button key={f.id} role="tab" aria-selected={filter === f.id} className={`segment ${filter === f.id ? 'active' : ''}`} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
        <div className="search">
          <Icon name="search" />
          <input className="input" type="search" placeholder="Search name, phone or service" aria-label="Search bookings" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
      </div>

      {error && <Notice type="error">{error}</Notice>}

      <section className="card">
        {loading ? <Spinner /> : (
          <>
            <BookingsTable
              bookings={shown}
              onDepositAction={onDepositAction}
              emptyTitle={q ? 'No matches' : emptyCopy[0]}
              emptySub={q ? 'Try a different name, phone number or service.' : emptyCopy[1]}
              onClientClick={b => {
                const match = clients.find(c => c.phone === b.customer_phone);
                if (match) go('client', match.id);
                else go('clients', b.customer_phone);
              }}
            />
            {shown.length > 0 && <div className="table-foot">{shown.length} booking{shown.length === 1 ? '' : 's'}</div>}
          </>
        )}
      </section>
    </div>
  );
}

// ── Walk-in queue page ────────────────────────────────────────────────────────
function QueuePage({ business, go, onQueueChange }) {
  const toast = useToast();
  const [queue, setQueue] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState({});
  const [, tick] = useState(0);

  const fetchQueue = useCallback(() => {
    return api('/api/queue')
      .then(d => { setQueue(d.queue || []); onQueueChange && onQueueChange(d.queue || []); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [onQueueChange]);

  useEffect(() => {
    fetchQueue();
    const poll = setInterval(fetchQueue, 15000);
    const clock = setInterval(() => tick(n => n + 1), 60000);
    return () => { clearInterval(poll); clearInterval(clock); };
  }, [fetchQueue]);

  const act = async (entry, endpoint, doneText) => {
    setBusy(s => ({ ...s, [entry.id]: endpoint }));
    try {
      await api(`/api/queue/${entry.id}/${endpoint}`, { method: 'POST' });
      if (endpoint === 'notify') {
        setQueue(q => q.map(e => e.id === entry.id ? { ...e, status: 'notified' } : e));
      } else {
        setQueue(q => q.filter(e => e.id !== entry.id));
      }
      toast(doneText);
      fetchQueue();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(s => ({ ...s, [entry.id]: null }));
    }
  };

  if (loading) return <Spinner />;

  return (
    <div className="page-content">
      <div className="toolbar">
        <p className="muted">
          {queue.length === 0 ? 'No one is waiting.' : <><strong style={{ color: 'var(--graphite)' }}>{queue.length}</strong> {queue.length === 1 ? 'person' : 'people'} in line. Updates every 15 seconds.</>}
        </p>
        <span className="spacer"></span>
        <button className="btn btn--secondary" onClick={() => { setLoading(true); fetchQueue(); }}><Icon name="refresh" />Refresh</button>
      </div>

      {!business?.queue_enabled && (
        <Notice type="warn">
          Walk-in check-in is turned off. <button className="btn-link" onClick={() => go('settings', 'walkins')}>Turn it on in Settings</button> to get your QR code.
        </Notice>
      )}

      <section className="card">
        {queue.length === 0 ? (
          <EmptyState icon="queue" title="The line is empty"
            sub="Customers join by scanning your walk-in QR code. You'll see them here with how long they've waited."
            action={<button className="btn btn--secondary" onClick={() => go('settings', 'walkins')}>Get the QR code</button>} />
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr><th>#</th><th>Customer</th><th>Service</th><th>Team member</th><th>Waiting</th><th>Status</th><th className="col-actions">Actions</th></tr>
              </thead>
              <tbody>
                {queue.map(entry => {
                  const waited = Math.max(0, Math.floor((Date.now() - new Date(entry.created_at).getTime()) / 60000));
                  const working = busy[entry.id];
                  return (
                    <tr key={entry.id}>
                      <td className="cell-name num">{entry.position}</td>
                      <td>
                        <div className="cell-name">{entry.customer_name}</div>
                        <div className="cell-sub num">{fmtPhone(entry.customer_phone)}</div>
                      </td>
                      <td>{entry.service || <span className="muted">-</span>}</td>
                      <td>{entry.preferred_barber || <span className="muted">Anyone</span>}</td>
                      <td className="num" style={{ color: waited > 20 ? 'var(--stamp-btn)' : undefined, fontWeight: waited > 20 ? 700 : 400 }}>{waited} min</td>
                      <td><span className={`badge ${entry.status === 'notified' ? 'badge--green' : 'badge--amber'}`}>{entry.status === 'notified' ? 'Notified' : 'Waiting'}</span></td>
                      <td className="col-actions">
                        <div className="table-actions">
                          {entry.status === 'waiting' && (
                            <button className="btn btn--primary btn--sm" disabled={!!working} onClick={() => act(entry, 'notify', `Texted ${entry.customer_name}`)}>
                              <Icon name="bell" />{working === 'notify' ? 'Texting…' : 'Notify'}
                            </button>
                          )}
                          <button className="btn btn--secondary btn--sm" disabled={!!working} onClick={() => act(entry, 'serve', `${entry.customer_name} marked as served`)}>
                            <Icon name="check" />Served
                          </button>
                          <button className="btn btn--ghost btn--sm btn--icon" disabled={!!working} title="Remove from line" aria-label={`Remove ${entry.customer_name}`}
                            onClick={() => act(entry, 'remove', `${entry.customer_name} removed`)}>
                            <Icon name="x" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

// ── Clients ───────────────────────────────────────────────────────────────────
function parseTags(s) {
  return s ? s.split(',').map(t => t.trim()).filter(Boolean) : [];
}

function ClientsPage({ clients, setClients, go, initialSearch }) {
  const toast = useToast();
  const [search, setSearch] = useState(initialSearch || '');
  const [tagFilter, setTagFilter] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', phone: '', notes: '', tags: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { setSearch(initialSearch || ''); }, [initialSearch]);

  const allTags = [...new Set(clients.flatMap(c => c.tags || []))].sort();
  const q = search.trim().toLowerCase();
  const filtered = clients.filter(c => {
    const matchSearch = !q || (c.name || '').toLowerCase().includes(q) || (c.phone || '').includes(q.replace(/[^\d+]/g, '') || q);
    const matchTag = !tagFilter || (c.tags || []).includes(tagFilter);
    return matchSearch && matchTag;
  });

  async function handleCreate(e) {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      const d = await api('/api/clients', {
        method: 'POST',
        body: JSON.stringify({ name: form.name.trim(), phone: form.phone.trim(), notes: form.notes || undefined, tags: parseTags(form.tags) }),
      });
      setClients(prev => [d.client, ...prev]);
      setShowForm(false);
      setForm({ name: '', phone: '', notes: '', tags: '' });
      toast(`${d.client.name} added`);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page-content">
      <div className="toolbar">
        <div className="search">
          <Icon name="search" />
          <input className="input" type="search" placeholder="Search by name or phone" aria-label="Search clients" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        {allTags.length > 0 && (
          <select className="select" style={{ width: 'auto', minWidth: 150 }} aria-label="Filter by tag" value={tagFilter} onChange={e => setTagFilter(e.target.value)}>
            <option value="">All tags</option>
            {allTags.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        )}
        <span className="spacer"></span>
        {!showForm && <button className="btn btn--primary" onClick={() => setShowForm(true)}><Icon name="plus" />Add client</button>}
      </div>

      {showForm && (
        <form onSubmit={handleCreate}>
          <Card title="New client" description="Clients are also added automatically when someone books by phone."
            footer={<>
              {error && <span className="status status--error">{error}</span>}
              <button type="button" className="btn btn--secondary" onClick={() => { setShowForm(false); setError(''); }}>Cancel</button>
              <button type="submit" className="btn btn--primary" disabled={saving}>{saving ? 'Adding…' : 'Add client'}</button>
            </>}>
            <div className="form-grid">
              <Field label="Name" htmlFor="c-name">
                <input id="c-name" className="input" required autoFocus value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
              </Field>
              <Field label="Phone" htmlFor="c-phone" hint="Include the area code, e.g. 416 555 0123">
                <input id="c-phone" className="input" type="tel" required value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} />
              </Field>
              <Field label="Tags" optional htmlFor="c-tags" hint="Separate with commas, e.g. VIP, regular" className="span-2">
                <input id="c-tags" className="input" value={form.tags} onChange={e => setForm(f => ({ ...f, tags: e.target.value }))} />
              </Field>
              <Field label="Notes" optional htmlFor="c-notes" className="span-2">
                <textarea id="c-notes" className="textarea" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
              </Field>
            </div>
          </Card>
        </form>
      )}

      <section className="card">
        {filtered.length === 0 ? (
          clients.length === 0
            ? <EmptyState icon="users" title="No clients yet" sub="Everyone who books through Bimbly is added here automatically, with their visit history." />
            : <EmptyState icon="search" title="No matches" sub="Try a different name or phone number." />
        ) : (
          <>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr><th>Client</th><th>Last visit</th><th className="col-num">Visits</th><th>Usual service</th><th>Usual team member</th><th>Tags</th></tr>
                </thead>
                <tbody>
                  {filtered.map(c => (
                    <tr key={c.id} className="is-clickable" onClick={() => go('client', c.id)}>
                      <td>
                        <button className="link-name" onClick={e => { e.stopPropagation(); go('client', c.id); }}>{c.name}</button>
                        <div className="cell-sub num">{fmtPhone(c.phone) || '-'}</div>
                      </td>
                      <td className="nowrap">{c.last_visit ? fmtDate(c.last_visit) : <span className="muted">-</span>}</td>
                      <td className="col-num">{c.visit_count || 0}</td>
                      <td>{c.preferred_service || <span className="muted">-</span>}</td>
                      <td>{c.preferred_barber || <span className="muted">-</span>}</td>
                      <td>
                        <div className="row" style={{ gap: 4 }}>
                          {(c.tags || []).length ? c.tags.map(t => <span key={t} className="badge badge--blue">{t}</span>) : <span className="muted">-</span>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="table-foot">Showing {filtered.length} of {clients.length} client{clients.length === 1 ? '' : 's'}</div>
          </>
        )}
      </section>
    </div>
  );
}

function ClientProfilePage({ clientId, setClients, go }) {
  const toast = useToast();
  const [client, setClient] = useState(null);
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: '', notes: '', tags: '' });
  const [saving, setSaving] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  const onDepositAction = useDepositAction(setBookings);

  useEffect(() => {
    if (!clientId) { go('clients'); return; }
    setLoading(true);
    api(`/api/clients/${clientId}`)
      .then(d => {
        if (!d.client) { go('clients'); return; }
        setClient(d.client);
        setBookings(d.bookings || []);
        setForm({ name: d.client.name, notes: d.client.notes || '', tags: (d.client.tags || []).join(', ') });
      })
      .catch(() => go('clients'))
      .finally(() => setLoading(false));
  }, [clientId]);

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      const d = await api(`/api/clients/${clientId}`, {
        method: 'PUT',
        body: JSON.stringify({ name: form.name.trim(), notes: form.notes || null, tags: parseTags(form.tags) }),
      });
      setClient(d.client);
      setClients(prev => prev.map(c => c.id === clientId ? { ...c, ...d.client } : c));
      setEditing(false);
      toast('Client updated');
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await api(`/api/clients/${clientId}`, { method: 'DELETE' });
      setClients(prev => prev.filter(c => c.id !== clientId));
      toast(`${client.name} deleted`);
      go('clients');
    } catch (err) {
      toast(err.message, 'error');
      setDeleting(false);
      setConfirmDel(false);
    }
  }

  if (loading) return <Spinner />;
  if (!client) return null;

  const stats = [
    { label: 'Visits', value: client.visit_count ?? 0 },
    { label: 'Last visit', value: client.last_visit ? fmtDate(client.last_visit) : '-' },
    { label: 'Usual service', value: client.preferred_service || '-' },
    { label: 'Usual team member', value: client.preferred_barber || '-' },
  ];

  return (
    <div className="page-content page-narrow" style={{ maxWidth: 1040 }}>
      <button className="btn btn--ghost back-link" onClick={() => go('clients')}><Icon name="back" />All clients</button>

      {editing ? (
        <form onSubmit={handleSave}>
          <Card title="Edit client"
            footer={<>
              {error && <span className="status status--error">{error}</span>}
              <button type="button" className="btn btn--secondary" onClick={() => { setEditing(false); setError(''); }}>Cancel</button>
              <button type="submit" className="btn btn--primary" disabled={saving}>{saving ? 'Saving…' : 'Save client'}</button>
            </>}>
            <div className="form-grid">
              <Field label="Name" htmlFor="e-name">
                <input id="e-name" className="input" required value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
              </Field>
              <Field label="Phone" hint="Phone numbers can't be changed.">
                <input className="input" value={fmtPhone(client.phone)} disabled />
              </Field>
              <Field label="Tags" optional htmlFor="e-tags" hint="Separate with commas" className="span-2">
                <input id="e-tags" className="input" value={form.tags} onChange={e => setForm(f => ({ ...f, tags: e.target.value }))} />
              </Field>
              <Field label="Notes" optional htmlFor="e-notes" className="span-2">
                <textarea id="e-notes" className="textarea" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
              </Field>
            </div>
          </Card>
        </form>
      ) : (
        <section className="card">
          <div className="card-body stack">
            <div className="profile-head">
              <div className="avatar" aria-hidden="true">{initials(client.name)}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <h2 className="profile-name">{client.name}</h2>
                <div className="muted num">{fmtPhone(client.phone)}</div>
                {(client.tags || []).length > 0 && (
                  <div className="tag-list">{client.tags.map(t => <span key={t} className="badge badge--blue">{t}</span>)}</div>
                )}
              </div>
              <div className="row">
                <button className="btn btn--secondary" onClick={() => setEditing(true)}><Icon name="edit" />Edit</button>
                <button className="btn btn--danger-outline" onClick={() => setConfirmDel(true)}><Icon name="trash" />Delete</button>
              </div>
            </div>
            <div className="mini-stats">
              {stats.map(s => (
                <div key={s.label} className="mini-stat">
                  <div className="mini-stat-label">{s.label}</div>
                  <div className="mini-stat-value">{s.value}</div>
                </div>
              ))}
            </div>
            {client.notes && <div className="note-box">{client.notes}</div>}
          </div>
        </section>
      )}

      <Card title="Booking history" flush>
        <BookingsTable bookings={bookings} showCustomer={false} onDepositAction={onDepositAction}
          emptyTitle="No bookings yet" emptySub="This client's appointments will show up here." />
      </Card>

      {confirmDel && (
        <ConfirmDialog title={`Delete ${client.name}?`} confirmLabel="Delete client" busy={deleting}
          onCancel={() => setConfirmDel(false)} onConfirm={handleDelete}>
          The client record will be removed. Their past bookings stay in your booking history.
        </ConfirmDialog>
      )}
    </div>
  );
}

// ── Settings ──────────────────────────────────────────────────────────────────
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const DEFAULT_HOURS = { open: '09:00', close: '18:00', closed: false };

const TIMEZONES = [
  ['America/Toronto', 'Eastern Time (Toronto)'],
  ['America/Halifax', 'Atlantic Time (Halifax)'],
  ['America/St_Johns', 'Newfoundland Time (St. John\'s)'],
  ['America/Winnipeg', 'Central Time (Winnipeg)'],
  ['America/Regina', 'Saskatchewan (Regina)'],
  ['America/Edmonton', 'Mountain Time (Calgary)'],
  ['America/Vancouver', 'Pacific Time (Vancouver)'],
];

const SETTINGS_TABS = [
  { id: 'business', label: 'Business' },
  { id: 'hours',    label: 'Hours' },
  { id: 'services', label: 'Services' },
  { id: 'team',     label: 'Team' },
  { id: 'booking',  label: 'Booking page' },
  { id: 'deposits', label: 'Deposits' },
  { id: 'walkins',  label: 'Walk-ins' },
  { id: 'account',  label: 'Account' },
];

function SettingsPage({ tab, go, onBusinessUpdated }) {
  const [business, setBusiness] = useState(null);
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const current = SETTINGS_TABS.some(t => t.id === tab) ? tab : 'business';

  useEffect(() => {
    Promise.all([api('/api/business'), api('/api/services')])
      .then(([b, s]) => {
        setBusiness(b.business || b);
        setServices(s.services || []);
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const patchBusiness = useCallback(patch => {
    setBusiness(b => ({ ...b, ...patch }));
    onBusinessUpdated && onBusinessUpdated(patch);
  }, [onBusinessUpdated]);

  return (
    <div className="page-content page-narrow">
      <nav className="tabs" role="tablist" aria-label="Settings sections">
        {SETTINGS_TABS.map(t => (
          <button key={t.id} role="tab" aria-selected={current === t.id} className={`tab ${current === t.id ? 'active' : ''}`}
            onClick={() => go('settings', t.id)}>
            {t.label}
          </button>
        ))}
      </nav>

      {loading ? <Spinner /> : error ? <Notice type="error">{error}</Notice> : (
        <div className="stack" key={current}>
          {current === 'business' && <BusinessSettings business={business} onSaved={patchBusiness} />}
          {current === 'hours'    && <HoursSettings business={business} onSaved={patchBusiness} />}
          {current === 'services' && <ServicesSettings services={services} setServices={setServices} />}
          {current === 'team'     && <TeamSettings business={business} onSaved={patchBusiness} go={go} />}
          {current === 'booking'  && <BookingPageSettings business={business} onSaved={patchBusiness} go={go} />}
          {current === 'deposits' && <DepositSettings business={business} onSaved={patchBusiness} />}
          {current === 'walkins'  && <WalkInSettings business={business} onSaved={patchBusiness} />}
          {current === 'account'  && <AccountSettings business={business} onSaved={patchBusiness} go={go} />}
        </div>
      )}
    </div>
  );
}

function CopyButton({ text, label = 'Copy', className = 'btn btn--secondary btn--sm' }) {
  const toast = useToast();
  return (
    <button className={className} onClick={async () => {
      try { await navigator.clipboard.writeText(text); toast('Copied'); }
      catch { toast('Could not copy. Select the text and copy it instead.', 'error'); }
    }}>
      <Icon name="copy" />{label}
    </button>
  );
}

function BusinessSettings({ business, onSaved }) {
  const [form, setForm] = useState({
    name: business.name || '',
    phone: business.phone || '',
    address: business.address || '',
    ai_name: business.ai_name || '',
    timezone: business.timezone || 'America/Toronto',
  });
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useStatus();
  const [dirty, markSaved] = useDirty(form);
  const set = key => e => setForm(f => ({ ...f, [key]: e.target.value }));

  const save = async () => {
    if (!form.name.trim()) { setStatus('error', 'Business name is required.'); return; }
    setSaving(true); setStatus(null);
    try {
      await api('/api/business', { method: 'PUT', body: JSON.stringify(form) });
      markSaved(form);
      onSaved(form);
      setStatus('success', 'Saved');
    } catch (err) {
      setStatus('error', err.message);
    } finally { setSaving(false); }
  };

  return (
    <>
      {business.twilio_phone && (
        <Card title="Your Bimbly line" description="Forward your shop's phone to this number and your AI receptionist answers every call.">
          <div className="link-box">
            <span className="link-box-url num" style={{ fontSize: 20 }}>{fmtPhone(business.twilio_phone)}</span>
            <CopyButton text={business.twilio_phone} />
          </div>
        </Card>
      )}
      <Card title="Business details" description="Your AI receptionist uses these details when it talks to callers."
        footer={<SaveFooter saving={saving} status={status} dirty={dirty} onSave={save} />}>
        <div className="form-grid">
          <Field label="Business name" htmlFor="b-name">
            <input id="b-name" className="input" value={form.name} onChange={set('name')} />
          </Field>
          <Field label="Shop phone number" htmlFor="b-phone" hint="The number customers already call.">
            <input id="b-phone" className="input" type="tel" value={form.phone} onChange={set('phone')} />
          </Field>
          <Field label="Address" htmlFor="b-address" className="span-2" hint="Shared with callers who ask where you are.">
            <input id="b-address" className="input" value={form.address} onChange={set('address')} autoComplete="street-address" />
          </Field>
          <Field label="Receptionist name" htmlFor="b-ai" hint="The name it introduces itself with on calls.">
            <input id="b-ai" className="input" value={form.ai_name} onChange={set('ai_name')} placeholder="e.g. Alex" />
          </Field>
          <Field label="Time zone" htmlFor="b-tz" hint="Used for booking times and reminders.">
            <select id="b-tz" className="select" value={form.timezone} onChange={set('timezone')}>
              {!TIMEZONES.some(([v]) => v === form.timezone) && <option value={form.timezone}>{form.timezone}</option>}
              {TIMEZONES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Field>
        </div>
      </Card>
    </>
  );
}

function HoursSettings({ business, onSaved }) {
  const [hours, setHours] = useState(() => {
    const h = {};
    DAYS.forEach(d => { h[d] = { ...DEFAULT_HOURS, ...(business.business_hours?.[d] || {}) }; });
    return h;
  });
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useStatus();
  const [dirty, markSaved] = useDirty(hours);

  const update = (day, field, value) => setHours(h => ({ ...h, [day]: { ...h[day], [field]: value } }));

  const copyMonday = () => setHours(h => {
    const next = { ...h };
    DAYS.forEach(d => { if (d !== 'monday') next[d] = { ...h.monday }; });
    return next;
  });

  const save = async () => {
    const bad = DAYS.find(d => !hours[d].closed && hours[d].open >= hours[d].close);
    if (bad) { setStatus('error', `${capitalize(bad)}: closing time must be after opening time.`); return; }
    setSaving(true); setStatus(null);
    try {
      await api('/api/business', { method: 'PUT', body: JSON.stringify({ business_hours: hours }) });
      markSaved(hours);
      onSaved({ business_hours: hours });
      setStatus('success', 'Hours saved');
    } catch (err) {
      setStatus('error', err.message);
    } finally { setSaving(false); }
  };

  return (
    <Card title="Opening hours" description="Your AI receptionist only books appointments when you're open."
      action={<button className="btn btn--secondary btn--sm" onClick={copyMonday}><Icon name="copy" />Copy Monday to all days</button>}
      flush footer={<SaveFooter saving={saving} status={status} dirty={dirty} onSave={save} label="Save hours" />}>
      <div className="list-rows">
        {DAYS.map(day => {
          const h = hours[day];
          return (
            <div key={day} className="list-row hours-grid-row">
              <label className="day-name" htmlFor={`open-${day}`}>{capitalize(day)}</label>
              <Switch id={`open-${day}`} label={`Open on ${capitalize(day)}`} checked={!h.closed} onChange={v => update(day, 'closed', !v)} />
              {h.closed ? (
                <span className="hours-closed">Closed</span>
              ) : (
                <div className="hours-times">
                  <input type="time" className="input" aria-label={`${capitalize(day)} opening time`} value={h.open} onChange={e => update(day, 'open', e.target.value)} />
                  <span className="muted">to</span>
                  <input type="time" className="input" aria-label={`${capitalize(day)} closing time`} value={h.close} onChange={e => update(day, 'close', e.target.value)} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function ServicesSettings({ services, setServices }) {
  const toast = useToast();
  const blank = { name: '', price: '', duration_minutes: '30' };
  const [draft, setDraft] = useState(blank);
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState(null);
  const [edit, setEdit] = useState(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [toDelete, setToDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const clean = s => ({
    name: s.name.trim(),
    price: s.price === '' ? null : Number(s.price),
    duration_minutes: s.duration_minutes === '' ? null : parseInt(s.duration_minutes, 10),
  });

  const add = async e => {
    e.preventDefault();
    if (!draft.name.trim()) return;
    setAdding(true);
    try {
      const d = await api('/api/services', { method: 'POST', body: JSON.stringify(clean(draft)) });
      setServices(s => [...s, d.service]);
      setDraft(blank);
      toast(`${d.service.name} added`);
    } catch (err) { toast(err.message, 'error'); }
    finally { setAdding(false); }
  };

  const saveEdit = async () => {
    if (!edit.name.trim()) { toast('Service name is required.', 'error'); return; }
    setSavingEdit(true);
    try {
      const d = await api(`/api/services/${editId}`, { method: 'PUT', body: JSON.stringify(clean(edit)) });
      setServices(s => s.map(x => x.id === editId ? d.service : x));
      setEditId(null);
      toast('Service updated');
    } catch (err) { toast(err.message, 'error'); }
    finally { setSavingEdit(false); }
  };

  const remove = async () => {
    setDeleting(true);
    try {
      await api(`/api/services/${toDelete.id}`, { method: 'DELETE' });
      setServices(s => s.filter(x => x.id !== toDelete.id));
      toast(`${toDelete.name} removed`);
      setToDelete(null);
    } catch (err) { toast(err.message, 'error'); }
    finally { setDeleting(false); }
  };

  const PriceInput = ({ value, onChange, id }) => (
    <div className="input-group">
      <span className="input-addon">$</span>
      <input id={id} className="input" type="number" min="0" step="1" inputMode="decimal" aria-label="Price" value={value} onChange={onChange} />
    </div>
  );
  const DurationInput = ({ value, onChange }) => (
    <div className="input-group input-group--suffix">
      <input className="input" type="number" min="5" step="5" inputMode="numeric" aria-label="Duration in minutes" value={value} onChange={onChange} />
      <span className="input-addon">min</span>
    </div>
  );

  return (
    <Card title="Services" description="What customers can book. Your AI receptionist quotes these prices and uses the length to fit appointments in. Changes save right away." flush>
      <div className="list-rows">
        <div className="list-row list-head svc-grid"><span>Service</span><span>Price</span><span>Length</span><span></span></div>
        {services.length === 0 && <div className="list-empty">No services yet. Add your first one below.</div>}
        {services.map(s => editId === s.id ? (
          <div key={s.id} className="list-row svc-grid">
            <input className="input svc-name" aria-label="Service name" value={edit.name} onChange={e => setEdit(x => ({ ...x, name: e.target.value }))} autoFocus />
            {PriceInput({ value: edit.price, onChange: e => setEdit(x => ({ ...x, price: e.target.value })) })}
            {DurationInput({ value: edit.duration_minutes, onChange: e => setEdit(x => ({ ...x, duration_minutes: e.target.value })) })}
            <div className="list-actions">
              <button className="btn btn--primary btn--sm" onClick={saveEdit} disabled={savingEdit}>{savingEdit ? '…' : 'Save'}</button>
              <button className="btn btn--ghost btn--sm btn--icon" aria-label="Cancel editing" onClick={() => setEditId(null)}><Icon name="x" /></button>
            </div>
          </div>
        ) : (
          <div key={s.id} className="list-row svc-grid">
            <div className="svc-name">
              <div className="cell-name">{s.name}</div>
              {s.description && <div className="cell-sub">{s.description}</div>}
            </div>
            <span className="num">{s.price != null && s.price !== '' ? fmtMoney(s.price, Number(s.price) % 1 ? 2 : 0) : <span className="muted">-</span>}</span>
            <span className="num">{s.duration_minutes ? `${s.duration_minutes} min` : <span className="muted">-</span>}</span>
            <div className="list-actions">
              <button className="btn btn--ghost btn--sm btn--icon" title="Edit" aria-label={`Edit ${s.name}`}
                onClick={() => { setEditId(s.id); setEdit({ name: s.name || '', price: s.price ?? '', duration_minutes: s.duration_minutes ?? '' }); }}>
                <Icon name="edit" />
              </button>
              <button className="btn btn--ghost btn--sm btn--icon" title="Remove" aria-label={`Remove ${s.name}`} onClick={() => setToDelete(s)}>
                <Icon name="trash" />
              </button>
            </div>
          </div>
        ))}
        <form className="list-row list-row--add svc-grid" onSubmit={add}>
          <input className="input svc-name" placeholder="New service, e.g. Skin fade" aria-label="New service name" value={draft.name} onChange={e => setDraft(d => ({ ...d, name: e.target.value }))} />
          {PriceInput({ value: draft.price, onChange: e => setDraft(d => ({ ...d, price: e.target.value })) })}
          {DurationInput({ value: draft.duration_minutes, onChange: e => setDraft(d => ({ ...d, duration_minutes: e.target.value })) })}
          <div className="list-actions">
            <button type="submit" className="btn btn--primary btn--sm" disabled={adding || !draft.name.trim()}><Icon name="plus" />{adding ? 'Adding…' : 'Add'}</button>
          </div>
        </form>
      </div>
      {toDelete && (
        <ConfirmDialog title={`Remove ${toDelete.name}?`} confirmLabel="Remove service" busy={deleting}
          onCancel={() => setToDelete(null)} onConfirm={remove}>
          Customers won't be able to book this service anymore. Existing bookings aren't affected.
        </ConfirmDialog>
      )}
    </Card>
  );
}

function TeamSettings({ business, onSaved, go }) {
  const words = teamWords(business.business_type);
  const plan = business.plan || 'solo';
  const max = teamLimit(plan);
  const [team, setTeam] = useState(() => normalizeTeam(business.team_members || business.barbers));
  const [newName, setNewName] = useState('');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useStatus();
  const [dirty, markSaved] = useDirty(team);
  const atLimit = team.length >= max;

  const update = (i, field, value) => setTeam(t => t.map((m, j) => j === i ? { ...m, [field]: value } : m));
  const add = e => {
    e.preventDefault();
    const name = newName.trim();
    if (!name || atLimit) return;
    setTeam(t => [...t, { name, role: '', calendarId: '' }]);
    setNewName('');
  };

  const save = async () => {
    setSaving(true); setStatus(null);
    try {
      await api('/api/business', { method: 'PUT', body: JSON.stringify({ team_members: team }) });
      markSaved(team);
      onSaved({ team_members: team, barbers: team });
      setStatus('success', 'Team saved');
    } catch (err) {
      setStatus('error', err.message);
    } finally { setSaving(false); }
  };

  return (
    <Card title="Team" description={`Callers can ask for a specific ${words.one} by name. Add a Google Calendar to book straight into someone's calendar.`}
      flush footer={<SaveFooter saving={saving} status={status} dirty={dirty} onSave={save} label="Save team" />}>
      <div className="list-rows">
        <div className="list-row list-head team-grid"><span>Name</span><span>Role</span><span>Google Calendar</span><span></span></div>
        {team.length === 0 && <div className="list-empty">No {words.many} added yet.</div>}
        {team.map((m, i) => (
          <div key={i} className="list-row team-grid">
            <div className="row" style={{ gap: 8, flexWrap: 'nowrap', minWidth: 0 }}>
              <span className="avatar" style={{ width: 30, height: 30, fontSize: 12 }} aria-hidden="true">{initials(m.name)}</span>
              <span className="cell-name" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name}</span>
              {i === 0 && <span className="badge badge--blue">You</span>}
            </div>
            <select className="select" aria-label={`Role for ${m.name}`} value={m.role || ''} onChange={e => update(i, 'role', e.target.value)}>
              <option value="">No role</option>
              {[...new Set([...words.roles, m.role].filter(Boolean))].map(r => <option key={r} value={r}>{r}</option>)}
            </select>
            <input className="input team-cal" type="email" placeholder="name@gmail.com (optional)" aria-label={`Google Calendar for ${m.name}`}
              value={m.calendarId || ''} onChange={e => update(i, 'calendarId', e.target.value)} />
            <div className="list-actions">
              {i !== 0 && (
                <button className="btn btn--ghost btn--sm btn--icon" title="Remove" aria-label={`Remove ${m.name}`} onClick={() => setTeam(t => t.filter((_, j) => j !== i))}>
                  <Icon name="trash" />
                </button>
              )}
            </div>
          </div>
        ))}
        {atLimit ? (
          plan !== 'pro' && (
            <div className="list-row list-row--add" style={{ display: 'block' }}>
              <Notice>
                Your {PLAN_LABELS[plan]} plan includes {max} {max === 1 ? words.one : words.many}.{' '}
                <button className="btn-link" onClick={() => go('billing')}>Upgrade to {plan === 'solo' ? 'Starter' : 'Pro'}</button> to add more.
              </Notice>
            </div>
          )
        ) : (
          <form className="list-row list-row--add team-grid" onSubmit={add}>
            <input className="input team-add-name" placeholder={`Add a ${words.one} by name`} aria-label={`New ${words.one} name`} value={newName} onChange={e => setNewName(e.target.value)} />
            <span></span>
            <div className="list-actions">
              <button type="submit" className="btn btn--secondary btn--sm" disabled={!newName.trim()}><Icon name="plus" />Add</button>
            </div>
          </form>
        )}
      </div>
    </Card>
  );
}

function BookingPageSettings({ business, onSaved, go }) {
  const toast = useToast();
  const [slug, setSlug] = useState(business.booking_slug || '');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useStatus();
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);
  const plan = business.plan || 'solo';
  const url = business.booking_slug ? `${window.location.origin}/book/${business.booking_slug}` : '';
  const prefix = `${window.location.host}/book/`;

  const saveSlug = async () => {
    const value = slug.trim().toLowerCase();
    if (!/^[a-z0-9-]+$/.test(value)) { setStatus('error', 'Use lowercase letters, numbers and hyphens only.'); return; }
    setSaving(true); setStatus(null);
    try {
      const d = await api('/api/business/slug', { method: 'PUT', body: JSON.stringify({ slug: value }) });
      setSlug(d.business.booking_slug);
      onSaved({ booking_slug: d.business.booking_slug });
      setStatus('success', 'Saved');
    } catch (err) {
      setStatus('error', err.message);
    } finally { setSaving(false); }
  };

  const upload = async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { toast('That file is over 2 MB. Try a smaller image.', 'error'); return; }
    setUploading(true);
    try {
      const form = new FormData();
      form.append('logo', file);
      const d = await api('/api/business/logo', { method: 'POST', body: form });
      onSaved({ logo_url: d.logo_url });
      toast('Logo uploaded');
    } catch (err) { toast(err.message, 'error'); }
    finally { setUploading(false); }
  };

  const removeLogo = async () => {
    setUploading(true);
    try {
      await api('/api/business/logo', { method: 'DELETE' });
      onSaved({ logo_url: null });
      toast('Logo removed');
    } catch (err) { toast(err.message, 'error'); }
    finally { setUploading(false); }
  };

  return (
    <>
      <Card title="Online booking page" description="Customers can book themselves at this link. Add it to your Instagram bio and Google listing."
        footer={<SaveFooter saving={saving} status={status} dirty={slug !== (business.booking_slug || '')} onSave={saveSlug} label="Save address" disabled={!slug.trim()} />}>
        <div className="stack">
          {url ? (
            <div className="link-box">
              <span className="link-box-url">{url}</span>
              <CopyButton text={url} label="Copy link" />
              <a className="btn btn--secondary btn--sm" href={url} target="_blank" rel="noopener noreferrer"><Icon name="external" />Open</a>
            </div>
          ) : (
            <Notice>Pick a page address below to turn on your booking page.</Notice>
          )}
          <Field label="Page address" htmlFor="slug" hint="Lowercase letters, numbers and hyphens only.">
            <div className="input-group">
              <span className="input-addon">{prefix}</span>
              <input id="slug" className="input" value={slug} placeholder="sams-barbershop"
                onChange={e => setSlug(e.target.value.toLowerCase().replace(/\s+/g, '-'))} />
            </div>
          </Field>
        </div>
      </Card>

      <Card title="Logo" description="Shown at the top of your booking page.">
        {plan === 'solo' ? (
          <Notice>
            Logo upload is included with Starter and Pro. <button className="btn-link" onClick={() => go('billing')}>See plans</button>
          </Notice>
        ) : (
          <div className="logo-row">
            <div className="logo-preview">
              {business.logo_url ? <img src={business.logo_url} alt="Your logo" /> : 'No logo yet'}
            </div>
            <div className="stack" style={{ gap: 10 }}>
              <div className="row">
                <input ref={fileRef} type="file" accept="image/png,image/jpeg" className="sr-only" onChange={upload} tabIndex={-1} />
                <button className="btn btn--secondary" onClick={() => fileRef.current.click()} disabled={uploading}>
                  <Icon name="upload" />{uploading ? 'Working…' : business.logo_url ? 'Replace logo' : 'Upload logo'}
                </button>
                {business.logo_url && (
                  <button className="btn btn--danger-outline" onClick={removeLogo} disabled={uploading}><Icon name="trash" />Remove</button>
                )}
              </div>
              <p className="field-hint">PNG or JPG, up to 2 MB.</p>
            </div>
          </div>
        )}
      </Card>
    </>
  );
}

function DepositSettings({ business, onSaved }) {
  const [form, setForm] = useState({
    enabled: !!business.deposit_enabled,
    amount: business.deposit_amount != null ? String(business.deposit_amount / 100) : '25',
  });
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useStatus();
  const [dirty, markSaved] = useDirty(form);

  const save = async () => {
    const dollars = parseFloat(form.amount);
    if (form.enabled && !(dollars >= 1)) { setStatus('error', 'Enter a deposit of at least $1.'); return; }
    setSaving(true); setStatus(null);
    const cents = Math.round((dollars || 0) * 100);
    try {
      await api('/api/business', { method: 'PUT', body: JSON.stringify({ deposit_enabled: form.enabled, deposit_amount: cents }) });
      markSaved(form);
      onSaved({ deposit_enabled: form.enabled, deposit_amount: cents });
      setStatus('success', 'Saved');
    } catch (err) {
      setStatus('error', err.message);
    } finally { setSaving(false); }
  };

  return (
    <Card title="No-show deposits" description="Hold a card deposit when someone books. If they don't show, you can charge it from the Bookings page."
      footer={<SaveFooter saving={saving} status={status} dirty={dirty} onSave={save} />}>
      <div className="stack">
        <SwitchRow id="deposit-on" title="Require a deposit to book" description="Customers get a secure link by text to hold their spot."
          checked={form.enabled} onChange={v => setForm(f => ({ ...f, enabled: v }))} />
        {form.enabled && (
          <Field label="Deposit amount" htmlFor="deposit-amt" hint="Charged only if the customer doesn't show up.">
            <div className="input-group" style={{ maxWidth: 200 }}>
              <span className="input-addon">CA$</span>
              <input id="deposit-amt" className="input" type="number" min="1" step="1" inputMode="decimal" value={form.amount}
                onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} />
            </div>
          </Field>
        )}
      </div>
    </Card>
  );
}

function WalkInSettings({ business, onSaved }) {
  const [form, setForm] = useState({
    enabled: !!business.queue_enabled,
    timeout: String(business.queue_notify_timeout ?? 10),
  });
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useStatus();
  const [dirty, markSaved] = useDirty(form);
  const [qrUrl, setQrUrl] = useState(null);

  useEffect(() => {
    if (!business.queue_enabled) return;
    let url;
    apiFetch('/api/queue/qr')
      .then(r => r.ok ? r.blob() : Promise.reject())
      .then(blob => { url = URL.createObjectURL(blob); setQrUrl(url); })
      .catch(() => {});
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [business.queue_enabled]);

  const save = async () => {
    const timeout = parseInt(form.timeout, 10);
    if (form.enabled && !(timeout >= 1 && timeout <= 60)) { setStatus('error', 'Enter a time between 1 and 60 minutes.'); return; }
    setSaving(true); setStatus(null);
    try {
      const patch = { queue_enabled: form.enabled, queue_notify_timeout: timeout || 10 };
      await api('/api/business', { method: 'PUT', body: JSON.stringify(patch) });
      markSaved(form);
      onSaved(patch);
      setStatus('success', 'Saved');
    } catch (err) {
      setStatus('error', err.message);
    } finally { setSaving(false); }
  };

  return (
    <Card title="Walk-in queue" description="Walk-ins scan a QR code to join the line. Bimbly texts them when it's their turn."
      footer={<SaveFooter saving={saving} status={status} dirty={dirty} onSave={save} />}>
      <div className="stack">
        <SwitchRow id="queue-on" title="Turn on walk-in check-in" description="Shows the line on your Walk-ins page."
          checked={form.enabled} onChange={v => setForm(f => ({ ...f, enabled: v }))} />
        {form.enabled && (
          <>
            <Field label="Hold their spot for" htmlFor="queue-timeout" hint="After we text them, they're marked as a no-show if they don't arrive in this time.">
              <div className="input-group input-group--suffix" style={{ maxWidth: 200 }}>
                <input id="queue-timeout" className="input" type="number" min="1" max="60" step="1" value={form.timeout}
                  onChange={e => setForm(f => ({ ...f, timeout: e.target.value }))} />
                <span className="input-addon">minutes</span>
              </div>
            </Field>
            <Field label="Check-in QR code">
              {business.queue_enabled ? (
                <div className="qr-row">
                  {qrUrl ? <img className="qr-img" src={qrUrl} alt="Walk-in check-in QR code" /> : <div className="qr-img" style={{ display: 'grid', placeItems: 'center' }}><div className="spinner"></div></div>}
                  <div className="stack" style={{ gap: 10, maxWidth: 280 }}>
                    <p className="muted">Print it and put it by the door or at the front desk.</p>
                    {qrUrl && <a className="btn btn--secondary" href={qrUrl} download="bimbly-walk-in-qr.png" style={{ alignSelf: 'flex-start' }}><Icon name="download" />Download QR code</a>}
                  </div>
                </div>
              ) : (
                <p className="field-hint">Save to get your QR code.</p>
              )}
            </Field>
          </>
        )}
      </div>
    </Card>
  );
}

function AccountSettings({ business, onSaved, go }) {
  const toast = useToast();
  const [recording, setRecording] = useState(!!business.call_recording_enabled);
  const [recSaving, setRecSaving] = useState(false);
  const [exporting, setExporting] = useState('');
  const plan = business.plan || 'solo';

  const toggleRecording = async enabled => {
    setRecording(enabled);
    setRecSaving(true);
    try {
      await api('/api/business/recording', { method: 'PUT', body: JSON.stringify({ enabled }) });
      onSaved({ call_recording_enabled: enabled });
      toast(enabled ? 'Call recording turned on' : 'Call recording turned off');
    } catch (err) {
      setRecording(!enabled);
      toast(err.message, 'error');
    } finally { setRecSaving(false); }
  };

  const exportCsv = async kind => {
    setExporting(kind);
    try { await downloadFile(`/api/export/${kind}`, `${kind}.csv`); }
    catch (err) { toast(err.message, 'error'); }
    finally { setExporting(''); }
  };

  return (
    <>
      <Card title="Call recording" description="This setting saves as soon as you change it.">
        <SwitchRow id="rec-on" title="Record calls" description="Recordings help you check how calls went. Callers are told the call may be recorded."
          checked={recording} disabled={recSaving} onChange={toggleRecording} />
      </Card>

      <Card title="Export your data" description="Download a spreadsheet (CSV) of your bookings or clients.">
        {plan === 'solo' ? (
          <Notice>Exports are included with Starter and Pro. <button className="btn-link" onClick={() => go('billing')}>See plans</button></Notice>
        ) : (
          <div className="row">
            <button className="btn btn--secondary" onClick={() => exportCsv('bookings')} disabled={!!exporting}>
              <Icon name="download" />{exporting === 'bookings' ? 'Preparing…' : 'Export bookings'}
            </button>
            <button className="btn btn--secondary" onClick={() => exportCsv('clients')} disabled={!!exporting}>
              <Icon name="download" />{exporting === 'clients' ? 'Preparing…' : 'Export clients'}
            </button>
          </div>
        )}
      </Card>

      <ChangePasswordCard email={business.email} />
    </>
  );
}

function ChangePasswordCard({ email }) {
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useStatus();
  const set = key => e => setForm(f => ({ ...f, [key]: e.target.value }));

  async function handleSubmit(e) {
    e.preventDefault();
    setStatus(null);
    const p = form.newPassword;
    const missing = [
      p.length < 8 && 'at least 8 characters',
      !/[A-Z]/.test(p) && 'a capital letter',
      !/[0-9]/.test(p) && 'a number',
      !/[^A-Za-z0-9\s]/.test(p) && 'a special character',
    ].filter(Boolean);
    if (missing.length) { setStatus('error', 'New password needs ' + missing.join(', ') + '.'); return; }
    if (p !== form.confirmPassword) { setStatus('error', "The new passwords don't match."); return; }

    setSaving(true);
    try {
      await api('/api/auth/change-password', { method: 'POST', body: JSON.stringify(form) });
      setForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
      setStatus('success', 'Password updated');
    } catch (err) {
      setStatus('error', err.message);
    } finally { setSaving(false); }
  }

  return (
    <form onSubmit={handleSubmit}>
      <Card title="Password" description={<>Signed in as <strong>{email}</strong>. If you signed up with Google, <a href="/auth/forgot-password-page">set a password first</a>.</>}
        footer={<>
          <SaveStatus status={status} />
          <button type="submit" className="btn btn--primary" disabled={saving}>{saving ? 'Saving…' : 'Update password'}</button>
        </>}>
        <input type="email" autoComplete="username" value={email || ''} readOnly hidden />
        <div className="form-grid">
          <Field label="Current password" htmlFor="pw-current" className="span-2 half">
            <input id="pw-current" className="input" type="password" required autoComplete="current-password" value={form.currentPassword} onChange={set('currentPassword')} />
          </Field>
          <Field label="New password" htmlFor="pw-new" hint="8+ characters, with a capital letter, a number and a symbol.">
            <input id="pw-new" className="input" type="password" required autoComplete="new-password" value={form.newPassword} onChange={set('newPassword')} />
          </Field>
          <Field label="Confirm new password" htmlFor="pw-confirm">
            <input id="pw-confirm" className="input" type="password" required autoComplete="new-password" value={form.confirmPassword} onChange={set('confirmPassword')} />
          </Field>
        </div>
      </Card>
    </form>
  );
}

// ── Billing ───────────────────────────────────────────────────────────────────
const STATUS_INFO = {
  trial:      { tone: 'blue',  label: 'Free trial' },
  trialing:   { tone: 'blue',  label: 'Free trial' },
  active:     { tone: 'green', label: 'Active' },
  cancelling: { tone: 'amber', label: 'Cancels at period end' },
  cancelled:  { tone: '',      label: 'Cancelled' },
  canceled:   { tone: '',      label: 'Cancelled' },
  past_due:   { tone: 'red',   label: 'Payment due' },
  pending:    { tone: '',      label: 'Pending' },
};

const UPGRADE_INFO = {
  solo:    { to: 'starter', label: 'Starter', price: 99,  desc: 'For shops with a small team.' },
  starter: { to: 'pro',     label: 'Pro',     price: 199, desc: 'For busy shops with a bigger team.' },
};

const UPGRADE_FEATURES = {
  solo:    ['Walk-in waitlist management', 'No-show deposit collection', 'Full analytics dashboard', 'Up to 4 team members'],
  starter: ['Unlimited team members', 'Priority support', 'Advanced multi-location analytics', 'Custom AI voice & persona'],
};

const PLAN_FEATURES = [
  '24/7 AI receptionist answers every call',
  'Text confirmations to your customers',
  'Email notifications straight to you',
  'Google Calendar sync',
  'Online dashboard and analytics',
  'Unlimited bookings',
];

function BillingPage({ business }) {
  const toast = useToast();
  const [billing, setBilling] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    api('/api/billing')
      .then(setBilling)
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const cancelSub = async () => {
    setCancelling(true);
    try {
      await api('/api/billing/cancel', { method: 'POST' });
      setBilling(b => ({ ...b, subscription_status: 'cancelling', cancel_at_period_end: true }));
      setShowModal(false);
      toast('Your subscription will end at the close of this billing period');
    } catch (err) {
      toast(err.message, 'error');
    } finally { setCancelling(false); }
  };

  if (loading) return <Spinner />;

  const plan = business?.plan || 'solo';
  const status = billing?.cancel_at_period_end && billing?.subscription_status !== 'cancelled' ? 'cancelling' : (billing?.subscription_status || 'unknown');
  const info = STATUS_INFO[status] || { tone: '', label: capitalize(status) };
  const isTrial = status === 'trial' || status === 'trialing';
  const amount = billing?.amount != null ? Number(billing.amount) : null;
  const upgrade = UPGRADE_INFO[plan];
  const longDate = unix => unix ? new Date(unix * 1000).toLocaleDateString('en-CA', { month: 'long', day: 'numeric', year: 'numeric' }) : null;
  const periodEnd = longDate(billing?.current_period_end);
  const trialEnd = longDate(billing?.trial_end);

  return (
    <div className="page-content page-narrow" style={{ maxWidth: 1000 }}>
      {error && <Notice type="error">{error}</Notice>}
      {status === 'past_due' && <Notice type="error">Your last payment didn't go through. Update your card to keep your receptionist answering calls.</Notice>}

      <div className="billing-grid">
        <section className="card">
          <div className="card-head">
            <div>
              <p className="muted small" style={{ fontWeight: 700 }}>Current plan</p>
              <h2 className="plan-name">Bimbly {PLAN_LABELS[plan] || plan}</h2>
            </div>
            <span className={`badge ${info.tone ? 'badge--' + info.tone : ''}`}>{info.label}</span>
          </div>
          <div className="card-body">
            <div className="plan-price">{amount != null ? `CA$${amount.toFixed(0)}` : '-'}<span> / month{isTrial ? ' after your trial' : ''}</span></div>
            {isTrial && trialEnd && <Notice>Your free trial ends <strong>{trialEnd}</strong>. Your card is charged after that.</Notice>}
            {status === 'cancelling' && <Notice type="warn">Your subscription ends {periodEnd ? <strong>{periodEnd}</strong> : 'at the end of this billing period'}. Your receptionist answers calls until then.</Notice>}
            {!isTrial && status !== 'cancelling' && periodEnd && (
              <dl className="kv"><dt>Next payment</dt><dd>{periodEnd}</dd></dl>
            )}
            <ul className="check-list">
              {PLAN_FEATURES.map(f => <li key={f}><Icon name="check" />{f}</li>)}
            </ul>
          </div>
          {status !== 'cancelled' && status !== 'canceled' && status !== 'cancelling' && (
            <div className="card-foot" style={{ justifyContent: 'flex-start' }}>
              <button className="btn-link btn-link--muted small" onClick={() => setShowModal(true)}>Cancel subscription</button>
            </div>
          )}
        </section>

        {upgrade ? (
          <section className="card card--upgrade">
            <div className="card-head" style={{ borderBottomColor: 'transparent' }}>
              <div>
                <p className="small" style={{ fontWeight: 700, color: 'var(--ink-deep)' }}>Upgrade</p>
                <h2 className="plan-name">Bimbly {upgrade.label}</h2>
                <p className="card-desc">{upgrade.desc}</p>
              </div>
            </div>
            <div className="card-body">
              <div className="plan-price">CA${upgrade.price}<span> / month</span></div>
              <ul className="check-list">
                {(UPGRADE_FEATURES[plan] || []).map(f => <li key={f}><Icon name="check" />{f}</li>)}
              </ul>
              <button className="btn btn--primary btn--block" style={{ marginTop: 'auto' }}
                onClick={() => { window.location.href = `/billing/checkout?businessId=${business?.id}&plan=${upgrade.to}`; }}>
                Upgrade to {upgrade.label}<Icon name="arrow" />
              </button>
            </div>
          </section>
        ) : (
          <section className="card card--upgrade">
            <div className="card-body" style={{ justifyContent: 'center', alignItems: 'center', textAlign: 'center' }}>
              <div className="empty-icon" style={{ margin: 0 }}><Icon name="sparkle" /></div>
              <h2 className="plan-name">You're on our top plan</h2>
              <p className="muted">Thanks for being a Pro member. Questions? Email <a href="mailto:hello@bimblyai.com">hello@bimblyai.com</a>.</p>
            </div>
          </section>
        )}
      </div>

      {showModal && (
        <ConfirmDialog title="Cancel your subscription?" confirmLabel="Yes, cancel" cancelLabel="Keep my plan" busy={cancelling}
          onCancel={() => setShowModal(false)} onConfirm={cancelSub}>
          Your service continues until <strong>{periodEnd || trialEnd || 'the end of the billing period'}</strong>. After that, your AI receptionist stops answering calls.
        </ConfirmDialog>
      )}
    </div>
  );
}

// ── Onboarding ────────────────────────────────────────────────────────────────
const SERVICE_DEFAULTS = {
  'Barbershop': [
    { name: "Men's Haircut", price: '35', duration_minutes: '30' },
    { name: 'Beard Trim',    price: '20', duration_minutes: '20' },
    { name: "Kid's Haircut", price: '25', duration_minutes: '20' },
    { name: 'Shape Up',      price: '25', duration_minutes: '20' },
  ],
  'Hair Salon': [
    { name: 'Haircut',    price: '55',  duration_minutes: '45' },
    { name: 'Blowout',    price: '45',  duration_minutes: '45' },
    { name: 'Colour',     price: '120', duration_minutes: '120' },
    { name: 'Highlights', price: '150', duration_minutes: '150' },
  ],
  'Nail Salon': [
    { name: 'Manicure',         price: '35', duration_minutes: '30' },
    { name: 'Pedicure',         price: '45', duration_minutes: '45' },
    { name: 'Gel Manicure',     price: '50', duration_minutes: '45' },
    { name: 'Acrylic Full Set', price: '65', duration_minutes: '60' },
  ],
};

const BIZ_TYPE_MAP = { 'barbershop': 'Barbershop', 'hair-salon': 'Hair Salon', 'hair salon': 'Hair Salon', 'nail-salon': 'Nail Salon', 'nail salon': 'Nail Salon' };

function OnboardingPage({ go }) {
  const [step, setStep] = useState(1);
  const [saving, setSaving] = useState(false);
  const [newBarber, setNewBarber] = useState('');
  const [bizPhone, setBizPhone] = useState(null);
  const [stepError, setStepError] = useState('');
  const [loadingData, setLoadingData] = useState(true);
  const [plan, setPlan] = useState('solo');
  const [data, setData] = useState({
    name: '', phone: '', address: '', ai_name: '',
    business_type: 'Barbershop', timezone: 'America/Toronto',
    business_hours: {}, services: SERVICE_DEFAULTS['Barbershop'], barbers: [],
  });

  const setField = (key, val) => setData(d => ({ ...d, [key]: val }));
  const steps = plan === 'solo' ? ['Business', 'Services', 'Go live'] : ['Business', 'Services', 'Team', 'Go live'];
  const last = steps.length;
  const stepName = steps[step - 1];

  useEffect(() => {
    Promise.all([api('/api/business'), api('/api/services')])
      .then(([b, s]) => {
        const biz = b.business || b;
        const svcs = s.services || [];
        const bizType = BIZ_TYPE_MAP[(biz.business_type || '').toLowerCase()] || biz.business_type || 'Barbershop';
        setPlan(biz.plan || 'solo');
        setBizPhone(biz.twilio_phone || null);
        const team = normalizeTeam(biz.team_members || biz.barbers);
        setData({
          name: biz.name || '',
          phone: biz.phone || '',
          address: biz.address || '',
          ai_name: biz.ai_name || '',
          business_type: bizType,
          timezone: biz.timezone || 'America/Toronto',
          business_hours: biz.business_hours || {},
          barbers: team.length ? team : (biz.owner_name ? [{ name: biz.owner_name, role: '', calendarId: '' }] : []),
          services: svcs.length > 0
            ? svcs.map(x => ({ name: x.name || '', price: x.price ?? '', duration_minutes: x.duration_minutes ?? '', description: x.description }))
            : (SERVICE_DEFAULTS[bizType] || SERVICE_DEFAULTS['Barbershop']),
        });
      })
      .catch(() => {})
      .finally(() => setLoadingData(false));
  }, []);

  const changeType = type => setData(d => ({ ...d, business_type: type, services: SERVICE_DEFAULTS[type] || d.services }));

  const updateSvc = (i, key, val) => setData(d => ({ ...d, services: d.services.map((s, j) => j === i ? { ...s, [key]: val } : s) }));
  const removeSvc = i => setData(d => ({ ...d, services: d.services.filter((_, j) => j !== i) }));

  const addBarber = e => {
    e && e.preventDefault();
    if (!newBarber.trim() || data.barbers.length >= teamLimit(plan)) return;
    setData(d => ({ ...d, barbers: [...d.barbers, { name: newBarber.trim(), role: '', calendarId: '' }] }));
    setNewBarber('');
  };

  const validate = n => {
    if (steps[n - 1] === 'Business') {
      if (!data.name.trim()) return 'Enter your business name.';
      if (!data.phone.trim()) return 'Enter your shop phone number.';
    }
    if (steps[n - 1] === 'Services') {
      if (data.services.length === 0) return 'Add at least one service.';
      for (const svc of data.services) {
        if (!String(svc.name).trim()) return 'Each service needs a name.';
        if (svc.price === '' || svc.price == null) return `Add a price for ${svc.name}.`;
      }
    }
    return '';
  };

  const complete = async () => {
    setSaving(true);
    setStepError('');
    try {
      await api('/api/business', {
        method: 'PUT',
        body: JSON.stringify({
          name: data.name, phone: data.phone, address: data.address, ai_name: data.ai_name,
          business_type: data.business_type, timezone: data.timezone,
          business_hours: data.business_hours, team_members: data.barbers,
        }),
      });
      await api('/api/services/replace', { method: 'PUT', body: JSON.stringify({ services: data.services }) });
      try {
        await apiFetch('/onboarding/complete', {
          method: 'POST',
          body: JSON.stringify({ services: data.services, barbers: data.barbers, timezone: data.timezone, supported_languages: data.supported_languages }),
        });
      } catch (vapiErr) {
        console.warn('Receptionist update failed (non-fatal):', vapiErr);
      }
      go('home');
    } catch (err) {
      setStepError(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (loadingData) return <Spinner />;

  return (
    <div className="onboarding-wrap">
      <section className="card onboarding-card">
        <div className="card-body">
          <ol className="steps" aria-label="Setup progress" style={{ listStyle: 'none', padding: 0 }}>
            {steps.map((label, i) => {
              const n = i + 1;
              return (
                <React.Fragment key={label}>
                  {i > 0 && <li className="step-line" aria-hidden="true"></li>}
                  <li className={`step ${n === step ? 'active' : n < step ? 'done' : ''}`} aria-current={n === step ? 'step' : undefined}>
                    <span className="step-dot">{n < step ? <Icon name="check" /> : n}</span>
                    <span className="step-label">{label}</span>
                  </li>
                </React.Fragment>
              );
            })}
          </ol>

          {stepName === 'Business' && (
            <>
              <h2 className="step-title">Let's set up your receptionist</h2>
              <p className="step-sub">Tell us about your shop so your AI receptionist can answer like it works there.</p>
              <div className="form-grid">
                <Field label="Business name" htmlFor="o-name" className="span-2">
                  <input id="o-name" className="input" value={data.name} onChange={e => setField('name', e.target.value)} placeholder="Sam's Barbershop" />
                </Field>
                <Field label="Shop phone number" htmlFor="o-phone" className="span-2" hint="The number customers call now. You'll forward it to Bimbly in the last step.">
                  <input id="o-phone" className="input" type="tel" value={data.phone} onChange={e => setField('phone', e.target.value)} placeholder="416 555 0123" />
                </Field>
                <Field label="Address" optional htmlFor="o-address" className="span-2">
                  <input id="o-address" className="input" value={data.address} onChange={e => setField('address', e.target.value)} placeholder="123 Main St, Toronto, ON" />
                </Field>
                <Field label="Type of business" htmlFor="o-type">
                  <select id="o-type" className="select" value={data.business_type} onChange={e => changeType(e.target.value)}>
                    <option value="Barbershop">Barbershop</option>
                    <option value="Hair Salon">Hair salon</option>
                    <option value="Nail Salon">Nail salon</option>
                  </select>
                </Field>
                <Field label="Receptionist name" optional htmlFor="o-ai">
                  <input id="o-ai" className="input" value={data.ai_name} onChange={e => setField('ai_name', e.target.value)} placeholder="e.g. Alex" />
                </Field>
                <Field label="Time zone" htmlFor="o-tz" className="span-2">
                  <select id="o-tz" className="select" value={data.timezone} onChange={e => setField('timezone', e.target.value)}>
                    {!TIMEZONES.some(([v]) => v === data.timezone) && <option value={data.timezone}>{data.timezone}</option>}
                    {TIMEZONES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </Field>
              </div>
            </>
          )}

          {stepName === 'Services' && (
            <>
              <h2 className="step-title">What do you offer?</h2>
              <p className="step-sub">We filled in common services. Change the prices to match yours.</p>
              <div className="stack" style={{ gap: 8 }}>
                <div className="svc-edit-row svc-edit-head" aria-hidden="true"><span>Service</span><span>Price</span><span className="svc-dur">Length</span><span></span></div>
                {data.services.map((svc, i) => (
                  <div key={i} className="svc-edit-row">
                    <input className="input" aria-label="Service name" placeholder="Service name" value={svc.name} onChange={e => updateSvc(i, 'name', e.target.value)} />
                    <div className="input-group">
                      <span className="input-addon">$</span>
                      <input className="input" type="number" min="0" aria-label="Price" value={svc.price} onChange={e => updateSvc(i, 'price', e.target.value)} />
                    </div>
                    <div className="input-group input-group--suffix svc-dur">
                      <input className="input" type="number" min="5" step="5" aria-label="Length in minutes" value={svc.duration_minutes} onChange={e => updateSvc(i, 'duration_minutes', e.target.value)} />
                      <span className="input-addon">min</span>
                    </div>
                    <button className="btn btn--ghost btn--icon" aria-label={`Remove ${svc.name || 'service'}`} onClick={() => removeSvc(i)}><Icon name="trash" /></button>
                  </div>
                ))}
                <button className="btn btn--secondary" style={{ alignSelf: 'flex-start', marginTop: 4 }}
                  onClick={() => setData(d => ({ ...d, services: [...d.services, { name: '', price: '', duration_minutes: '30' }] }))}>
                  <Icon name="plus" />Add a service
                </button>
              </div>
            </>
          )}

          {stepName === 'Team' && (
            <>
              <h2 className="step-title">Who works with you?</h2>
              <p className="step-sub">
                Callers can ask for someone by name.
                {plan === 'starter' && ' Your Starter plan includes up to 4 people.'}
              </p>
              <div className="chips" style={{ marginBottom: 16 }}>
                {data.barbers.map((b, i) => (
                  <span key={i} className={`chip ${i === 0 ? 'chip--fixed' : ''}`}>
                    {b.name}{i === 0 && <span style={{ fontWeight: 400 }}>(you)</span>}
                    {i > 0 && (
                      <button className="chip-remove" aria-label={`Remove ${b.name}`} onClick={() => setData(d => ({ ...d, barbers: d.barbers.filter((_, j) => j !== i) }))}>
                        <Icon name="x" />
                      </button>
                    )}
                  </span>
                ))}
                {data.barbers.length === 0 && <span className="muted">No one added yet.</span>}
              </div>
              {data.barbers.length < teamLimit(plan) ? (
                <form className="row" style={{ flexWrap: 'nowrap' }} onSubmit={addBarber}>
                  <input className="input" placeholder="Name" aria-label="Team member name" value={newBarber} onChange={e => setNewBarber(e.target.value)} />
                  <button type="submit" className="btn btn--secondary" disabled={!newBarber.trim()}><Icon name="plus" />Add</button>
                </form>
              ) : (
                <p className="field-hint">You've reached the limit for your plan.</p>
              )}
            </>
          )}

          {stepName === 'Go live' && (
            <>
              <h2 className="step-title">You're almost live</h2>
              <p className="step-sub">Forward your shop's phone to your Bimbly number. From then on, every call gets answered.</p>
              <div className="forward-box">
                <div className="forward-label">Your Bimbly number</div>
                <div className="forward-number">{bizPhone ? fmtPhone(bizPhone) : 'Being set up'}</div>
              </div>
              <div className="instructions" style={{ marginTop: 24 }}>
                <div>
                  <h3>iPhone</h3>
                  <ol>
                    <li>Open <strong>Settings → Phone → Call Forwarding</strong></li>
                    <li>Turn on <strong>Call Forwarding</strong></li>
                    <li>Enter your Bimbly number</li>
                  </ol>
                </div>
                <div>
                  <h3>Android</h3>
                  <ol>
                    <li>Open <strong>Phone → Settings → Calls</strong></li>
                    <li>Tap <strong>Call forwarding → Always forward</strong></li>
                    <li>Enter your Bimbly number</li>
                  </ol>
                </div>
              </div>
              <p className="field-hint" style={{ marginTop: 16 }}>Using a landline? Your phone company can turn on forwarding for you.</p>
            </>
          )}

          {stepError && <div style={{ marginTop: 20 }}><Notice type="error">{stepError}</Notice></div>}

          <div className="step-actions">
            {step > 1 && <button className="btn btn--ghost" onClick={() => { setStepError(''); setStep(s => s - 1); }}><Icon name="back" />Back</button>}
            {step < last ? (
              <button className="btn btn--primary" onClick={() => {
                const err = validate(step);
                if (err) { setStepError(err); return; }
                setStepError('');
                setStep(s => s + 1);
              }}>Continue<Icon name="arrow" /></button>
            ) : (
              <button className="btn btn--primary" onClick={complete} disabled={saving}>
                {saving ? 'Finishing setup…' : "I've forwarded my number"}
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

// ── Routing (hash-based, so refresh and the back button work) ────────────────
function parseHash() {
  const parts = window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  return { page: parts[0] || 'home', sub: parts[1] ? decodeURIComponent(parts[1]) : null };
}

const TITLES = {
  home: 'Dashboard',
  bookings: 'Bookings',
  queue: 'Walk-ins',
  clients: 'Clients',
  client: 'Client',
  settings: 'Settings',
  billing: 'Billing',
  onboarding: 'Setup wizard',
};

// ── App ───────────────────────────────────────────────────────────────────────
function App() {
  const [authed, setAuthed] = useState(false);
  const [route, setRoute] = useState(parseHash);
  const [business, setBusiness] = useState(null);
  const [clients, setClients] = useState([]);
  const [queue, setQueue] = useState([]);
  const [menuOpen, setMenuOpen] = useState(false);

  const go = useCallback((page, sub) => {
    const hash = '#/' + page + (sub ? '/' + encodeURIComponent(sub) : '');
    if (window.location.hash !== hash) window.location.hash = hash;
    else setRoute(parseHash());
    setMenuOpen(false);
  }, []);

  useEffect(() => {
    const onHash = () => { setRoute(parseHash()); setMenuOpen(false); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get('token');
    if (urlToken) {
      localStorage.setItem('bimbly_token', urlToken);
      const url = new URL(window.location.href);
      url.searchParams.delete('token');
      window.history.replaceState({}, '', url);
    }
    if (!localStorage.getItem('bimbly_token')) {
      window.location.href = API_BASE + '/auth/dashboard/login';
      return;
    }
    setAuthed(true);
    api('/api/business').then(d => setBusiness(d.business || d)).catch(() => {});
    api('/api/clients').then(d => setClients(d.clients || [])).catch(() => {});
  }, []);

  // Keep the walk-in count fresh for the sidebar badge and the home page.
  useEffect(() => {
    if (!authed) return;
    const load = () => api('/api/queue').then(d => setQueue(d.queue || [])).catch(() => {});
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [authed]);

  useEffect(() => {
    document.title = `${TITLES[route.page] || 'Dashboard'} | Bimbly`;
  }, [route.page]);

  const onBusinessUpdated = useCallback(patch => setBusiness(b => ({ ...(b || {}), ...patch })), []);

  if (!authed) return <div className="loading-screen"><div className="spinner"></div></div>;

  const { page, sub } = route;
  const known = TITLES[page] ? page : 'home';

  return (
    <div className="app-layout">
      <Sidebar page={known} go={go} business={business} open={menuOpen} onClose={() => setMenuOpen(false)} queueCount={queue.length} />
      <div className="main-area">
        <TopBar title={TITLES[known]} onMenu={() => setMenuOpen(true)} />
        <main className="content-area" id="main">
          {known === 'home'       && <DashboardHome business={business} go={go} queue={queue} />}
          {known === 'bookings'   && <BookingsPage clients={clients} go={go} />}
          {known === 'queue'      && <QueuePage business={business} go={go} onQueueChange={setQueue} />}
          {known === 'clients'    && <ClientsPage clients={clients} setClients={setClients} go={go} initialSearch={sub} />}
          {known === 'client'     && <ClientProfilePage key={sub} clientId={sub} setClients={setClients} go={go} />}
          {known === 'settings'   && <SettingsPage tab={sub} go={go} onBusinessUpdated={onBusinessUpdated} />}
          {known === 'billing'    && <BillingPage business={business} />}
          {known === 'onboarding' && <OnboardingPage go={go} />}
        </main>
      </div>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<ToastProvider><App /></ToastProvider>);
