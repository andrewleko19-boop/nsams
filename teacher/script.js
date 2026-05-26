// teacher/script.js
// Loaded as <script type="module"> after shared/db.js

// ── Guard ─────────────────────────────────────────────────────────────────────
if (!window.NSAMS_DB) {
  document.body.innerHTML =
    '<p style="padding:24px;color:#EF4444;font-family:sans-serif;direction:rtl">' +
    'خطأ: تعذّر تحميل طبقة البيانات. تأكد من تضمين shared/db.js قبل هذا الملف.</p>';
  throw new Error('window.NSAMS_DB is not defined');
}

const {
  login,
  logout,
  getCurrentUser,
  getTeacherClasses,
  getClassStudents,
  getClassSubmissionStatus,
  getClassAttendanceForDate,
  saveStudentAttendance,
  getPendingStudentAttendance,
  syncPending,
  gradeNameAr,
} = window.NSAMS_DB;

// ── App State ─────────────────────────────────────────────────────────────────
const S = {
  user:       null,          // { user: {id, email, fullName}, role, schoolId }
  classes:    [],            // array from getTeacherClasses()
  // --- attendance view ---
  activeClass:      null,    // one item from S.classes
  students:         [],      // from getClassStudents()
  attendance:       {},      // { [studentId]: { status, reason } }
  submission:       null,    // from getClassSubmissionStatus() – null = not yet
  isDirty:          false,   // unsaved changes since last render
};

// Default status for a student when the teacher first opens the class
const DEFAULT_STATUS = 'present';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

// Screens / views
const screenLogin  = $('screen-login');
const screenApp    = $('screen-app');
const viewHome     = $('view-home');
const viewAtt      = $('view-att');

// Login
const formLogin      = $('form-login');
const inEmail        = $('in-email');
const inPw           = $('in-password');
const btnTogglePw    = $('btn-toggle-pw');
const pwEyeUse       = $('pw-eye-use');
const loginError     = $('login-error');
const btnLogin       = $('btn-login');
const btnLoginLabel  = $('btn-login-label');
const loginSpinner   = $('login-spinner');

// Home header
const hdrTeacherName = $('hdr-teacher-name');
const hdrDate        = $('hdr-date');
const connPill       = $('conn-pill');
const connIcon       = $('conn-icon');
const connLabel      = $('conn-label');
const pendingBar     = $('pending-bar');
const pendingText    = $('pending-text');
const btnSync        = $('btn-sync');
const syncIcon       = $('sync-icon');
const btnSyncBar     = $('btn-sync-bar');
const btnLogout      = $('btn-logout');

// Home view
const classesLoading = $('classes-loading');
const classesList    = $('classes-list');
const classesEmpty   = $('classes-empty');

// Attendance view
const attClassName   = $('att-class-name');
const attDate        = $('att-date');
const btnBack        = $('btn-back');
const sumPresent     = $('sum-present');
const sumLate        = $('sum-late');
const sumAbsent      = $('sum-absent');
const sumExcused     = $('sum-excused');
const submittedBanner= $('submitted-banner');
const submittedBannerText = $('submitted-banner-text');
const rejectedBanner = $('rejected-banner');
const rejectedReason = $('rejected-reason');
const studentsLoading= $('students-loading');
const studentsList   = $('students-list');
const studentsEmpty  = $('students-empty');
const attFooter      = $('att-footer');
const btnSaveDraft   = $('btn-save-draft');
const btnSubmitAtt   = $('btn-submit-att');
const btnSubmitLabel = $('btn-submit-label');
const submitSpinner  = $('submit-spinner');

// Reason modal
const modalReason       = $('modal-reason');
const reasonStudentName = $('reason-student-name');
const reasonInput       = $('reason-input');
const btnReasonCancel   = $('btn-reason-cancel');
const btnReasonSave     = $('btn-reason-save');

// Confirm modal
const modalConfirm      = $('modal-confirm');
const cPresent          = $('c-present');
const cAbsent           = $('c-absent');
const cLate             = $('c-late');
const cExcused          = $('c-excused');
const confirmWarning    = $('confirm-warning');
const confirmWarningText= $('confirm-warning-text');
const btnConfirmCancel  = $('btn-confirm-cancel');
const btnConfirmSubmit  = $('btn-confirm-submit');
const confirmSubmitLabel= $('confirm-submit-label');
const confirmSpinner    = $('confirm-spinner');

// Toast zone
const toastZone = $('toasts');

// ── Utilities ─────────────────────────────────────────────────────────────────
function todayISO() { return new Date().toISOString().slice(0, 10); }

function formatDateAr(iso) {
  return new Date(iso + 'T00:00:00').toLocaleDateString('ar-SY', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function svgHref(el, href) { el.setAttribute('href', href); }

function show(el) { el.hidden = false; }
function hide(el) { el.hidden = true; }

// ── Toast ─────────────────────────────────────────────────────────────────────
const TOAST_ICONS = {
  success: '#ic-check-circle',
  warning: '#ic-alert',
  error:   '#ic-x-circle',
  info:    '#ic-alert-circle',
};

function toast(msg, type = 'info', ms = 3800) {
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.innerHTML =
    `<svg class="icon icon-sm" style="flex-shrink:0"><use href="${TOAST_ICONS[type]}"/></svg>` +
    `<span>${msg}</span>`;
  toastZone.prepend(t);
  setTimeout(() => {
    t.classList.add('removing');
    t.addEventListener('animationend', () => t.remove(), { once: true });
  }, ms);
}

// ── Screen / view routing ─────────────────────────────────────────────────────
function showScreen(name) {
  screenLogin.hidden = name !== 'login';
  screenApp.hidden   = name !== 'app';
}

function showView(name) {
  viewHome.hidden = name !== 'home';
  viewAtt.hidden  = name !== 'att';
}

// ── Connectivity ──────────────────────────────────────────────────────────────
function updateConnUI() {
  const online = navigator.onLine;
  connPill.classList.toggle('offline', !online);
  connLabel.textContent = online ? 'متصل' : 'غير متصل';
  svgHref(connIcon, online ? '#ic-wifi' : '#ic-wifi-off');
  refreshPendingBar();
}

function refreshPendingBar() {
  const n = getPendingStudentAttendance().length;
  if (n > 0) {
    pendingText.textContent = `${n} كشف في انتظار المزامنة`;
    show(pendingBar);
  } else {
    hide(pendingBar);
  }
}

window.addEventListener('online',  () => { updateConnUI(); doSync(); });
window.addEventListener('offline', updateConnUI);

// ── Sync ──────────────────────────────────────────────────────────────────────
let syncing = false;

async function doSync() {
  if (syncing || !navigator.onLine) return;
  syncing = true;
  syncIcon.classList.add('syncing');
  try {
    const result = await syncPending();
    const total  = (result.studentAtt?.synced ?? 0)
                 + (result.attendance?.synced ?? 0)
                 + (result.reports?.synced    ?? 0);
    if (total > 0) toast(`تمت مزامنة ${total} سجل بنجاح`, 'success');
    refreshPendingBar();
  } catch (err) {
    console.warn('[NSAMS-T] sync error', err);
    toast('تعذّرت المزامنة', 'error');
  } finally {
    syncIcon.classList.remove('syncing');
    syncing = false;
  }
}

btnSync.addEventListener('click', doSync);
btnSyncBar.addEventListener('click', doSync);

// ── Password toggle ───────────────────────────────────────────────────────────
btnTogglePw.addEventListener('click', () => {
  const isPw = inPw.type === 'password';
  inPw.type  = isPw ? 'text' : 'password';
  svgHref(pwEyeUse, isPw ? '#ic-eye-off' : '#ic-eye');
  btnTogglePw.setAttribute('aria-label', isPw ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور');
});

// ── Login ─────────────────────────────────────────────────────────────────────
formLogin.addEventListener('submit', async (e) => {
  e.preventDefault();
  hide(loginError);

  const email    = inEmail.value.trim();
  const password = inPw.value;

  if (!email || !password) {
    loginError.textContent = 'يرجى إدخال البريد الإلكتروني وكلمة المرور';
    show(loginError);
    return;
  }

  setLoginBusy(true);
  try {
    const session = await login(email, password);

    if (session.role !== 'teacher') {
      await logout().catch(() => {});
      loginError.textContent = 'هذا التطبيق مخصص لمعلمي الصفوف فقط';
      show(loginError);
      return;
    }

    S.user = session;
    await initApp();
  } catch (err) {
    console.error('[NSAMS-T] login error', err);
    loginError.textContent =
      err?.message?.includes('Invalid login')
        ? 'بيانات الدخول غير صحيحة'
        : (err?.message ?? 'فشل تسجيل الدخول، يرجى المحاولة مجدداً');
    show(loginError);
  } finally {
    setLoginBusy(false);
  }
});

function setLoginBusy(busy) {
  btnLogin.disabled    = busy;
  btnLoginLabel.hidden = busy;
  loginSpinner.hidden  = !busy;
}

// ── Logout ────────────────────────────────────────────────────────────────────
btnLogout.addEventListener('click', async () => {
  if (S.isDirty && !confirm('يوجد تغييرات غير محفوظة. هل تريد الخروج؟')) return;
  if (!S.isDirty && !confirm('هل تريد تسجيل الخروج؟')) return;
  try { await logout(); } catch { /* ignore */ }
  S.user        = null;
  S.classes     = [];
  S.activeClass = null;
  S.students    = [];
  S.attendance  = {};
  S.submission  = null;
  S.isDirty     = false;
  showScreen('login');
});

// ── App Init ──────────────────────────────────────────────────────────────────
async function initApp() {
  showScreen('app');
  showView('home');

  hdrTeacherName.textContent = S.user?.user?.fullName ?? 'المعلم';
  hdrDate.textContent        = formatDateAr(todayISO());

  updateConnUI();
  await loadClasses();
  await doSync();
}

// ── Load Classes ──────────────────────────────────────────────────────────────
async function loadClasses() {
  show(classesLoading);
  hide(classesList);
  hide(classesEmpty);

  try {
    S.classes = await getTeacherClasses(S.user.user.id);
  } catch (err) {
    console.error('[NSAMS-T] getTeacherClasses', err);
    toast('تعذّر تحميل قائمة الصفوف', 'error');
    S.classes = [];
  }

  hide(classesLoading);

  if (S.classes.length === 0) {
    show(classesEmpty);
    return;
  }

  // Fetch submission status for each class (best-effort, parallel)
  const today = todayISO();
  const statuses = await Promise.allSettled(
    S.classes.map(c => getClassSubmissionStatus(c.id, today))
  );

  show(classesList);
  classesList.innerHTML = '';
  S.classes.forEach((cls, i) => {
    const sub = statuses[i].status === 'fulfilled' ? statuses[i].value : null;
    classesList.appendChild(buildClassCard(cls, sub));
  });
}

// ── Class Card ────────────────────────────────────────────────────────────────
function buildClassCard(cls, submission) {
  const card = document.createElement('button');
  card.className   = 'class-card';
  card.setAttribute('aria-label', `فتح ${cls.displayName}`);

  const { badgeClass, badgeText } = submissionBadge(submission);

  card.innerHTML = `
    <div class="class-icon">
      <span>${cls.grade}</span>
    </div>
    <div class="class-info">
      <div class="class-name">${escapeHtml(cls.displayName)}</div>
      <div class="class-meta">${escapeHtml(cls.schoolName)}</div>
    </div>
    <div class="class-status">
      <span class="status-badge ${badgeClass}">${badgeText}</span>
    </div>
  `;

  card.addEventListener('click', () => openAttendanceView(cls));
  return card;
}

function submissionBadge(sub) {
  if (!sub)                   return { badgeClass: 'badge-pending',   badgeText: 'لم يُرسل' };
  if (sub.status === 'pending')   return { badgeClass: 'badge-submitted', badgeText: 'بانتظار المدير' };
  if (sub.status === 'confirmed') return { badgeClass: 'badge-confirmed', badgeText: 'مؤكد ✓' };
  if (sub.status === 'rejected')  return { badgeClass: 'badge-rejected',  badgeText: 'مُعاد ✗' };
  return { badgeClass: 'badge-pending', badgeText: 'لم يُرسل' };
}

// ── Attendance View ───────────────────────────────────────────────────────────
async function openAttendanceView(cls) {
  S.activeClass = cls;
  S.attendance  = {};
  S.isDirty     = false;

  attClassName.textContent = cls.displayName;
  attDate.textContent      = formatDateAr(todayISO());

  showView('att');

  // Reset banners and footer
  hide(submittedBanner);
  hide(rejectedBanner);
  hide(studentsEmpty);
  hide(studentsList);
  show(studentsLoading);
  show(attFooter);
  hide(btnSaveDraft);
  show(btnSubmitAtt);
  btnSubmitAtt.disabled = false;
  btnSubmitLabel.hidden = false;
  submitSpinner.hidden  = true;
  studentsList.classList.remove('locked');

  updateSummaryBar();

  const today = todayISO();

  try {
    // Parallel: students + submission status + existing attendance
    const [students, submission, existing] = await Promise.all([
      getClassStudents(cls.id),
      getClassSubmissionStatus(cls.id, today),
      getClassAttendanceForDate(cls.id, today),
    ]);

    S.students  = students;
    S.submission = submission;

    // Pre-fill attendance from existing records OR default all to 'present'
    if (Object.keys(existing).length > 0) {
      // Re-opening: restore saved state
      S.attendance = existing;
    } else {
      // First open today: default everyone to 'present'
      for (const stu of students) {
        S.attendance[stu.id] = { status: DEFAULT_STATUS, reason: null };
      }
    }

    hide(studentsLoading);

    if (students.length === 0) {
      show(studentsEmpty);
      hide(attFooter);
      return;
    }

    renderSubmissionBanners();
    renderStudentsList();
    updateSummaryBar();

  } catch (err) {
    console.error('[NSAMS-T] openAttendanceView', err);
    toast(err?.message ?? 'تعذّر تحميل بيانات الصف', 'error');
    hide(studentsLoading);
    hide(attFooter);
  }
}

// ── Render submission banners ─────────────────────────────────────────────────
function renderSubmissionBanners() {
  hide(submittedBanner);
  hide(rejectedBanner);

  if (!S.submission) return;

  if (S.submission.status === 'confirmed') {
    submittedBannerText.textContent = 'تم قبول الكشف من المدير — لا يمكن التعديل';
    show(submittedBanner);
    hide(attFooter);
    studentsList.classList.add('locked');

  } else if (S.submission.status === 'pending') {
    submittedBannerText.textContent = 'تم إرسال الكشف — في انتظار مراجعة المدير';
    show(submittedBanner);
    // Footer still visible to allow re-send if needed
    show(btnSaveDraft);

  } else if (S.submission.status === 'rejected') {
    rejectedReason.textContent = S.submission.notes
      ? ` ${S.submission.notes}`
      : ' يرجى المراجعة والإرسال مجدداً.';
    show(rejectedBanner);
  }
}

// ── Render students list ──────────────────────────────────────────────────────
function renderStudentsList() {
  studentsList.innerHTML = '';

  S.students.forEach((stu, idx) => {
    const rec    = S.attendance[stu.id] ?? { status: DEFAULT_STATUS, reason: null };
    const li     = buildStudentRow(stu, idx + 1, rec);
    studentsList.appendChild(li);
  });

  show(studentsList);
}

function buildStudentRow(stu, num, rec) {
  const li = document.createElement('li');
  li.className    = 'student-row';
  li.dataset.id   = stu.id;
  li.dataset.status = rec.status;
  li.setAttribute('role', 'listitem');

  const showReason = rec.reason && (rec.status === 'excused' || rec.status === 'absent');

  li.innerHTML = `
    <span class="student-num">${num}</span>
    <div class="student-name-wrap">
      <div class="student-name">${escapeHtml(stu.full_name)}</div>
      ${showReason
        ? `<div class="student-reason-text">${escapeHtml(rec.reason)}</div>`
        : ''}
    </div>
    <div class="stn-btns" data-sid="${escapeHtml(stu.id)}" aria-label="حالة ${escapeHtml(stu.full_name)}">
      <button class="stn-btn${rec.status==='present' ?' active':''}" data-s="present"  title="حاضر"   aria-pressed="${rec.status==='present'}">ح</button>
      <button class="stn-btn${rec.status==='late'    ?' active':''}" data-s="late"     title="متأخر"  aria-pressed="${rec.status==='late'}">ت</button>
      <button class="stn-btn${rec.status==='absent'  ?' active':''}" data-s="absent"   title="غائب"   aria-pressed="${rec.status==='absent'}">غ</button>
      <button class="stn-btn${rec.status==='excused' ?' active':''}" data-s="excused"  title="بعذر"   aria-pressed="${rec.status==='excused'}">ع</button>
    </div>
  `;

  return li;
}

// ── Status button event delegation ───────────────────────────────────────────
studentsList.addEventListener('click', (e) => {
  const btn = e.target.closest('.stn-btn');
  if (!btn || studentsList.classList.contains('locked')) return;

  const wrap   = btn.closest('.stn-btns');
  const sid    = wrap.dataset.sid;
  const status = btn.dataset.s;
  const row    = btn.closest('.student-row');

  // Update state
  const prev = S.attendance[sid] ?? { status: DEFAULT_STATUS, reason: null };
  S.attendance[sid] = { status, reason: prev.reason ?? null };
  S.isDirty = true;

  // Update button active states
  wrap.querySelectorAll('.stn-btn').forEach(b => {
    b.classList.toggle('active', b === btn);
    b.setAttribute('aria-pressed', String(b === btn));
  });

  // Update row color
  row.dataset.status = status;

  // Show reason modal for 'absent' or 'excused'
  if (status === 'absent' || status === 'excused') {
    openReasonModal(sid);
  } else {
    // Clear reason if switching away from those statuses
    S.attendance[sid].reason = null;
    // Update reason text in row
    const nameWrap = row.querySelector('.student-name-wrap');
    const existing = nameWrap.querySelector('.student-reason-text');
    if (existing) existing.remove();
  }

  updateSummaryBar();
});

// ── Summary bar update ────────────────────────────────────────────────────────
function updateSummaryBar() {
  const counts = { present: 0, late: 0, absent: 0, excused: 0 };
  for (const rec of Object.values(S.attendance)) {
    if (counts[rec.status] !== undefined) counts[rec.status]++;
  }
  sumPresent.textContent = counts.present;
  sumLate.textContent    = counts.late;
  sumAbsent.textContent  = counts.absent;
  sumExcused.textContent = counts.excused;

  // Bump animation on change
  [sumPresent, sumLate, sumAbsent, sumExcused].forEach(el => {
    el.classList.remove('bump');
    void el.offsetWidth;
    el.classList.add('bump');
    el.addEventListener('animationend', () => el.classList.remove('bump'), { once: true });
  });
}

// ── Reason Modal ──────────────────────────────────────────────────────────────
let _reasonSid = null; // student id being edited

function openReasonModal(sid) {
  _reasonSid = sid;
  const stu = S.students.find(s => s.id === sid);
  reasonStudentName.textContent = stu?.full_name ?? '—';
  reasonInput.value = S.attendance[sid]?.reason ?? '';
  show(modalReason);
  setTimeout(() => reasonInput.focus(), 80);
}

function closeReasonModal() {
  hide(modalReason);
  _reasonSid = null;
}

btnReasonCancel.addEventListener('click', closeReasonModal);

btnReasonSave.addEventListener('click', () => {
  if (!_reasonSid) return;
  const reason = reasonInput.value.trim() || null;
  S.attendance[_reasonSid].reason = reason;
  S.isDirty = true;

  // Refresh row to show/hide reason text
  const row = studentsList.querySelector(`[data-id="${_reasonSid}"]`);
  if (row) {
    const nameWrap = row.querySelector('.student-name-wrap');
    let rt = nameWrap.querySelector('.student-reason-text');
    if (reason) {
      if (!rt) {
        rt = document.createElement('div');
        rt.className = 'student-reason-text';
        nameWrap.appendChild(rt);
      }
      rt.textContent = reason;
    } else if (rt) {
      rt.remove();
    }
  }

  closeReasonModal();
  toast('تم حفظ الملاحظة', 'success', 2000);
});

modalReason.addEventListener('click', (e) => {
  if (e.target === modalReason) closeReasonModal();
});

// ── Back button ───────────────────────────────────────────────────────────────
btnBack.addEventListener('click', async () => {
  if (S.isDirty) {
    // Auto-save draft silently before navigating back
    await saveDraft(true);
  }
  S.activeClass = null;
  S.students    = [];
  S.attendance  = {};
  S.submission  = null;
  S.isDirty     = false;
  showView('home');
  // Refresh class cards to reflect any status changes
  await loadClasses();
});

// ── Save Draft ────────────────────────────────────────────────────────────────
// Saves current attendance to IndexedDB queue without setting submission status.
// Used for "save and come back later" use case.
async function saveDraft(silent = false) {
  if (S.students.length === 0) return;
  const records = buildRecordsArray();
  // For a draft, we still upsert the student rows but do NOT create/update
  // the attendance_submissions row. We achieve this by calling saveStudentAttendance
  // but the server-side function always upserts the submission as 'pending'.
  // For a true draft-only save without touching submissions, you would need a
  // separate RPC. For MVP simplicity, saving draft = pending submission.
  try {
    await saveStudentAttendance({
      records,
      classId:   S.activeClass.id,
      schoolId:  S.activeClass.schoolId,
      date:      todayISO(),
      teacherId: S.user.user.id,
    });
    S.isDirty = false;
    if (!silent) toast('تم حفظ الكشف مؤقتاً', 'success');
    refreshPendingBar();
  } catch (err) {
    if (!silent) toast('تعذّر الحفظ المؤقت', 'error');
    console.error('[NSAMS-T] saveDraft', err);
  }
}

btnSaveDraft.addEventListener('click', () => saveDraft(false));

// ── Submit Attendance ─────────────────────────────────────────────────────────
btnSubmitAtt.addEventListener('click', () => {
  // Validate: all students must have a status assigned
  const total = S.students.length;
  const marked = Object.values(S.attendance).filter(r => r.status).length;

  if (marked < total) {
    toast(`${total - marked} طالب لم يُحدد وضعه بعد`, 'warning');
    return;
  }

  openConfirmModal();
});

function buildRecordsArray() {
  return S.students.map(stu => ({
    studentId: stu.id,
    status:    S.attendance[stu.id]?.status ?? DEFAULT_STATUS,
    reason:    S.attendance[stu.id]?.reason ?? null,
  }));
}

// ── Confirm Modal ─────────────────────────────────────────────────────────────
function openConfirmModal() {
  const counts = { present: 0, absent: 0, late: 0, excused: 0 };
  for (const rec of Object.values(S.attendance)) {
    if (counts[rec.status] !== undefined) counts[rec.status]++;
  }

  cPresent.textContent = counts.present;
  cAbsent.textContent  = counts.absent;
  cLate.textContent    = counts.late;
  cExcused.textContent = counts.excused;

  // Warn if 100% absent (likely a mistake)
  const warnAll = counts.absent + counts.excused === S.students.length && S.students.length > 0;
  if (warnAll) {
    confirmWarningText.textContent = 'جميع الطلاب غائبون — تأكد من صحة البيانات قبل الإرسال.';
    confirmWarning.style.display = 'block';
  } else {
    confirmWarning.style.display = 'none';
  }

  show(modalConfirm);
}

function closeConfirmModal() {
  hide(modalConfirm);
  confirmSubmitLabel.hidden = false;
  confirmSpinner.hidden     = true;
  btnConfirmSubmit.disabled = false;
}

btnConfirmCancel.addEventListener('click', closeConfirmModal);

modalConfirm.addEventListener('click', (e) => {
  if (e.target === modalConfirm) closeConfirmModal();
});

btnConfirmSubmit.addEventListener('click', async () => {
  btnConfirmSubmit.disabled = true;
  confirmSubmitLabel.hidden = true;
  confirmSpinner.hidden     = false;

  const records = buildRecordsArray();

  try {
    const result = await saveStudentAttendance({
      records,
      classId:   S.activeClass.id,
      schoolId:  S.activeClass.schoolId,
      date:      todayISO(),
      teacherId: S.user.user.id,
    });

    S.isDirty = false;
    closeConfirmModal();

    if (result.synced) {
      toast('تم إرسال الكشف للمدير بنجاح', 'success');
    } else {
      toast('حُفظ الكشف محلياً وسيُرسل عند توفر الاتصال', 'warning', 5000);
      refreshPendingBar();
    }

    // Update submission state + re-render banners
    S.submission = { status: 'pending' };
    renderSubmissionBanners();

    // Update the footer
    hide(btnSubmitAtt);
    show(btnSaveDraft);

  } catch (err) {
    console.error('[NSAMS-T] submit error', err);
    toast(err?.message ?? 'حدث خطأ أثناء الإرسال', 'error');
    closeConfirmModal();
  }
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function bootstrap() {
  try {
    const session = await getCurrentUser();
    if (session && session.role === 'teacher') {
      S.user = session;
      await initApp();
      return;
    }
  } catch (err) {
    console.warn('[NSAMS-T] bootstrap session check failed', err);
  }
  showScreen('login');
}

bootstrap();
