// ============================================================
// CRM AI Agents Platform — Core Utilities
// Supabase client, auth, shared helpers
// ============================================================

// ── Supabase config ──────────────────────────────────────────
// Replace with your Supabase project URL and anon key
const SUPABASE_URL  = 'https://YOUR_PROJECT.supabase.co';
const SUPABASE_ANON = 'YOUR_ANON_KEY';

const _supabase = supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

// ── Session state ─────────────────────────────────────────────
let CRM_USER   = null;   // auth.user
let CRM_TENANT = null;   // crm_tenants row
let CRM_ROLE   = null;   // 'admin' | 'staff'

// ── Auth helpers ──────────────────────────────────────────────

async function initCRM() {
  const { data: { session } } = await _supabase.auth.getSession();
  if (!session) {
    window.location.href = '../index.html';
    return false;
  }
  CRM_USER = session.user;

  // Load CRM user profile + tenant
  const { data: profile } = await _supabase
    .from('crm_users')
    .select('*, crm_tenants(*)')
    .eq('id', CRM_USER.id)
    .single();

  if (!profile) {
    await _supabase.auth.signOut();
    window.location.href = '../index.html';
    return false;
  }

  CRM_ROLE   = profile.role;
  CRM_TENANT = profile.crm_tenants;

  // Inject tenant name into sidebar
  const el = document.getElementById('tenantName');
  if (el) el.textContent = CRM_TENANT.name;

  // Apply tenant brand color
  if (CRM_TENANT.primary_color) {
    document.documentElement.style.setProperty('--primary', CRM_TENANT.primary_color);
    document.documentElement.style.setProperty('--primary-hover',
      adjustColor(CRM_TENANT.primary_color, -20));
  }

  return true;
}

async function signOut() {
  await _supabase.auth.signOut();
  window.location.href = '../index.html';
}

// ── XSS-safe helpers (ported from index.html:1507) ───────────

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function escAttr(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── UUID (ported from index.html:1491) ────────────────────────

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2,6);
}

// ── Currency (ported from index.html:2229) ────────────────────

function fmt$(n) {
  const num = parseFloat(n) || 0;
  return '$' + num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Date helpers ──────────────────────────────────────────────

function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
}

function fmtDateTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
}

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - new Date(ts).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7)  return `${d}d ago`;
  return fmtDate(ts);
}

// ── Phone helper ──────────────────────────────────────────────

function fmtPhone(p) {
  if (!p) return '—';
  const d = p.replace(/\D/g,'');
  if (d.length === 10) return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
  if (d.length === 11) return `+${d[0]} (${d.slice(1,4)}) ${d.slice(4,7)}-${d.slice(7)}`;
  return p;
}

// ── Color helper (lighten/darken hex) ────────────────────────

function adjustColor(hex, amount) {
  const num = parseInt(hex.replace('#',''), 16);
  const r = Math.min(255, Math.max(0, (num >> 16) + amount));
  const g = Math.min(255, Math.max(0, ((num >> 8) & 0xff) + amount));
  const b = Math.min(255, Math.max(0, (num & 0xff) + amount));
  return '#' + ((1<<24)|(r<<16)|(g<<8)|b).toString(16).slice(1);
}

// ── Toast notifications (ported from index.html:4874) ────────

function toast(msg, type = 'success') {
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    document.body.appendChild(container);
  }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ── Supabase Edge Function caller ────────────────────────────

async function callEdgeFunction(name, payload = {}) {
  const { data: { session } } = await _supabase.auth.getSession();
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session?.access_token || SUPABASE_ANON}`
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// ── Generic Supabase query helpers ───────────────────────────

async function dbSelect(table, query = {}) {
  let q = _supabase.from(table).select(query.select || '*');
  if (query.eq)     Object.entries(query.eq).forEach(([k,v]) => q = q.eq(k, v));
  if (query.order)  q = q.order(query.order, { ascending: query.asc ?? false });
  if (query.limit)  q = q.limit(query.limit);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

async function dbInsert(table, row) {
  const { data, error } = await _supabase.from(table).insert(row).select().single();
  if (error) throw error;
  return data;
}

async function dbUpdate(table, id, updates) {
  const { data, error } = await _supabase.from(table).update(updates).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

async function dbDelete(table, id) {
  const { error } = await _supabase.from(table).delete().eq('id', id);
  if (error) throw error;
}

// ── Modal helpers ─────────────────────────────────────────────

function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('open');
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('open');
}

function openSlideover(id) {
  document.getElementById(id + 'Backdrop')?.classList.add('open');
  document.getElementById(id)?.classList.add('open');
}

function closeSlideover(id) {
  document.getElementById(id + 'Backdrop')?.classList.remove('open');
  document.getElementById(id)?.classList.remove('open');
}

// ── Status badge helper ───────────────────────────────────────

function statusBadge(status) {
  const map = {
    lead:        ['badge-lead',       'Lead'],
    prospect:    ['badge-prospect',   'Prospect'],
    customer:    ['badge-customer',   'Customer'],
    inactive:    ['badge-inactive',   'Inactive'],
    quoted:      ['badge-prospect',   'Quoted'],
    booked:      ['badge-booked',     'Booked'],
    in_progress: ['badge-inprogress', 'In Progress'],
    completed:   ['badge-completed',  'Completed'],
    invoiced:    ['badge-invoiced',   'Invoiced'],
    paid:        ['badge-paid',       'Paid'],
    cancelled:   ['badge-cancelled',  'Cancelled'],
    missed:      ['badge-missed',     'Missed'],
    answered:    ['badge-answered',   'Answered'],
    ai_handled:  ['badge-ai',         'AI Handled'],
  };
  const [cls, label] = map[status] || ['badge-lead', status];
  return `<span class="badge ${cls}">${label}</span>`;
}

// ── Activity icon helper ──────────────────────────────────────

function activityIcon(type, direction) {
  const icons = {
    call:          direction === 'inbound' ? '📞' : '📲',
    sms:           '💬',
    note:          '📝',
    status_change: '🔄',
    payment:       '💳',
  };
  const cls = {
    call: 'ai-call', sms: 'ai-sms', note: 'ai-note',
    status_change: 'ai-status', payment: 'ai-payment'
  };
  return `<div class="activity-icon ${cls[type] || 'ai-status'}">${icons[type] || '•'}</div>`;
}

// ── Sidebar nav active state ──────────────────────────────────

function setActiveNav() {
  const page = window.location.pathname.split('/').pop();
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.page === page);
  });
}

// ── Hamburger menu (mobile) ───────────────────────────────────

function initMobileMenu() {
  const toggle = document.getElementById('menuToggle');
  const sidebar = document.querySelector('.sidebar');
  toggle?.addEventListener('click', () => sidebar?.classList.toggle('open'));
  document.addEventListener('click', e => {
    if (!sidebar?.contains(e.target) && !toggle?.contains(e.target)) {
      sidebar?.classList.remove('open');
    }
  });
}

// ── Init on DOM ready ─────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  setActiveNav();
  initMobileMenu();
});
