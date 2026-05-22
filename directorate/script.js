// directorate/script.js
import {
  initSupabase,
  loginUser,
  logoutUser,
  getCurrentUser,
  getTodaySummary,
  getSchoolsAttendanceStatus,
  getReportsForDirectorate,
  updateReportStatus,
} from '../shared/db.js';

// ══════════════════════════════════════════════
//  Bootstrap
// ══════════════════════════════════════════════
let supabase;
let map;
let markersLayer = {};       // schoolId → marker
let allReports = [];
let refreshTimer;
let countdownInterval;
const REFRESH_INTERVAL = 30; // seconds

document.addEventListener('DOMContentLoaded', async () => {
  supabase = initSupabase();
  setNavDate();
  setupLoginForm();

  const user = await getCurrentUser(supabase);
  if (user && isDirectorateUser(user)) {
    showApp(user);
    await loadAll();
    startAutoRefresh();
  } else if (user) {
    // Logged in but wrong role
    showToast('Access Denied', 'This portal is for directorate staff only.', 'error');
    await logoutUser(supabase);
  }
  // else: login screen is already visible by default
});

// ══════════════════════════════════════════════
//  Role check
// ══════════════════════════════════════════════
function isDirectorateUser(user) {
  const meta = user.user_metadata || {};
  const appMeta = user.app_metadata || {};
  return (
    meta.role === 'directorate_user' ||
    appMeta.role === 'directorate_user'
  );
}

// ══════════════════════════════════════════════
//  Login
// ══════════════════════════════════════════════
function setupLoginForm() {
  const btn = document.getElementById('login-btn');
  const errEl = document.getElementById('login-error');

  btn.addEventListener('click', async () => {
    errEl.classList.add('hidden');
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;

    if (!email || !password) {
      showLoginError('Please enter your email and password.');
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Signing in…';

    try {
      const { user, error } = await loginUser(supabase, email, password);
      if (error) throw error;
      if (!isDirectorateUser(user)) {
        await logoutUser(supabase);
        throw new Error('This account does not have directorate access.');
      }
      showApp(user);
      await loadAll();
      startAutoRefresh();
    } catch (err) {
      showLoginError(err.message || 'Login failed. Please try again.');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign In';
    }
  });

  // Enter key support
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
function showApp(user) {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('nav-user').textContent = user.email;

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
    await logoutUser(supabase);
    location.reload();
  });
}

// ══════════════════════════════════════════════
//  Map initialisation
// ══════════════════════════════════════════════
function initMap() {
  if (map) return; // already initialised

  map = L.map('map', {
    center: [35.2, 38.0], // Syria centre
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
    iconSize: [28, 36],
    iconAnchor: [14, 36],
    popupAnchor: [0, -36],
  });
}

async function loadMap() {
  try {
    const schools = await getSchoolsAttendanceStatus(supabase);
    if (!schools || schools.length === 0) return;

    // Remove stale markers not in the new list
    const currentIds = new Set(schools.map(s => s.id));
    for (const [id, marker] of Object.entries(markersLayer)) {
      if (!currentIds.has(id)) { map.removeLayer(marker); delete markersLayer[id]; }
    }

    for (const school of schools) {
      const color = resolveMarkerColor(school);
      const icon = makeMarkerIcon(color);
      const lat = school.latitude ?? school.lat;
      const lng = school.longitude ?? school.lng;

      if (!lat || !lng) continue;

      const popup = buildPopupHTML(school);

      if (markersLayer[school.id]) {
        markersLayer[school.id].setIcon(icon);
        markersLayer[school.id].setPopupContent(popup);
      } else {
        const marker = L.marker([lat, lng], { icon })
          .bindPopup(popup)
          .addTo(map);
        markersLayer[school.id] = marker;
      }
    }
  } catch (err) {
    console.error('[Map] Failed to load school markers:', err);
    showToast('Map Error', 'Could not load school locations.', 'error');
  }
}

function resolveMarkerColor(school) {
  // Expects db.js to return a status field, falling back to rate calculation
  if (school.status) {
    if (school.status === 'normal')   return 'green';
    if (school.status === 'low')      return 'amber';
    if (school.status === 'critical') return 'red';
    if (school.status === 'no_data')  return 'gray';
  }
  // Fallback: derive from attendance rate
  const rate = school.attendance_rate ?? school.student_rate ?? null;
  if (rate === null) return 'gray';
  if (rate >= 80)   return 'green';
  if (rate >= 60)   return 'amber';
  return 'red';
}

function buildPopupHTML(school) {
  const rate = school.attendance_rate ?? school.student_rate;
  const rateStr = rate != null ? `${Math.round(rate)}%` : 'N/A';
  const teachers = school.teachers_present ?? '—';
  const students = school.students_present ?? '—';
  return `
    <div class="popup-school-name">${esc(school.name)}</div>
    <div class="popup-row"><span>Attendance</span><span>${esc(rateStr)}</span></div>
    <div class="popup-row"><span>Teachers Present</span><span>${esc(String(teachers))}</span></div>
    <div class="popup-row"><span>Students Present</span><span>${esc(String(students))}</span></div>
  `;
}

// ══════════════════════════════════════════════
//  Stats
// ══════════════════════════════════════════════
async function loadStats() {
  try {
    const summary = await getTodaySummary(supabase);
    if (!summary) return;

    const setVal = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val ?? '—';
    };

    setVal('stat-teachers-val', summary.teachers_present ?? summary.teachersPresent);
    setVal('stat-teachers-sub', formatSub(summary.teachers_present, summary.teachers_total, 'total'));

    setVal('stat-students-val', summary.students_present ?? summary.studentsPresent);
    setVal('stat-students-sub', formatSub(summary.students_present, summary.students_total, 'total'));

    setVal('stat-reports-val',  summary.active_reports ?? summary.activeReports ?? 0);
    setVal('stat-reports-sub',  summary.pending_reports != null
      ? `${summary.pending_reports} pending`
      : '');

    setVal('stat-schools-val',  summary.schools_reporting ?? summary.schoolsReporting ?? 0);
    setVal('stat-schools-sub',  summary.schools_total != null
      ? `of ${summary.schools_total} total`
      : '');
  } catch (err) {
    console.error('[Stats] Failed to load summary:', err);
    showToast('Stats Error', 'Could not load today\'s summary.', 'error');
  }
}

function formatSub(present, total, label) {
  if (present != null && total != null) return `of ${total} ${label}`;
  return '';
}

// ══════════════════════════════════════════════
//  Reports table
// ══════════════════════════════════════════════
async function loadReports() {
  try {
    allReports = await getReportsForDirectorate(supabase) || [];
    renderReportsTable();
    renderPendingList();
  } catch (err) {
    console.error('[Reports] Failed to load:', err);
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
    if (typeFilter   && r.report_type !== typeFilter)   return false;
    return true;
  });

  const tbody = document.getElementById('reports-tbody');
  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No reports match the current filters.</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(report => `
    <tr data-id="${esc(report.id)}">
      <td class="td-primary">${esc(report.school_name ?? report.schools?.name ?? '—')}</td>
      <td><span class="type-badge type-${esc(report.report_type)}">${esc(formatType(report.report_type))}</span></td>
      <td class="td-desc" title="${esc(report.description ?? '')}">${esc(report.description ?? '—')}</td>
      <td>${esc(formatDate(report.created_at))}</td>
      <td><span class="status-badge status-${esc(report.status)}">${esc(capitalize(report.status))}</span></td>
      <td>
        <div class="table-actions">
          ${report.status === 'pending'
            ? `<button class="btn btn-warning btn-sm" onclick="handleStatusUpdate('${esc(report.id)}', 'reviewed')">Review</button>`
            : ''}
          ${report.status !== 'resolved'
            ? `<button class="btn btn-success btn-sm" onclick="handleStatusUpdate('${esc(report.id)}', 'resolved')">Resolve</button>`
            : ''}
          ${report.status === 'resolved'
            ? `<button class="btn btn-ghost btn-sm" disabled>Resolved</button>`
            : ''}
        </div>
      </td>
    </tr>
  `).join('');
}

function renderPendingList() {
  const pending = allReports.filter(r => r.status === 'pending');
  const countEl = document.getElementById('pending-count');
  countEl.textContent = pending.length;
  countEl.className = `badge ${pending.length > 0 ? 'badge--amber' : 'badge--green'}`;

  const container = document.getElementById('pending-list');
  if (pending.length === 0) {
    container.innerHTML = '<p class="empty-state">No pending reports.</p>';
    return;
  }

  container.innerHTML = pending.map(r => `
    <div class="pending-card" data-id="${esc(r.id)}">
      <div class="pending-school">${esc(r.school_name ?? r.schools?.name ?? '—')}</div>
      <span class="type-badge type-${esc(r.report_type)}">${esc(formatType(r.report_type))}</span>
      <div class="pending-desc">${esc(r.description ?? '—')}</div>
      <div class="pending-time">${esc(formatDate(r.created_at))}</div>
      <div class="pending-actions">
        <button class="btn btn-warning btn-sm" onclick="handleStatusUpdate('${esc(r.id)}', 'reviewed')">Mark Reviewed</button>
        <button class="btn btn-success btn-sm" onclick="handleStatusUpdate('${esc(r.id)}', 'resolved')">Resolve</button>
      </div>
    </div>
  `).join('');
}

// Exposed globally so inline onclick handlers can reach it
window.handleStatusUpdate = async (reportId, newStatus) => {
  const btns = document.querySelectorAll(`[data-id="${reportId}"] button`);
  btns.forEach(b => (b.disabled = true));

  try {
    const { error } = await updateReportStatus(supabase, reportId, newStatus);
    if (error) throw error;
    showToast('Status Updated', `Report marked as ${newStatus}.`, 'success');
    await loadReports(); // re-render both table and pending list
  } catch (err) {
    console.error('[Reports] Status update failed:', err);
    showToast('Update Failed', err.message || 'Could not update report status.', 'error');
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
  await Promise.allSettled([
    loadStats(),
    loadMap(),
    loadReports(),
  ]);
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
    // Reset countdown
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
  const map = {
    low_attendance: 'Low Attendance',
    absent_teacher: 'Absent Teacher',
    other:          'Other',
  };
  return map[type] ?? capitalize(type ?? '');
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// ══════════════════════════════════════════════
//  Toast System
// ══════════════════════════════════════════════
function showToast(title, message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.innerHTML = `
    <div class="toast-dot"></div>
    <div class="toast-body">
      <div class="toast-title">${esc(title)}</div>
      <div class="toast-msg">${esc(message)}</div>
    </div>
  `;
  container.appendChild(toast);

  const duration = type === 'error' ? 6000 : 3500;
  setTimeout(() => {
    toast.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(8px)';
    setTimeout(() => toast.remove(), 320);
  }, duration);
}