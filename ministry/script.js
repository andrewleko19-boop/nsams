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
const statTotal   = document.getElementById('stat-total');
const statPresent = document.getElementById('stat-present');
const statAbsent  = document.getElementById('stat-absent');
const statRate    = document.getElementById('stat-rate');

// Table
const tableLoading = document.getElementById('table-loading');
const tableWrapper = document.getElementById('table-wrapper');
const tableEmpty   = document.getElementById('table-empty');
const govTbody     = document.getElementById('gov-tbody');
const govTfoot     = document.getElementById('gov-tfoot');

// ── State ─────────────────────────────────────────────────────────────────────
let tableData = []; // array of row objects for CSV export

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmt = (n) => (n === null || n === undefined) ? '—' : Number(n).toLocaleString();
const pct = (part, total) => total > 0 ? ((part / total) * 100).toFixed(1) + '%' : '—';
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

  loginBtn.disabled = true;
  loginBtn.textContent = 'Signing in…';

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    showError(error.message);
    loginBtn.disabled = false;
    loginBtn.textContent = 'Sign In';
    return;
  }

  const ok = await verifyRole(data.user.id);
  if (!ok) {
    showError('Access denied. This portal is for Ministry users only.');
    await supabase.auth.signOut();
    loginBtn.disabled = false;
    loginBtn.textContent = 'Sign In';
    return;
  }

  showDashboard(data.user.email);
});

logoutBtn.addEventListener('click', async () => {
  await supabase.auth.signOut();
  dashboard.classList.add('hidden');
  loginScreen.classList.remove('hidden');
  loginBtn.disabled = false;
  loginBtn.textContent = 'Sign In';
  emailInput.value = '';
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

// ── Data fetching ─────────────────────────────────────────────────────────────

/**
 * Fetch all directorates and for each one aggregate today's attendance.
 *
 * Schema assumed from setup.sql:
 *   directorates(id, name, governorate)
 *   schools(id, directorate_id)
 *   attendance_records(id, school_id, student_id, date, status)
 *   students(id, school_id)
 *
 * We group by governorate (each directorate belongs to one governorate).
 * For MVP we do two queries: fetch directorates, then one attendance query
 * filtered to today, then aggregate in JS. This avoids N+1 calls.
 */
async function loadAllData() {
  tableLoading.classList.remove('hidden');
  tableWrapper.classList.add('hidden');
  tableEmpty.classList.add('hidden');

  // Reset stats
  [statGov, statTotal, statPresent, statAbsent, statRate].forEach(el => el.textContent = '—');

  try {
    // 1. All directorates
    const { data: directorates, error: dirErr } = await supabase
      .from('directorates')
      .select('id, name, governorate')
      .order('governorate');

    if (dirErr) throw dirErr;
    if (!directorates || directorates.length === 0) {
      showEmpty();
      return;
    }

    // 2. All schools with their directorate_id
    const { data: schools, error: schErr } = await supabase
      .from('schools')
      .select('id, directorate_id');

    if (schErr) throw schErr;

    // Build maps
    const schoolToDirectorate = {};
    const directorateSchools  = {}; // dir_id -> Set of school_ids
    (schools || []).forEach(s => {
      schoolToDirectorate[s.id] = s.directorate_id;
      if (!directorateSchools[s.directorate_id]) directorateSchools[s.directorate_id] = new Set();
      directorateSchools[s.directorate_id].add(s.id);
    });

    const allSchoolIds = (schools || []).map(s => s.id);

    // 3. Today's attendance records (all at once)
    const { data: records, error: recErr } = await supabase
      .from('attendance_records')
      .select('school_id, status')
      .in('school_id', allSchoolIds.length > 0 ? allSchoolIds : ['__none__'])
      .eq('date', today());

    if (recErr) throw recErr;

    // 4. Total students per school
    const { data: studentCounts, error: stuErr } = await supabase
      .from('students')
      .select('school_id')
      .in('school_id', allSchoolIds.length > 0 ? allSchoolIds : ['__none__']);

    if (stuErr) throw stuErr;

    // Map: school_id -> student count
    const studentsPerSchool = {};
    (studentCounts || []).forEach(s => {
      studentsPerSchool[s.school_id] = (studentsPerSchool[s.school_id] || 0) + 1;
    });

    // 5. Aggregate per directorate
    const dirAgg = {}; // dir_id -> { totalStudents, present, absent, schoolCount }
    directorates.forEach(d => {
      dirAgg[d.id] = { totalStudents: 0, present: 0, absent: 0, schoolCount: 0 };
    });

    // Count students per directorate
    Object.entries(studentsPerSchool).forEach(([schoolId, count]) => {
      const dirId = schoolToDirectorate[schoolId];
      if (dirId && dirAgg[dirId]) dirAgg[dirId].totalStudents += count;
    });

    // Count school count per directorate
    Object.entries(directorateSchools).forEach(([dirId, schoolSet]) => {
      if (dirAgg[dirId]) dirAgg[dirId].schoolCount = schoolSet.size;
    });

    // Count attendance per directorate
    (records || []).forEach(rec => {
      const dirId = schoolToDirectorate[rec.school_id];
      if (!dirId || !dirAgg[dirId]) return;
      if (rec.status === 'present') dirAgg[dirId].present++;
      else if (rec.status === 'absent') dirAgg[dirId].absent++;
    });

    // 6. Group directorates by governorate
    const govMap = {}; // governorate name -> aggregated totals
    directorates.forEach(d => {
      const gov = d.governorate || 'Unknown';
      if (!govMap[gov]) {
        govMap[gov] = { governorate: gov, totalStudents: 0, present: 0, absent: 0, schoolCount: 0, dirCount: 0 };
      }
      const agg = dirAgg[d.id];
      govMap[gov].totalStudents += agg.totalStudents;
      govMap[gov].present       += agg.present;
      govMap[gov].absent        += agg.absent;
      govMap[gov].schoolCount   += agg.schoolCount;
      govMap[gov].dirCount++;
    });

    const rows = Object.values(govMap).sort((a, b) => a.governorate.localeCompare(b.governorate));

    if (rows.length === 0) { showEmpty(); return; }

    renderStats(rows);
    renderTable(rows);
    setLastUpdated();

  } catch (err) {
    console.error('NSAMS Ministry load error:', err);
    tableLoading.classList.add('hidden');
    tableEmpty.textContent = 'Error loading data: ' + (err.message || err);
    tableEmpty.classList.remove('hidden');
  }
}

function showEmpty() {
  tableLoading.classList.add('hidden');
  tableEmpty.classList.remove('hidden');
}

// ── Render stats row ──────────────────────────────────────────────────────────
function renderStats(rows) {
  let totalStudents = 0, totalPresent = 0, totalAbsent = 0;
  rows.forEach(r => {
    totalStudents += r.totalStudents;
    totalPresent  += r.present;
    totalAbsent   += r.absent;
  });

  statGov.textContent     = rows.length;
  statTotal.textContent   = fmt(totalStudents);
  statPresent.textContent = fmt(totalPresent);
  statAbsent.textContent  = fmt(totalAbsent);
  statRate.textContent    = pct(totalPresent, totalPresent + totalAbsent);
}

// ── Render table ──────────────────────────────────────────────────────────────
function renderTable(rows) {
  tableLoading.classList.add('hidden');

  tableData = rows; // store for CSV

  let totalStudents = 0, totalPresent = 0, totalAbsent = 0, totalSchools = 0;

  govTbody.innerHTML = rows.map((row, i) => {
    const attended = row.present + row.absent;
    const rate     = attended > 0 ? (row.present / attended * 100) : null;
    const rateStr  = rate !== null ? rate.toFixed(1) : null;

    totalStudents += row.totalStudents;
    totalPresent  += row.present;
    totalAbsent   += row.absent;
    totalSchools  += row.schoolCount;

    const barClass = rateBarClass(rateStr);
    const barWidth = rate !== null ? rate.toFixed(1) : 0;

    return `
      <tr>
        <td>${i + 1}</td>
        <td><strong>${row.governorate}</strong></td>
        <td>${fmt(row.schoolCount)}</td>
        <td>${fmt(row.totalStudents)}</td>
        <td style="color:#4ade80">${fmt(row.present)}</td>
        <td style="color:#f87171">${fmt(row.absent)}</td>
        <td>
          <div class="rate-cell">
            <div class="rate-bar-bg">
              <div class="rate-bar-fill ${barClass}" style="width:${barWidth}%"></div>
            </div>
            <span class="rate-text" style="color:${barClass === 'green' ? '#4ade80' : barClass === 'yellow' ? '#fde047' : barClass === 'red' ? '#f87171' : '#64748b'}">
              ${rateStr !== null ? rateStr + '%' : '—'}
            </span>
          </div>
        </td>
        <td>${rateBadge(rateStr)}</td>
      </tr>`;
  }).join('');

  const totalAttended = totalPresent + totalAbsent;
  const nationalRate  = totalAttended > 0 ? (totalPresent / totalAttended * 100).toFixed(1) : null;

  govTfoot.innerHTML = `
    <tr>
      <td></td>
      <td>National Total</td>
      <td>${fmt(totalSchools)}</td>
      <td>${fmt(totalStudents)}</td>
      <td style="color:#4ade80">${fmt(totalPresent)}</td>
      <td style="color:#f87171">${fmt(totalAbsent)}</td>
      <td>${nationalRate !== null ? nationalRate + '%' : '—'}</td>
      <td>${rateBadge(nationalRate)}</td>
    </tr>`;

  tableWrapper.classList.remove('hidden');
}

// ── Refresh ───────────────────────────────────────────────────────────────────
refreshBtn.addEventListener('click', () => {
  const { data: { session } } = supabase.auth.getSession().then(({ data }) => {
    if (data.session) loadAllData();
  });
});

// ── CSV Export ────────────────────────────────────────────────────────────────
exportBtn.addEventListener('click', () => {
  if (!tableData.length) return;

  const dateStr = today();
  const headers = ['Governorate', 'Schools', 'Total Students', 'Present', 'Absent', 'Attendance Rate (%)'];

  const csvRows = [
    `# NSAMS – National Attendance Report – ${dateStr}`,
    headers.join(','),
    ...tableData.map(row => {
      const attended = row.present + row.absent;
      const rate = attended > 0 ? (row.present / attended * 100).toFixed(1) : '';
      return [
        `"${row.governorate}"`,
        row.schoolCount,
        row.totalStudents,
        row.present,
        row.absent,
        rate
      ].join(',');
    })
  ];

  // Totals row
  let tStudents = 0, tPresent = 0, tAbsent = 0, tSchools = 0;
  tableData.forEach(r => {
    tStudents += r.totalStudents;
    tPresent  += r.present;
    tAbsent   += r.absent;
    tSchools  += r.schoolCount;
  });
  const tAttended = tPresent + tAbsent;
  const tRate = tAttended > 0 ? (tPresent / tAttended * 100).toFixed(1) : '';
  csvRows.push(['"National Total"', tSchools, tStudents, tPresent, tAbsent, tRate].join(','));

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