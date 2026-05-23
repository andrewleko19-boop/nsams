// shared/db.js

const SUPABASE_URL = "https://xocrzpjfvizgnsybegwr.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_HCVzNgEJmov38FWXRO1uFw_DG1d87Y4";

const { createClient } = supabase;
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ─── Queue Keys ───────────────────────────────────────────────────────────────
const QUEUE_ATTENDANCE = "nsams_pending_attendance";
const QUEUE_REPORTS    = "nsams_pending_reports";

// ─── Queue Helpers ────────────────────────────────────────────────────────────
function readQueue(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || "[]");
  } catch {
    return [];
  }
}

function writeQueue(key, data) {
  localStorage.setItem(key, JSON.stringify(data));
}

function generateLocalId() {
  return `local_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function generateReceiptNumber() {
  return `RPT-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

function isOnline() {
  return navigator.onLine;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
async function login(email, password) {
  // ── 1. مصادقة Supabase Auth ───────────────────────────────────
  const { data: authData, error: authError } =
    await db.auth.signInWithPassword({ email, password });

  if (authError) throw authError;

  const userId = authData.user.id;

  // ── 2. قراءة الملف الشخصي من public.users ────────────────────
  // نحدد الأعمدة بدقة بدلاً من SELECT * لتقليل احتمال رفض RLS
  const { data: profile, error: profileError } = await db
    .from("users")
    .select("role, school_id, directorate_id, full_name")
    .eq("id", userId)
    .maybeSingle(); // maybeSingle بدلاً من single لتجنب خطأ PGRST116

  // ── 3. تشخيص واضح لكل سيناريو خطأ ──────────────────────────
  if (profileError) {
    // permission denied → RLS لم تُطبَّق بعد أو المستخدم غير موجود في public.users
    if (profileError.code === "42501") {
      throw new Error(
        "لا توجد صلاحية لقراءة بيانات المستخدم. " +
        "تأكد من تطبيق سياسات RLS الجديدة في setup.sql."
      );
    }
    throw profileError;
  }

  if (!profile) {
    // المستخدم موجود في auth لكن غير مُضاف في public.users
    await db.auth.signOut();
    throw new Error(
      "المستخدم غير مسجل في النظام. " +
      "يرجى إضافة صف في جدول users بنفس UUID الخاص بـ auth.users."
    );
  }

  // ── 4. إرجاع الجلسة الكاملة ──────────────────────────────────
  return {
    user: {
      id:       userId,
      email:    authData.user.email,
      fullName: profile.full_name,
    },
    role:           profile.role,
    schoolId:       profile.school_id,
    directorateId:  profile.directorate_id,
  };
}

async function logout() {
  const { error } = await db.auth.signOut();
  if (error) throw error;
}

async function getCurrentUser() {
  const { data: { session } } = await db.auth.getSession();
  if (!session) return null;

  const userId = session.user.id;
  const { data: profile, error } = await db
    .from("users")
    .select("role, school_id, directorate_id, full_name")
    .eq("id", userId)
    .single();

  if (error) return null;

  return {
    user: { id: userId, email: session.user.email, fullName: profile.full_name },
    role: profile.role,
    schoolId: profile.school_id,
    directorateId: profile.directorate_id,
  };
}

// ─── Schools ──────────────────────────────────────────────────────────────────
async function getSchools(directorateId) {
  const query = db.from("schools").select("id, name, lat, lng");
  if (directorateId) query.eq("directorate_id", directorateId);

  const { data, error } = await query;
  if (error) throw error;
  return data;
}

// ─── School Status ────────────────────────────────────────────────────────────
async function getSchoolStatus(schoolId, date) {
  const isoDate = date instanceof Date ? date.toISOString().slice(0, 10) : date;

  const [attendanceRes, reportRes] = await Promise.all([
    db
      .from("daily_attendance")
      .select("id")
      .eq("school_id", schoolId)
      .eq("date", isoDate)
      .limit(1),
    db
      .from("emergency_reports")
      .select("id")
      .eq("school_id", schoolId)
      .in("status", ["open", "acknowledged"])
      .limit(1),
  ]);

  if (attendanceRes.error) throw attendanceRes.error;
  if (reportRes.error) throw reportRes.error;

  return {
    attendanceSubmitted: attendanceRes.data.length > 0,
    hasActiveReport: reportRes.data.length > 0,
  };
}

// ─── Attendance ───────────────────────────────────────────────────────────────
async function syncAttendanceRecord(record) {
  const { localId, synced: _synced, ...payload } = record;

  const { error } = await db.from("daily_attendance").upsert(payload, {
    onConflict: "school_id,date",
    ignoreDuplicates: false,
  });

  if (error) throw error;
  return true;
}

async function saveAttendance(record) {
  const localId = generateLocalId();
  const enriched = { ...record, localId, synced: false, createdAt: new Date().toISOString() };

  if (!isOnline()) {
    const queue = readQueue(QUEUE_ATTENDANCE);
    queue.push(enriched);
    writeQueue(QUEUE_ATTENDANCE, queue);
    return { success: true, localId, synced: false };
  }

  try {
    await syncAttendanceRecord(enriched);
    return { success: true, localId, synced: true };
  } catch {
    const queue = readQueue(QUEUE_ATTENDANCE);
    queue.push(enriched);
    writeQueue(QUEUE_ATTENDANCE, queue);
    return { success: true, localId, synced: false };
  }
}

function getPendingAttendance() {
  return readQueue(QUEUE_ATTENDANCE).filter((r) => !r.synced);
}

function markAttendanceSynced(localId) {
  const queue = readQueue(QUEUE_ATTENDANCE).map((r) =>
    r.localId === localId ? { ...r, synced: true } : r
  );
  writeQueue(QUEUE_ATTENDANCE, queue);
}

// ─── Reports ──────────────────────────────────────────────────────────────────
async function syncReportRecord(report) {
  const { localId, synced: _synced, receiptNumber: _r, ...payload } = report;

  const { data, error } = await db
    .from("emergency_reports")
    .insert(payload)
    .select("id, receipt_number, created_at, status")
    .single();

  if (error) throw error;
  return data;
}

async function submitReport(report) {
  const localId = generateLocalId();
  const receiptNumber = generateReceiptNumber();
  const enriched = {
    ...report,
    localId,
    receiptNumber,
    synced: false,
    createdAt: new Date().toISOString(),
    status: "open",
  };

  if (!isOnline()) {
    const queue = readQueue(QUEUE_REPORTS);
    queue.push(enriched);
    writeQueue(QUEUE_REPORTS, queue);
    return { id: localId, receiptNumber, createdAt: enriched.createdAt, status: "open" };
  }

  try {
    const result = await syncReportRecord(enriched);
    return {
      id: result.id,
      receiptNumber: result.receipt_number,
      createdAt: result.created_at,
      status: result.status,
    };
  } catch {
    const queue = readQueue(QUEUE_REPORTS);
    queue.push(enriched);
    writeQueue(QUEUE_REPORTS, queue);
    return { id: localId, receiptNumber, createdAt: enriched.createdAt, status: "open" };
  }
}

function getPendingReports() {
  return readQueue(QUEUE_REPORTS).filter((r) => !r.synced);
}

function markReportSynced(localId) {
  const queue = readQueue(QUEUE_REPORTS).map((r) =>
    r.localId === localId ? { ...r, synced: true } : r
  );
  writeQueue(QUEUE_REPORTS, queue);
}

// ─── Directorate Views ────────────────────────────────────────────────────────
async function getReportsForDirectorate(directorateId) {
  const { data, error } = await db
    .from("emergency_reports")
    .select(`
      id,
      type,
      description,
      status,
      receipt_number,
      created_at,
      school:schools (id, name)
    `)
    .eq("schools.directorate_id", directorateId)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return (data || []).map((r) => ({
    ...r,
    schoolName: r.school?.name ?? "Unknown",
  }));
}

async function updateReportStatus(reportId, newStatus) {
  const allowed = ["open", "acknowledged", "resolved"];
  if (!allowed.includes(newStatus)) throw new Error(`Invalid status: ${newStatus}`);

  const { error } = await db
    .from("emergency_reports")
    .update({ status: newStatus, updated_at: new Date().toISOString() })
    .eq("id", reportId);

  if (error) throw error;
}

async function getTodaySummary(directorateId) {
  const today = new Date().toISOString().slice(0, 10);

  const [attendanceRes, reportsRes] = await Promise.all([
    db
      .from("daily_attendance")
      .select(`
        teachers_present,
        students_present,
        school:schools!inner (directorate_id)
      `)
      .eq("date", today)
      .eq("schools.directorate_id", directorateId),
    db
      .from("emergency_reports")
      .select(`
        id,
        type,
        status,
        created_at,
        school:schools!inner (name, directorate_id)
      `)
      .in("status", ["open", "acknowledged"])
      .eq("schools.directorate_id", directorateId)
      .order("created_at", { ascending: true })
      .limit(5),
  ]);

  if (attendanceRes.error) throw attendanceRes.error;
  if (reportsRes.error) throw reportsRes.error;

  const totalTeachersPresent = (attendanceRes.data || []).reduce(
    (sum, r) => sum + (r.teachers_present || 0), 0
  );
  const totalStudentsPresent = (attendanceRes.data || []).reduce(
    (sum, r) => sum + (r.students_present || 0), 0
  );

  const topPendingReports = (reportsRes.data || []).map((r) => ({
    id: r.id,
    type: r.type,
    status: r.status,
    createdAt: r.created_at,
    schoolName: r.school?.name ?? "Unknown",
  }));

  return { totalTeachersPresent, totalStudentsPresent, topPendingReports };
}

async function getSchoolsAttendanceStatus(directorateId, date) {
  const isoDate = date instanceof Date ? date.toISOString().slice(0, 10) : date;

  const [schoolsRes, attendanceRes, reportsRes] = await Promise.all([
    db.from("schools").select("id").eq("directorate_id", directorateId),
    db
      .from("daily_attendance")
      .select("school_id")
      .eq("date", isoDate)
      .in(
        "school_id",
        (await db.from("schools").select("id").eq("directorate_id", directorateId)).data?.map(
          (s) => s.id
        ) || []
      ),
    db
      .from("emergency_reports")
      .select("school_id")
      .in("status", ["open", "acknowledged"]),
  ]);

  if (schoolsRes.error) throw schoolsRes.error;

  const submittedSet = new Set(
    (attendanceRes.data || []).map((r) => r.school_id)
  );
  const activeReportSet = new Set(
    (reportsRes.data || []).map((r) => r.school_id)
  );

  const result = {};
  for (const school of schoolsRes.data || []) {
    const hasAttendance = submittedSet.has(school.id);
    const hasReport = activeReportSet.has(school.id);

    if (hasReport) {
      result[school.id] = "red";
    } else if (hasAttendance) {
      result[school.id] = "green";
    } else {
      result[school.id] = "orange";
    }
  }

  return result;
}

// ─── Sync Engine ──────────────────────────────────────────────────────────────
async function syncPending() {
  const results = { attendance: { synced: 0, failed: 0 }, reports: { synced: 0, failed: 0 } };

  const pendingAttendance = getPendingAttendance();
  for (const record of pendingAttendance) {
    try {
      await syncAttendanceRecord(record);
      markAttendanceSynced(record.localId);
      results.attendance.synced++;
    } catch {
      results.attendance.failed++;
    }
  }

  const pendingReports = getPendingReports();
  for (const report of pendingReports) {
    try {
      await syncReportRecord(report);
      markReportSynced(report.localId);
      results.reports.synced++;
    } catch {
      results.reports.failed++;
    }
  }

  return results;
}

// ─── Auto-sync on reconnect ───────────────────────────────────────────────────
window.addEventListener("online", () => {
  syncPending().catch(console.error);
});

// ─── Exports ──────────────────────────────────────────────────────────────────
window.NSAMS_DB = {
  login,
  logout,
  getCurrentUser,
  getSchools,
  getSchoolStatus,
  saveAttendance,
  getPendingAttendance,
  markAttendanceSynced,
  submitReport,
  getPendingReports,
  markReportSynced,
  getReportsForDirectorate,
  updateReportStatus,
  getTodaySummary,
  getSchoolsAttendanceStatus,
  syncPending,
};