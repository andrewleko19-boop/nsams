// ─── FIX #1: الاستيراد يعمل الآن لأن db.js يصدر supabase صراحةً ──────────────
import { supabase } from '../shared/db.js';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const loginScreen   = document.getElementById('login-screen');
const dashboard     = document.getElementById('dashboard');
const loginBtn      = document.getElementById('login-btn');
const logoutBtn     = document.getElementById('logout-btn');
const refreshBtn    = document.getElementById('refresh-btn');
const exportBtn     = document.getElementById('export-btn');
const emailInput    = document.getElementById('email');
const passwordInput = document.getElementById('password');
const loginError    = document.getElementById('login-error');
const userEmailEl   = document.getElementById('user-email');
const todayLabel    = document.getElementById('today-label');
const lastUpdated   = document.getElementById('last-updated');

// Stats
const statGov     = document.getElementById('stat-governorates');
const statTotal   = document.getElementById('stat-total');    // schools reported
const statPresent = document.getElementById('stat-present');
const statAbsent  = document.getElementById('stat-absent');   // schools NOT reported
const statRate    = document.getElementById('stat-rate');

// Table
const tableLoading = document.getElementById('table-loading');
const tableWrapper = document.getElementById('table-wrapper');
const tableEmpty   = document.getElementById('table-empty');
const govTbody     = document.getElementById('gov-tbody');
const govTfoot     = document.getElementById('gov-tfoot');

// ── State ─────────────────────────────────────────────────────────────────────
let tableData = [];

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmt  = (n) => (n === null || n === undefined) ? '—' : Number(n).toLocaleString();
const pct  = (part, total) => total > 0 ? ((part / total) * 100).toFixed(1) + '%' : '—';
const today = () => new Date().toISOString().split('T')[0];

function showError(msg) {
  loginError.textContent = msg;
  loginError.classList.remove('hidden');
}

function hideError() {
  loginError.classList.add('hidden');
}

function setLastUpdated() {
  lastUpdated.textContent = 'Last updated: ' + new Date().toLocaleTimeString();
}

function setTodayLabel() {
  todayLabel.textContent = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
}

function rateBadge(rate) {
  if (rate === null) return '<span class="badge badge-none">No Data</span>';
  const n = parseFloat(rate);
  if (n >= 90) return '<span class="badge badge-good">Good</span>';
  if (n >= 75) return '<span class="badge badge-warning">Fair</span>';
  return '<span class="badge badge-poor">Poor</span>';
}

function rateBarClass(rate) {
  if (rate === null) return '';
  const n = parseFloat(rate);
  if (n >= 90) return 'green';
  if (n >= 75) return 'yellow';
  return 'red';
}

// ── Auth ──────────────────────────────────────────────────────────────────────
async function checkSession() {
  const { data: { session } } = await supabase.auth.getSession();
  if (session) {
    const ok = await verifyRole(session.user.id);
    if (ok) {
      showDashboard(session.user.email);
    } else {
      await supabase.auth.signOut();
    }
  }
}

async function verifyRole(userId) {
  const { data, error } = await supabase
    .from('users')
    .select('role')
    .eq('id', userId)
    .single();

  if (error || !data) return false;
  return data.role === 'ministry_user';
}

loginBtn.addEventListener('click', async () => {
  hideError();
  const email    = emailInput.value.trim();
  const password = passwordInput.value;

  if (!email || !password) { showError('Please enter email and password.'); return; }

  loginBtn.disabled    = true;
  loginBtn.textContent = 'Signing in…';

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    showError(error.message);
    loginBtn.disabled    = false;
    loginBtn.textContent = 'Sign In';
    return;
  }

  const ok = await verifyRole(data.user.id);
  if (!ok) {
    showError('Access denied. This portal is for Ministry users only.');
    await supabase.auth.signOut();
    loginBtn.disabled    = false;
    loginBtn.textContent = 'Sign In';
    return;
  }

  showDashboard(data.user.email);
});

logoutBtn.addEventListener('click', async () => {
  await supabase.auth.signOut();
  dashboard.classList.add('hidden');
  loginScreen.classList.remove('hidden');
  loginBtn.disabled    = false;
  loginBtn.textContent = 'Sign In';
  emailInput.value    = '';
  passwordInput.value = '';
  tableData = [];
});

function showDashboard(email) {
  loginScreen.classList.add('hidden');
  dashboard.classList.remove('hidden');
  userEmailEl.textContent = email;
  setTodayLabel();
  loadAllData();
}

// ── Data Fetching ─────────────────────────────────────────────────────────────
//
// الـ schema الفعلي (من setup.sql):
//   directorates(id, name, governorate)
//   schools(id, directorate_id, name, ...)
//   daily_attendance(id, school_id, date, students_present, teachers_present)
//
// لا يوجد attendance_records أو students — الحضور مجمع لكل مدرسة يومياً.
// المقياس المستخدم:
//   - "Students Present" = مجموع students_present من daily_attendance
//   - "Schools Reported" = عدد المدارس التي رفعت سجل اليوم
//   - "Schools Silent"   = المدارس التي لم ترفع (totalSchools - schoolsReported)
//
async function loadAllData() {
  tableLoading.classList.remove('hidden');
  tableWrapper.classList.add('hidden');
  tableEmpty.classList.add('hidden');
  [statGov, statTotal, statPresent, statAbsent, statRate].forEach(el => el.textContent = '—');

  try {
    // 1. جميع المديريات
    const { data: directorates, error: dirErr } = await supabase
      .from('directorates')
      .select('id, name, governorate')
      .order('governorate');
    if (dirErr) throw dirErr;

    if (!directorates || directorates.length === 0) { showEmpty('No directorates found.'); return; }

    // 2. جميع المدارس مع معرف المديرية
    const { data: schools, error: schErr } = await supabase
      .from('schools')
      .select('id, directorate_id');
    if (schErr) throw schErr;

    const allSchoolIds = (schools || []).map(s => s.id);

    // 3. سجلات الحضور اليومية لهذا اليوم فقط
    //    نختار students_present و teachers_present — وهي الأعمدة الموجودة فعلياً
    const { data: attendance, error: attErr } = await supabase
      .from('daily_attendance')
      .select('school_id, students_present, teachers_present')
      .eq('date', today())
      .in('school_id', allSchoolIds.length > 0 ? allSchoolIds : ['__none__']);
    if (attErr) throw attErr;

    // بناء خرائط البحث
    const schoolToDir  = {};
    const dirToSchools = {};
    for (const s of schools || []) {
      schoolToDir[s.id] = s.directorate_id;
      if (!dirToSchools[s.directorate_id]) dirToSchools[s.directorate_id] = new Set();
      dirToSchools[s.directorate_id].add(s.id);
    }

    // تجميع حسب المديرية
    const dirAgg = {};
    for (const d of directorates) {
      dirAgg[d.id] = {
        studentsPresent: 0,
        teachersPresent: 0,
        schoolsReported: 0,
        totalSchools:    dirToSchools[d.id]?.size || 0,
      };
    }
    for (const rec of attendance || []) {
      const dirId = schoolToDir[rec.school_id];
      if (dirId && dirAgg[dirId]) {
        dirAgg[dirId].studentsPresent += rec.students_present || 0;
        dirAgg[dirId].teachersPresent += rec.teachers_present || 0;
        dirAgg[dirId].schoolsReported++;
      }
    }

    // تجميع حسب المحافظة
    const govMap = {};
    for (const d of directorates) {
      const gov = d.governorate || 'Unknown';
      if (!govMap[gov]) {
        govMap[gov] = {
          governorate:     gov,
          studentsPresent: 0,
          teachersPresent: 0,
          schoolsReported: 0,
          totalSchools:    0,
          dirCount:        0,
        };
      }
      const agg = dirAgg[d.id];
      govMap[gov].studentsPresent += agg.studentsPresent;
      govMap[gov].teachersPresent += agg.teachersPresent;
      govMap[gov].schoolsReported += agg.schoolsReported;
      govMap[gov].totalSchools    += agg.totalSchools;
      govMap[gov].dirCount++;
    }

    const rows = Object.values(govMap).sort((a, b) => a.governorate.localeCompare(b.governorate));

    if (rows.length === 0) { showEmpty('No data available.'); return; }

    renderStats(rows);
    renderTable(rows);
    setLastUpdated();

  } catch (err) {
    console.error('NSAMS Ministry load error:', err);
    tableLoading.classList.add('hidden');
    tableEmpty.textContent = 'Error loading data: ' + (err.message || String(err));
    tableEmpty.classList.remove('hidden');
  }
}

function showEmpty(msg = 'No attendance data available for today.') {
  tableLoading.classList.add('hidden');
  tableEmpty.textContent = msg;
  tableEmpty.classList.remove('hidden');
}

// ── Render Stats ──────────────────────────────────────────────────────────────
function renderStats(rows) {
  let totalStudentsPresent = 0;
  let totalSchoolsReported = 0;
  let totalSchools         = 0;

  for (const r of rows) {
    totalStudentsPresent += r.studentsPresent;
    totalSchoolsReported += r.schoolsReported;
    totalSchools         += r.totalSchools;
  }

  const schoolsSilent = totalSchools - totalSchoolsReported;

  statGov.textContent     = rows.length;                   // عدد المحافظات
  statTotal.textContent   = fmt(totalSchoolsReported);     // مدارس رفعت
  statPresent.textContent = fmt(totalStudentsPresent);     // طلاب حاضرون
  statAbsent.textContent  = fmt(Math.max(0, schoolsSilent)); // مدارس لم ترفع
  statRate.textContent    = pct(totalSchoolsReported, totalSchools); // نسبة رفع التقارير
}

// ── Render Table ──────────────────────────────────────────────────────────────
function renderTable(rows) {
  tableLoading.classList.add('hidden');
  tableData = rows;

  let totStudentsPresent = 0;
  let totSchoolsReported = 0;
  let totSchools         = 0;

  govTbody.innerHTML = rows.map((row, i) => {
    const reportingRate    = row.totalSchools > 0
      ? (row.schoolsReported / row.totalSchools * 100)
      : null;
    const reportingRateStr = reportingRate !== null ? reportingRate.toFixed(1) : null;
    const barClass         = rateBarClass(reportingRateStr);
    const barWidth         = reportingRate !== null ? reportingRate.toFixed(1) : 0;

    totStudentsPresent += row.studentsPresent;
    totSchoolsReported += row.schoolsReported;
    totSchools         += row.totalSchools;

    const schoolsSilent = row.totalSchools - row.schoolsReported;

    return `
      <tr>
        <td>${i + 1}</td>
        <td><strong>${row.governorate}</strong></td>
        <td>${fmt(row.totalSchools)}</td>
        <td>${fmt(row.studentsPresent)}</td>
        <td style="color:#4ade80">${fmt(row.schoolsReported)}</td>
        <td style="color:#f87171">${fmt(Math.max(0, schoolsSilent))}</td>
        <td>
          <div class="rate-cell">
            <div class="rate-bar-bg">
              <div class="rate-bar-fill ${barClass}" style="width:${barWidth}%"></div>
            </div>
            <span class="rate-text" style="color:${
              barClass === 'green'  ? '#4ade80' :
              barClass === 'yellow' ? '#fde047' :
              barClass === 'red'    ? '#f87171' : '#64748b'
            }">
              ${reportingRateStr !== null ? reportingRateStr + '%' : '—'}
            </span>
          </div>
        </td>
        <td>${rateBadge(reportingRateStr)}</td>
      </tr>`;
  }).join('');

  const nationalRate = totSchools > 0
    ? (totSchoolsReported / totSchools * 100).toFixed(1)
    : null;

  govTfoot.innerHTML = `
    <tr>
      <td></td>
      <td>National Total</td>
      <td>${fmt(totSchools)}</td>
      <td>${fmt(totStudentsPresent)}</td>
      <td style="color:#4ade80">${fmt(totSchoolsReported)}</td>
      <td style="color:#f87171">${fmt(Math.max(0, totSchools - totSchoolsReported))}</td>
      <td>${nationalRate !== null ? nationalRate + '%' : '—'}</td>
      <td>${rateBadge(nationalRate)}</td>
    </tr>`;

  tableWrapper.classList.remove('hidden');
}

// ── Refresh ───────────────────────────────────────────────────────────────────
// FIX #2: الكود الأصلي كان يخلط destructuring مع .then() — هذا async صحيح
refreshBtn.addEventListener('click', async () => {
  const { data: { session } } = await supabase.auth.getSession();
  if (session) loadAllData();
});

// ── CSV Export ────────────────────────────────────────────────────────────────
exportBtn.addEventListener('click', () => {
  if (!tableData.length) return;

  const dateStr = today();
  const headers = ['Governorate', 'Total Schools', 'Students Present', 'Schools Reported', 'Schools Silent', 'Reporting Rate (%)'];

  const csvRows = [
    `# NSAMS – National Attendance Report – ${dateStr}`,
    headers.join(','),
    ...tableData.map(row => {
      const rate = row.totalSchools > 0
        ? (row.schoolsReported / row.totalSchools * 100).toFixed(1)
        : '';
      return [
        `"${row.governorate}"`,
        row.totalSchools,
        row.studentsPresent,
        row.schoolsReported,
        Math.max(0, row.totalSchools - row.schoolsReported),
        rate,
      ].join(',');
    }),
  ];

  // سطر المجاميع
  let tSchools = 0, tStudents = 0, tReported = 0;
  tableData.forEach(r => {
    tSchools   += r.totalSchools;
    tStudents  += r.studentsPresent;
    tReported  += r.schoolsReported;
  });
  const tRate = tSchools > 0 ? (tReported / tSchools * 100).toFixed(1) : '';
  csvRows.push([
    '"National Total"', tSchools, tStudents, tReported,
    Math.max(0, tSchools - tReported), tRate,
  ].join(','));

  const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `nsams_national_report_${dateStr}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

// ── Boot ──────────────────────────────────────────────────────────────────────
checkSession();