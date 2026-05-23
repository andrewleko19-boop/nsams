// directorate/script.js
// ── DB من window.NSAMS_DB (يُحمَّل عبر shared/db.js قبل هذا الملف) ──────────
const {
  login,
  logout,
  getCurrentUser,
  getTodaySummary,
  getSchoolsAttendanceStatus,
  getReportsForDirectorate,
  updateReportStatus,
} = window.NSAMS_DB;

// ══════════════════════════════════════════════
//  State
// ══════════════════════════════════════════════
let map;
let markersLayer = {};
let allReports   = [];
let refreshTimer;
let countdownInterval;
let currentUser  = null;
const REFRESH_INTERVAL = 30;

// ══════════════════════════════════════════════
//  Bootstrap
// ══════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  setNavDate();
  setupLoginForm();

  const user = await getCurrentUser();
  if (user && user.role === 'directorate_user') {
    currentUser = user;
    showApp(user);
    await loadAll();
    startAutoRefresh();
  } else if (user) {
    showLoginError('هذه البوابة مخصصة لموظفي المديرية فقط.');
    await logout();
  }
});

// ══════════════════════════════════════════════
//  Login
// ══════════════════════════════════════════════
function setupLoginForm() {
  const btn   = document.getElementById('login-btn');
  const errEl = document.getElementById('login-error');

  btn.addEventListener('click', async () => {
    errEl.classList.add('hidden');
    const email    = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;

    if (!email || !password) {
      showLoginError('يرجى إدخال البريد الإلكتروني وكلمة المرور.');
      return;
    }

    btn.disabled    = true;
    btn.textContent = 'Signing in…';

    try {
      const session = await login(email, password);

      if (session.role !== 'directorate_user') {
        await logout();
        throw new Error('هذا الحساب لا يملك صلاحية الوصول للمديرية.');
      }

      currentUser = session;
      showApp(session);
      await loadAll();
      startAutoRefresh();
    } catch (err) {
      showLoginError(err.message || 'فشل تسجيل الدخول، يرجى المحاولة مجدداً.');
    } finally {
      btn.disabled    = false;
      btn.textContent = 'Sign In';
    }
  });

  document.getElementById('login-password')
    .addEventListener('keydown', e => { if (e.key === 'Enter') btn.click(); });
}

function showLoginError(msg) {
  const el = document.getElementById('login-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

// ══════════════════════════════════════════════
//  Show / hide screens
// ══════════════════════════════════════════════
function showApp(session) {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('nav-user').textContent =
    session.user?.fullName || session.user?.email || '';

  initMap();
  setupLogout();
  setupFilters();
  setupManualRefresh();
}

// ══════════════════════════════════════════════
//  Logout
// ══════════════════════════════════════════════
function setupLogout() {
  document.getElementById('logout-btn').addEventListener('click', async () => {
    clearAutoRefresh();
    await logout();
    location.reload();
  });
}

// ══════════════════════════════════════════════
//  Map
// ══════════════════════════════════════════════
function initMap() {
  if (map) return;

  map = L.map('map', {
    center: [35.2, 38.0],
    zoom: 7,
    zoomControl: true,
    attributionControl: true,
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/">OpenStreetMap</a>',
    maxZoom: 18,
  }).addTo(map);
}

function makeMarkerIcon(color) {
  const palette = { green: '#22c55e', amber: '#f59e0b', red: '#ef4444', gray: '#4f5f80' };
  const fill = palette[color] || palette.gray;
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="28" height="36" viewBox="0 0 28 36">
      <path d="M14 0C6.268 0 0 6.268 0 14c0 9.917 14 22 14 22S28 23.917 28 14C28 6.268 21.732 0 14 0z"
        fill="${fill}" stroke="#0b0f1a" stroke-width="1.5"/>
      <circle cx="14" cy="14" r="6" fill="#0b0f1a" fill-opacity="0.45"/>
    </svg>`;
  return L.divIcon({
    html: svg,
    className: '',
    iconSize:    [28, 36],
    iconAnchor:  [14, 36],
    popupAnchor: [0, -36],
  });
}

async function loadMap() {
  if (!currentUser?.directorateId) return;
  try {
    const today    = new Date().toISOString().slice(0, 10);
    const statusMap = await getSchoolsAttendanceStatus(currentUser.directorateId, today);
    // statusMap = { schoolId: "green"|"orange"|"red" }

    // نحتاج مواقع المدارس — نجلبها من db
    const { getSchools } = window.NSAMS_DB;
    const schools = await getSchools(currentUser.directorateId);
    if (!schools || schools.length === 0) return;

    const currentIds = new Set(schools.map(s => s.id));
    for (const [id, marker] of Object.entries(markersLayer)) {
      if (!currentIds.has(id)) { map.removeLayer(marker); delete markersLayer[id]; }
    }

    for (const school of schools) {
      const rawColor = statusMap[school.id] || 'gray';
      const color    = rawColor === 'orange' ? 'amber' : rawColor;
      const icon     = makeMarkerIcon(color);
      const lat      = school.lat;
      const lng      = school.lng;
      if (!lat || !lng) continue;

      const popup = `
        <div class="popup-school-name">${esc(school.name)}</div>
        <div class="popup-row"><span>Status</span><span>${esc(rawColor)}</span></div>`;

      if (markersLayer[school.id]) {
        markersLayer[school.id].setIcon(icon);
        markersLayer[school.id].setPopupContent(popup);
      } else {
        markersLayer[school.id] = L.marker([lat, lng], { icon })
          .bindPopup(popup)
          .addTo(map);
      }
    }
  } catch (err) {
    console.error('[Map] Failed:', err);
    showToast('Map Error', 'Could not load school locations.', 'error');
  }
}

// ══════════════════════════════════════════════
//  Stats
// ══════════════════════════════════════════════
async function loadStats() {
  if (!currentUser?.directorateId) return;
  try {
    const summary = await getTodaySummary(currentUser.directorateId);
    if (!summary) return;

    const set = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val ?? '—';
    };

    set('stat-teachers-val', summary.totalTeachersPresent);
    set('stat-students-val', summary.totalStudentsPresent);
    set('stat-reports-val',  summary.topPendingReports?.length ?? 0);
    set('stat-reports-sub',  'active reports');
  } catch (err) {
    console.error('[Stats] Failed:', err);
    showToast('Stats Error', 'Could not load summary.', 'error');
  }
}

// ══════════════════════════════════════════════
//  Reports
// ══════════════════════════════════════════════
async function loadReports() {
  if (!currentUser?.directorateId) return;
  try {
    allReports = await getReportsForDirectorate(currentUser.directorateId) || [];
    renderReportsTable();
    renderPendingList();
  } catch (err) {
    console.error('[Reports] Failed:', err);
    showToast('Reports Error', 'Could not load reports.', 'error');
    document.getElementById('reports-tbody').innerHTML =
      '<tr><td colspan="6" class="empty-state">Failed to load reports.</td></tr>';
  }
}

function renderReportsTable() {
  const statusFilter = document.getElementById('filter-status').value;
  const typeFilter   = document.getElementById('filter-type').value;

  const filtered = allReports.filter(r => {
    if (statusFilter && r.status !== statusFilter) return false;
    if (typeFilter   && r.type   !== typeFilter)   return false;
    return true;
  });

  const tbody = document.getElementById('reports-tbody');
  if (filtered.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="6" class="empty-state">No reports match the current filters.</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(r => `
    <tr data-id="${esc(r.id)}">
      <td class="td-primary">${esc(r.schoolName ?? '—')}</td>
      <td><span class="type-badge type-${esc(r.type)}">${esc(formatType(r.type))}</span></td>
      <td class="td-desc" title="${esc(r.description ?? '')}">${esc(r.description ?? '—')}</td>
      <td>${esc(formatDate(r.created_at))}</td>
      <td><span class="status-badge status-${esc(r.status)}">${esc(capitalize(r.status))}</span></td>
      <td>
        <div class="table-actions">
          ${r.status === 'open'
            ? `<button class="btn btn-warning btn-sm" onclick="handleStatusUpdate('${esc(r.id)}','acknowledged')">Review</button>`
            : ''}
          ${r.status !== 'resolved'
            ? `<button class="btn btn-success btn-sm" onclick="handleStatusUpdate('${esc(r.id)}','resolved')">Resolve</button>`
            : `<button class="btn btn-ghost btn-sm" disabled>Resolved</button>`}
        </div>
      </td>
    </tr>
  `).join('');
}

function renderPendingList() {
  const pending = allReports.filter(r => r.status === 'open' || r.status === 'acknowledged');
  const countEl = document.getElementById('pending-count');
  countEl.textContent = pending.length;
  countEl.className   = `badge ${pending.length > 0 ? 'badge--amber' : 'badge--green'}`;

  const container = document.getElementById('pending-list');
  if (pending.length === 0) {
    container.innerHTML = '<p class="empty-state">No pending reports.</p>';
    return;
  }

  container.innerHTML = pending.map(r => `
    <div class="pending-card" data-id="${esc(r.id)}">
      <div class="pending-school">${esc(r.schoolName ?? '—')}</div>
      <span class="type-badge type-${esc(r.type)}">${esc(formatType(r.type))}</span>
      <div class="pending-desc">${esc(r.description ?? '—')}</div>
      <div class="pending-time">${esc(formatDate(r.created_at))}</div>
      <div class="pending-actions">
        ${r.status === 'open'
          ? `<button class="btn btn-warning btn-sm" onclick="handleStatusUpdate('${esc(r.id)}','acknowledged')">Mark Reviewed</button>`
          : ''}
        <button class="btn btn-success btn-sm" onclick="handleStatusUpdate('${esc(r.id)}','resolved')">Resolve</button>
      </div>
    </div>
  `).join('');
}

window.handleStatusUpdate = async (reportId, newStatus) => {
  const btns = document.querySelectorAll(`[data-id="${reportId}"] button`);
  btns.forEach(b => (b.disabled = true));
  try {
    await updateReportStatus(reportId, newStatus);
    showToast('Status Updated', `Report marked as ${newStatus}.`, 'success');
    await loadReports();
  } catch (err) {
    console.error('[Reports] Status update failed:', err);
    showToast('Update Failed', err.message || 'Could not update status.', 'error');
    btns.forEach(b => (b.disabled = false));
  }
};

function setupFilters() {
  document.getElementById('filter-status').addEventListener('change', renderReportsTable);
  document.getElementById('filter-type').addEventListener('change', renderReportsTable);
}

// ══════════════════════════════════════════════
//  Orchestrator
// ══════════════════════════════════════════════
async function loadAll() {
  await Promise.allSettled([loadStats(), loadMap(), loadReports()]);
}

// ══════════════════════════════════════════════
//  Auto-refresh
// ══════════════════════════════════════════════
function startAutoRefresh() {
  clearAutoRefresh();
  let remaining = REFRESH_INTERVAL;

  countdownInterval = setInterval(() => {
    remaining -= 1;
    const el = document.getElementById('countdown-val');
    if (el) el.textContent = remaining;
    if (remaining <= 0) remaining = REFRESH_INTERVAL;
  }, 1000);

  refreshTimer = setInterval(async () => {
    remaining = REFRESH_INTERVAL;
    await loadAll();
  }, REFRESH_INTERVAL * 1000);
}

function clearAutoRefresh() {
  clearInterval(refreshTimer);
  clearInterval(countdownInterval);
}

function setupManualRefresh() {
  document.getElementById('manual-refresh-btn').addEventListener('click', async () => {
    clearAutoRefresh();
    await loadAll();
    const el = document.getElementById('countdown-val');
    if (el) el.textContent = REFRESH_INTERVAL;
    startAutoRefresh();
    showToast('Refreshed', 'Dashboard data updated.', 'info');
  });
}

// ══════════════════════════════════════════════
//  Helpers
// ══════════════════════════════════════════════
function setNavDate() {
  const el = document.getElementById('nav-date');
  if (!el) return;
  el.textContent = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
}

function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function formatType(type) {
  const types = {
    security_threat:      'Security Threat',
    infrastructure_damage:'Infrastructure Damage',
    health_emergency:     'Health Emergency',
    natural_disaster:     'Natural Disaster',
    teacher_shortage:     'Teacher Shortage',
    other:                'Other',
  };
  return types[type] ?? capitalize(type ?? '');
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// ══════════════════════════════════════════════
//  Toast
// ══════════════════════════════════════════════
function showToast(title, message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast     = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.innerHTML = `
    <div class="toast-dot"></div>
    <div class="toast-body">
      <div class="toast-title">${esc(title)}</div>
      <div class="toast-msg">${esc(message)}</div>
    </div>`;
  container.appendChild(toast);

  const duration = type === 'error' ? 6000 : 3500;
  setTimeout(() => {
    toast.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
    toast.style.opacity    = '0';
    toast.style.transform  = 'translateY(8px)';
    setTimeout(() => toast.remove(), 320);
  }, duration);
}