// ─── FIX #1: استيراد Supabase SDK الصحيح بدلاً من `const { createClient } = supabase` ───
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL     = "https://xocrzpjfvizgnsybegwr.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_HCVzNgEJmov38FWXRO1uFw_DG1d87Y4";

const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ─── FIX #2: تصدير db كـ supabase حتى يعمل import { supabase } from '../shared/db.js' ───
export { db as supabase };

// ─────────────────────────────────────────────────────────────────────────────
// Queue helpers (offline support)
// ─────────────────────────────────────────────────────────────────────────────
const QUEUE_ATTENDANCE = "nsams_pending_attendance";
const QUEUE_REPORTS    = "nsams_pending_reports";

function readQueue(key) {
  try { return JSON.parse(localStorage.getItem(key) || "[]"); }
  catch { return []; }
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

function isOnline() { return navigator.onLine; }

// ─── Auth ─────────────────────────────────────────────────────────────────────
async function login(email, password) {
  const { data: authData, error: authError } =
    await db.auth.signInWithPassword({ email, password });

  if (authError) throw authError;

  const userId = authData.user.id;

  const { data: profile, error: profileError } = await db
    .from("users")
    .select("role, school_id, directorate_id, full_name")
    .eq("id", userId)
    .maybeSingle();

  if (profileError) throw new Error("لا توجد صلاحية لقراءة بيانات المستخدم.");
  if (!profile) throw new Error("المستخدم غير مسجل في النظام.");

  return {
    user: { id: userId, email: authData.user.email, fullName: profile.full_name },
    role: profile.role,
    schoolId: profile.school_id,
    directorateId: profile.directorate_id,
  };
}

async function logout() {
  const { error } = await db.auth.signOut();
  if (error) throw error;
}

async function getCurrentUser() {
  const { data: { session } } = await db.auth.getSession();
  if (!session) return null;

  const { data: profile, error } = await db
    .from("users")
    .select("role, school_id, directorate_id, full_name")
    .eq("id", session.user.id)
    .maybeSingle();

  if (error || !profile) return null;

  return {
    user: { id: session.user.id, email: session.user.email, fullName: profile.full_name },
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

async function getSchoolStatus(schoolId, date) {
  const isoDate = date instanceof Date ? date.toISOString().slice(0, 10) : date;

  const [attendanceRes, reportRes] = await Promise.all([
    db.from("daily_attendance").select("id").eq("school_id", schoolId).eq("date", isoDate).limit(1),
    db.from("emergency_reports").select("id").eq("school_id", schoolId).in("status", ["open", "acknowledged"]).limit(1),
  ]);

  if (attendanceRes.error) throw attendanceRes.error;
  if (reportRes.error) throw reportRes.error;

  return {
    attendanceSubmitted: attendanceRes.data.length > 0,
    hasActiveReport: reportRes.data.length > 0,
  };
}

async function getSchoolById(schoolId) {
  const { data, error } = await db
    .from('schools')
    .select('id, name, total_teachers, total_students, directorate_id')
    .eq('id', schoolId)
    .single();
 
  if (error) throw error;
  return data;
}

// ─── Attendance ───────────────────────────────────────────────────────────────
async function syncAttendanceRecord(record) {
  const { localId, synced: _synced, createdAt: _c, ...payload } = record;
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
  const { localId, synced: _synced, receiptNumber: _r, createdAt: _c, ...payload } = report;
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
    ...report, localId, receiptNumber,
    synced: false, createdAt: new Date().toISOString(), status: "open",
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

// ─── Directorate ──────────────────────────────────────────────────────────────
async function getReportsForDirectorate(directorateId) {
  const { data, error } = await db
    .from("emergency_reports")
    .select("id, type, description, status, receipt_number, created_at, school:schools!inner(id, name)")
    .eq("schools.directorate_id", directorateId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data || []).map((r) => ({ ...r, schoolName: r.school?.name ?? "Unknown" }));
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
    db.from("daily_attendance")
      .select("teachers_present, students_present, school:schools!inner(directorate_id)")
      .eq("date", today)
      .eq("schools.directorate_id", directorateId),
    db.from("emergency_reports")
      .select("id, type, status, created_at, school:schools!inner(name, directorate_id)")
      .in("status", ["open", "acknowledged"])
      .eq("schools.directorate_id", directorateId)
      .order("created_at", { ascending: true })
      .limit(5),
  ]);

  if (attendanceRes.error) throw attendanceRes.error;
  if (reportsRes.error) throw reportsRes.error;

  return {
    totalTeachersPresent: (attendanceRes.data || []).reduce((s, r) => s + (r.teachers_present || 0), 0),
    totalStudentsPresent: (attendanceRes.data || []).reduce((s, r) => s + (r.students_present || 0), 0),
    topPendingReports: (reportsRes.data || []).map((r) => ({
      id: r.id, type: r.type, status: r.status,
      createdAt: r.created_at, schoolName: r.school?.name ?? "Unknown",
    })),
  };
}

async function getSchoolsAttendanceStatus(directorateId, date) {
  const isoDate = date instanceof Date ? date.toISOString().slice(0, 10) : date;
  const schoolsRes = await db.from("schools").select("id").eq("directorate_id", directorateId);
  if (schoolsRes.error) throw schoolsRes.error;

  const ids = (schoolsRes.data || []).map((s) => s.id);
  const [attendanceRes, reportsRes] = await Promise.all([
    db.from("daily_attendance").select("school_id").eq("date", isoDate).in("school_id", ids),
    db.from("emergency_reports").select("school_id").in("status", ["open", "acknowledged"]).in("school_id", ids),
  ]);

  const submittedSet    = new Set((attendanceRes.data || []).map((r) => r.school_id));
  const activeReportSet = new Set((reportsRes.data  || []).map((r) => r.school_id));

  const result = {};
  for (const school of schoolsRes.data || []) {
    result[school.id] = activeReportSet.has(school.id) ? "red"
                      : submittedSet.has(school.id)    ? "green"
                      : "orange";
  }
  return result;
}

// ─── Ministry Functions ───────────────────────────────────────────────────────
// تعمل مع الـ schema الفعلي: daily_attendance(school_id, date, students_present, teachers_present)
// ملاحظة: إذا كان في جدولك عمود students_absent أو students_total، يمكن إضافته هنا.

/**
 * جلب ملخص الحضور الوطني مجمعاً حسب المحافظة.
 * يعيد مصفوفة من { governorate, present, schoolsReported, totalSchools, dirCount }
 */
async function getMinistryAttendanceSummary(date) {
  const isoDate = date instanceof Date ? date.toISOString().slice(0, 10) : date;

  // 1. جلب جميع المديريات مع المحافظة
  const { data: directorates, error: dirErr } = await db
    .from("directorates")
    .select("id, name, governorate")
    .order("governorate");
  if (dirErr) throw dirErr;

  if (!directorates || directorates.length === 0) return [];

  // 2. جلب جميع المدارس مع معرف المديرية
  const { data: schools, error: schErr } = await db
    .from("schools")
    .select("id, directorate_id");
  if (schErr) throw schErr;

  const allSchoolIds = (schools || []).map(s => s.id);

  // 3. جلب سجلات الحضور اليومية (مجمعة لكل مدرسة)
  const { data: attendance, error: attErr } = await db
    .from("daily_attendance")
    .select("school_id, students_present, teachers_present")
    .eq("date", isoDate)
    .in("school_id", allSchoolIds.length > 0 ? allSchoolIds : ["__none__"]);
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
      studentsPresent:  0,
      teachersPresent:  0,
      schoolsReported:  0,
      totalSchools:     dirToSchools[d.id]?.size || 0,
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
    const gov = d.governorate || "Unknown";
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

  return Object.values(govMap).sort((a, b) => a.governorate.localeCompare(b.governorate));
}

/** جلب عدد المحافظات الفريدة */
async function getGovernoratesCount() {
  const { data, error } = await db
    .from("directorates")
    .select("governorate");
  if (error) throw error;
  const unique = new Set((data || []).map(d => d.governorate).filter(Boolean));
  return unique.size;
}

// ─── Sync ─────────────────────────────────────────────────────────────────────
async function syncPending() {
  const results = { attendance: { synced: 0, failed: 0 }, reports: { synced: 0, failed: 0 } };

  for (const record of getPendingAttendance()) {
    try { await syncAttendanceRecord(record); markAttendanceSynced(record.localId); results.attendance.synced++; }
    catch { results.attendance.failed++; }
  }

  for (const report of getPendingReports()) {
    try { await syncReportRecord(report); markReportSynced(report.localId); results.reports.synced++; }
    catch { results.reports.failed++; }
  }

  return results;
}

window.addEventListener("online", () => syncPending().catch(console.error));

window.NSAMS_DB = {
  login, logout, getCurrentUser,
  getSchools, getSchoolStatus, getSchoolById, 
  saveAttendance, getPendingAttendance, markAttendanceSynced,
  submitReport, getPendingReports, markReportSynced,
  getReportsForDirectorate, updateReportStatus,
  getTodaySummary, getSchoolsAttendanceStatus,
  // Ministry
  getMinistryAttendanceSummary, getGovernoratesCount,
  syncPending,
};