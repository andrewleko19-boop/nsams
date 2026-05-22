// school/script.js
// Loaded as <script type="module"> after Supabase CDN and shared/db.js

// ── Guard ─────────────────────────────────────────────────────────────────────
if (!window.NSAMS_DB) {
  document.body.innerHTML =
    '<p style="padding:24px;color:#EF4444;font-family:sans-serif;direction:rtl">' +
    'خطأ: تعذّر تحميل طبقة البيانات. تأكد من تضمين shared/db.js.</p>';
  throw new Error('window.NSAMS_DB is not defined');
}

const {
  login,
  logout,
  getCurrentUser,
  saveAttendance,
  submitReport,
  syncPending,
  getPendingAttendance,
  getPendingReports,
} = window.NSAMS_DB;

// ── Mock school data (MVP – replace with db.getSchoolProfile once implemented) ─
const MOCK_SCHOOL = {
  id:            '22222222-2222-2222-2222-222222222222',
  name:          'مدرسة الشهيد باسل الأسد الابتدائية',
  totalTeachers: 24,
  totalStudents: 480,
};

// ── App state ─────────────────────────────────────────────────────────────────
const S = {
  user:           null,   // { user, role, schoolId, directorateId }
  school:         { ...MOCK_SCHOOL },
  absentTeachers: [],     // string[]
  attSubmitted:   false,
  severity:       1,
  photoB64:       null,
  photoMime:      null,
};

// ── DOM helpers ───────────────────────────────────────────────────────────────
const el   = (id) => document.getElementById(id);
const show = (elem) => { elem.hidden = false; };
const hide = (elem) => { elem.hidden = true;  };

// Elements – login
const screenLogin   = el('screen-login');
const screenApp     = el('screen-app');
const formLogin     = el('form-login');
const inEmail       = el('in-email');
const inPw          = el('in-password');
const btnTogglePw   = el('btn-toggle-pw');
const pwEyeUse      = el('pw-eye-use');
const loginError    = el('login-error');
const btnLogin      = el('btn-login');
const btnLoginLabel = el('btn-login-label');
const loginSpinner  = el('login-spinner');

// Elements – app header
const hdrSchool   = el('hdr-school');
const hdrDate     = el('hdr-date');
const connPill    = el('conn-pill');
const connIcon    = el('conn-icon');
const connLabel   = el('conn-label');
const pendingBar  = el('pending-bar');
const pendingText = el('pending-text');
const btnSync     = el('btn-sync');
const syncIcon    = el('sync-icon');
const btnLogout   = el('btn-logout');

// Elements – status
const statusCard  = el('status-card');
const statusIcon  = el('status-icon');
const statusTitle = el('status-title');
const statusSub   = el('status-sub');

// Elements – attendance
const tPresent      = el('t-present');
const tAbsent       = el('t-absent');
const tTotal        = el('t-total');
const absentList    = el('absent-list');
const inAbsent      = el('in-absent');
const btnAddAbsent  = el('btn-add-absent');
const inStuPresent  = el('in-stu-present');
const inStuAbsent   = el('in-stu-absent');
const inNotes       = el('in-notes');
const btnSubmitAtt  = el('btn-submit-att');
const attCard       = el('att-card');
const attDone       = el('att-done');
const attDoneSub    = el('att-done-sub');

// Elements – report modal
const modalReport    = el('modal-report');
const btnOpenReport  = el('btn-open-report');
const btnCloseReport = el('btn-close-report');
const rType          = el('r-type');
const rDesc          = el('r-desc');
const rDescCount     = el('r-desc-count');
const sevBtns        = el('sev-btns');
const rPhoto         = el('r-photo');
const photoLabel     = el('photo-label');
const photoText      = el('photo-text');
const rError         = el('r-error');
const btnSubmitRep   = el('btn-submit-report');
const rSubmitLabel   = el('r-submit-label');
const rSpinner       = el('r-spinner');

// Elements – receipt modal
const modalReceipt    = el('modal-receipt');
const recNumber       = el('rec-number');
const recTime         = el('rec-time');
const recStatus       = el('rec-status');
const btnCloseReceipt = el('btn-close-receipt');

// Toast zone
const toastZone = el('toasts');

// ── Utilities ─────────────────────────────────────────────────────────────────
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function formatDateAr(iso) {
  return new Date(iso + 'T00:00:00').toLocaleDateString('ar-SY', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
}

function formatDateTimeAr(iso) {
  return new Date(iso).toLocaleString('ar-SY', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function svgHref(useEl, href) {
  useEl.setAttribute('href', href);
}

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

// ── Screen switch ─────────────────────────────────────────────────────────────
function showScreen(name) {
  screenLogin.hidden = (name !== 'login');
  screenApp.hidden   = (name !== 'app');
}

// ── Online / Offline ──────────────────────────────────────────────────────────
function updateConnUI() {
  const online = navigator.onLine;
  connPill.classList.toggle('offline', !online);
  connLabel.textContent = online ? 'متصل' : 'غير متصل';
  svgHref(connIcon, online ? '#ic-wifi' : '#ic-wifi-off');
  refreshPendingBar();
}

function refreshPendingBar() {
  const n = getPendingAttendance().length + getPendingReports().length;
  if (n > 0) {
    pendingText.textContent = `${n} سجل في انتظار المزامنة`;
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
  if (syncing) return;
  syncing = true;
  syncIcon.classList.add('syncing');
  try {
    const { attendance, reports } = await syncPending();
    const total = attendance.synced + reports.synced;
    if (total > 0) {
      toast(`تمت مزامنة ${total} سجل بنجاح`, 'success');
    }
    refreshPendingBar();
  } catch (err) {
    console.warn('[NSAMS] sync error', err);
  } finally {
    syncIcon.classList.remove('syncing');
    syncing = false;
  }
}

btnSync.addEventListener('click', doSync);

// ── Status Card ───────────────────────────────────────────────────────────────
function setStatusDone(synced) {
  statusCard.className = 'status-card status-done';
  svgHref(statusIcon, '#ic-check-circle');
  statusTitle.textContent = synced
    ? 'تم إرسال سجل الحضور بنجاح'
    : 'تم حفظ سجل الحضور (في انتظار المزامنة)';
  statusSub.textContent = formatDateAr(todayISO());
}

function setStatusPending() {
  statusCard.className = 'status-card status-pending';
  svgHref(statusIcon, '#ic-clock');
  statusTitle.textContent = 'لم يُرسل سجل الحضور بعد';
  statusSub.textContent   = 'يرجى تعبئة النموذج وإرساله قبل نهاية الدوام';
}

// ── Teacher counter ───────────────────────────────────────────────────────────
function animateBump(numEl) {
  numEl.classList.remove('bump');
  // force reflow
  void numEl.offsetWidth;
  numEl.classList.add('bump');
  numEl.addEventListener('animationend', () => numEl.classList.remove('bump'), { once: true });
}

function refreshTeacherUI() {
  const total   = S.school.totalTeachers;
  const absent  = S.absentTeachers.length;
  const present = Math.max(0, total - absent);

  tTotal.textContent   = total;
  tAbsent.textContent  = absent;
  tPresent.textContent = present;

  animateBump(tAbsent);
  animateBump(tPresent);
}

// ── Absent teachers list ──────────────────────────────────────────────────────
function renderAbsentList() {
  absentList.innerHTML = '';
  S.absentTeachers.forEach((name, idx) => {
    const li = document.createElement('li');
    li.className = 'absent-item';
    li.innerHTML =
      `<span class="absent-name">${escapeHtml(name)}</span>` +
      `<button class="absent-del" data-i="${idx}" aria-label="حذف ${escapeHtml(name)}">` +
      `<svg class="icon icon-sm"><use href="#ic-x"/></svg></button>`;
    absentList.appendChild(li);
  });
  refreshTeacherUI();
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function addAbsentTeacher() {
  const name = inAbsent.value.trim();
  if (!name) return;
  if (S.absentTeachers.some((n) => n === name)) {
    toast('هذا المعلم مضاف بالفعل', 'warning', 2500);
    return;
  }
  S.absentTeachers.push(name);
  inAbsent.value = '';
  renderAbsentList();
}

btnAddAbsent.addEventListener('click', addAbsentTeacher);
inAbsent.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); addAbsentTeacher(); }
});
absentList.addEventListener('click', (e) => {
  const btn = e.target.closest('.absent-del');
  if (!btn) return;
  S.absentTeachers.splice(Number(btn.dataset.i), 1);
  renderAbsentList();
});

// ── Submit Attendance ─────────────────────────────────────────────────────────
btnSubmitAtt.addEventListener('click', async () => {
  const studPresent = parseInt(inStuPresent.value, 10) || 0;
  const studAbsent  = parseInt(inStuAbsent.value,  10) || 0;
  const absentCount = S.absentTeachers.length;
  const total       = S.school.totalTeachers;

  const record = {
    school_id:        S.school.id,
    date:             todayISO(),
    teachers_present: Math.max(0, total - absentCount),
    teachers_absent:  absentCount,
    students_present: studPresent,
    students_absent:  studAbsent,
    notes:            inNotes.value.trim() || null,
    submitted_by:     S.user?.user?.id ?? null,
  };

  btnSubmitAtt.disabled = true;

  try {
    const result = await saveAttendance(record);

    S.attSubmitted = true;
    hide(attCard);
    show(attDone);
    attDoneSub.textContent = `${formatDateAr(todayISO())} — ${
      result.synced ? 'تم الإرسال' : 'محفوظ محلياً'
    }`;
    setStatusDone(result.synced);

    if (result.synced) {
      toast('تم إرسال سجل الحضور بنجاح', 'success');
    } else {
      toast('حُفظ السجل محلياً وسيُرسل عند توفر الاتصال', 'warning');
      refreshPendingBar();
    }
  } catch (err) {
    console.error('[NSAMS] saveAttendance error', err);
    toast('حدث خطأ أثناء الإرسال، يرجى المحاولة مجدداً', 'error');
    btnSubmitAtt.disabled = false;
  }
});

// ── Emergency Report Modal ────────────────────────────────────────────────────
function openReportModal() {
  show(modalReport);
  document.body.style.overflow = 'hidden';
  rType.focus();
}

function closeReportModal() {
  hide(modalReport);
  document.body.style.overflow = '';
}

btnOpenReport.addEventListener('click', openReportModal);
btnCloseReport.addEventListener('click', closeReportModal);
modalReport.addEventListener('click', (e) => {
  if (e.target === modalReport) closeReportModal();
});

// Character count
rDesc.addEventListener('input', () => {
  rDescCount.textContent = `${rDesc.value.length} / 1000`;
});

// Severity buttons
sevBtns.addEventListener('click', (e) => {
  const btn = e.target.closest('.sev-btn');
  if (!btn) return;
  S.severity = Number(btn.dataset.v);
  sevBtns.querySelectorAll('.sev-btn').forEach((b) => {
    b.classList.toggle('active', b === btn);
  });
});

// Photo attachment
rPhoto.addEventListener('change', async () => {
  const file = rPhoto.files[0];
  if (!file) return;
  const MAX_MB = 3;
  if (file.size > MAX_MB * 1024 * 1024) {
    toast(`الصورة أكبر من ${MAX_MB} MB`, 'error');
    rPhoto.value = '';
    return;
  }
  try {
    S.photoB64  = await fileToBase64(file);
    S.photoMime = file.type;
    photoLabel.classList.add('has-photo');
    photoText.textContent = `✓ ${file.name.length > 24 ? file.name.slice(0, 22) + '…' : file.name}`;
  } catch {
    toast('تعذّر قراءة الصورة', 'error');
    rPhoto.value = '';
  }
});

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Submit report
btnSubmitRep.addEventListener('click', async () => {
  hide(rError);

  const type = rType.value;
  const desc = rDesc.value.trim();

  if (!type) { showReportError('يرجى اختيار نوع الحالة');   return; }
  if (!desc)  { showReportError('يرجى كتابة وصف للحالة');   return; }
  if (desc.length < 10) { showReportError('الوصف قصير جداً، يرجى الإسهاب أكثر'); return; }

  const report = {
    school_id:    S.school.id,
    submitted_by: S.user?.user?.id ?? null,
    type,
    description:  desc,
    severity:     S.severity,
    // NOTE: In production, upload to Supabase Storage and store the public URL.
    // For MVP, we store the data URI. Switch to storage.upload() + getPublicUrl()
    // before going live to avoid exceeding row size limits.
    media_urls: S.photoB64
      ? [`data:${S.photoMime};base64,${S.photoB64}`]
      : [],
  };

  setReportBusy(true);
  try {
    const result = await submitReport(report);
    closeReportModal();
    resetReportForm();
    showReceipt(result);
    if (!navigator.onLine) refreshPendingBar();
  } catch (err) {
    console.error('[NSAMS] submitReport error', err);
    showReportError('حدث خطأ أثناء الإرسال. تحقق من الاتصال وأعد المحاولة.');
  } finally {
    setReportBusy(false);
  }
});

function setReportBusy(busy) {
  btnSubmitRep.disabled      = busy;
  rSubmitLabel.hidden        = busy;
  rSpinner.hidden            = !busy;
}

function showReportError(msg) {
  rError.textContent = msg;
  show(rError);
  rError.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function resetReportForm() {
  rType.value = '';
  rDesc.value = '';
  rDescCount.textContent = '0 / 1000';
  hide(rError);
  S.severity  = 1;
  S.photoB64  = null;
  S.photoMime = null;
  rPhoto.value = '';
  photoLabel.classList.remove('has-photo');
  photoText.textContent = 'إرفاق صورة';
  sevBtns.querySelectorAll('.sev-btn').forEach((b, i) => {
    b.classList.toggle('active', i === 0);
  });
}

// ── Receipt Modal ─────────────────────────────────────────────────────────────
function showReceipt({ id, receiptNumber: rn, createdAt, status }) {
  recNumber.textContent = rn ?? id;
  recTime.textContent   = formatDateTimeAr(createdAt);
  recStatus.textContent = status === 'open' ? '🔴 مفتوح' : status;
  show(modalReceipt);
  document.body.style.overflow = 'hidden';
}

btnCloseReceipt.addEventListener('click', () => {
  hide(modalReceipt);
  document.body.style.overflow = '';
  toast('تم تسجيل البلاغ وسيتابعه المختص', 'success');
});

// ── Login ─────────────────────────────────────────────────────────────────────
btnTogglePw.addEventListener('click', () => {
  const isPw = inPw.type === 'password';
  inPw.type  = isPw ? 'text' : 'password';
  svgHref(pwEyeUse, isPw ? '#ic-eye-off' : '#ic-eye');
  btnTogglePw.setAttribute('aria-label', isPw ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور');
});

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

    if (session.role !== 'school_admin') {
      await logout().catch(() => {});
      loginError.textContent = 'هذا التطبيق مخصص لمديري المدارس فقط';
      show(loginError);
      return;
    }

    S.user = session;
    await initApp();
  } catch (err) {
    console.error('[NSAMS] login error', err);
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
  btnLogin.disabled      = busy;
  btnLoginLabel.hidden   = busy;
  loginSpinner.hidden    = !busy;
}

// ── Logout ────────────────────────────────────────────────────────────────────
btnLogout.addEventListener('click', async () => {
  if (!confirm('هل تريد تسجيل الخروج؟')) return;
  try { await logout(); } catch { /* ignore */ }
  S.user         = null;
  S.absentTeachers = [];
  S.attSubmitted   = false;
  showScreen('login');
});

// ── App init ──────────────────────────────────────────────────────────────────
async function initApp() {
  showScreen('app');

  // Header
  hdrSchool.textContent = S.school.name;
  hdrDate.textContent   = formatDateAr(todayISO());

  // Reset attendance state
  S.absentTeachers = [];
  S.attSubmitted   = false;
  show(attCard);
  hide(attDone);
  inStuPresent.value = '0';
  inStuAbsent.value  = '0';
  inNotes.value      = '';
  btnSubmitAtt.disabled = false;

  setStatusPending();
  renderAbsentList();
  resetReportForm();
  updateConnUI();

  // Kick off sync of any offline-queued records
  await doSync();
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function bootstrap() {
  try {
    const session = await getCurrentUser();
    if (session && session.role === 'school_admin') {
      S.user = session;
      await initApp();
      return;
    }
  } catch (err) {
    console.warn('[NSAMS] bootstrap session check failed', err);
  }
  showScreen('login');
}

bootstrap();