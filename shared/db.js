import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL      = "https://xocrzpjfvizgnsybegwr.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_HCVzNgEJmov38FWXRO1uFw_DG1d87Y4";

const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
export { db as supabase };

// ─────────────────────────────────────────────────────────────────────────────
// Queue helpers (offline support)
// ─────────────────────────────────────────────────────────────────────────────
const QUEUE_ATTENDANCE = "nsams_pending_attendance";
const QUEUE_REPORTS    = "nsams_pending_reports";
const QUEUE_STU_ATT    = 'nsams_pending_stu_att';

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
  const localId  = generateLocalId();
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
  const localId       = generateLocalId();
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
    reportingSchoolsCount: new Set(
      (reportsRes.data || []).map(r => r.school?.name).filter(Boolean)
    ).size,
  };
}

async function getSchoolsAttendanceStatus(directorateId, date) {
  const isoDate  = date instanceof Date ? date.toISOString().slice(0, 10) : date;
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
                      : "no_data";
  }
  return result;
}

// ─── Ministry ─────────────────────────────────────────────────────────────────
async function getMinistryAttendanceSummary(date) {
  const isoDate = date instanceof Date ? date.toISOString().slice(0, 10) : date;

  const { data: directorates, error: dirErr } = await db
    .from("directorates")
    .select("id, name, governorate")
    .order("governorate");
  if (dirErr) throw dirErr;
  if (!directorates || directorates.length === 0) return [];

  const { data: schools, error: schErr } = await db
    .from("schools")
    .select("id, directorate_id");
  if (schErr) throw schErr;

  const allSchoolIds = (schools || []).map(s => s.id);

  const { data: attendance, error: attErr } = await db
    .from("daily_attendance")
    .select("school_id, students_present, teachers_present")
    .eq("date", isoDate)
    .in("school_id", allSchoolIds.length > 0 ? allSchoolIds : ["__none__"]);
  if (attErr) throw attErr;

  const schoolToDir  = {};
  const dirToSchools = {};
  for (const s of schools || []) {
    schoolToDir[s.id] = s.directorate_id;
    if (!dirToSchools[s.directorate_id]) dirToSchools[s.directorate_id] = new Set();
    dirToSchools[s.directorate_id].add(s.id);
  }

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

async function getGovernoratesCount() {
  const { data, error } = await db
    .from("directorates")
    .select("governorate");
  if (error) throw error;
  const unique = new Set((data || []).map(d => d.governorate).filter(Boolean));
  return unique.size;
}

// ─── Academic year helper ─────────────────────────────────────────────────────
// Mirrors get_academic_year() SQL function.
// Rule: month >= 9 → current-next, else prev-current
function getAcademicYear(date = new Date()) {
  const month = date.getMonth() + 1;
  const year  = date.getFullYear();
  return month >= 9 ? `${year}-${year + 1}` : `${year - 1}-${year}`;
}

// ─── Arabic grade name ────────────────────────────────────────────────────────
const GRADE_NAMES_AR = {
  1: 'الأول',    2: 'الثاني',    3: 'الثالث',
  4: 'الرابع',   5: 'الخامس',    6: 'السادس',
  7: 'السابع',   8: 'الثامن',    9: 'التاسع',
  10: 'العاشر',  11: 'الحادي عشر', 12: 'الثاني عشر',
};
function gradeNameAr(grade) {
  return GRADE_NAMES_AR[grade] ?? grade.toString();
}

// ─── Teacher: get assigned classes ───────────────────────────────────────────
async function getTeacherClasses(teacherId) {
  const academicYear = getAcademicYear();

  const { data, error } = await db
    .from('class_teacher')
    .select(`
      class_id,
      classes:class_id (
        id, grade, section, school_id,
        schools:school_id ( name )
      )
    `)
    .eq('teacher_id',    teacherId)
    .eq('academic_year', academicYear);

  if (error) throw error;

  return (data || []).map(row => {
    const c = row.classes;
    return {
      id:          c.id,
      grade:       c.grade,
      section:     c.section,
      schoolId:    c.school_id,
      schoolName:  c.schools?.name ?? '',
      academicYear,
      displayName: `الصف ${gradeNameAr(c.grade)} / شعبة ${c.section}`,
    };
  });
}

// ─── Student cache (24-hour TTL) ─────────────────────────────────────────────
const STUDENTS_CACHE_PFX = 'nsams_stu_';
const STUDENTS_CACHE_TTL = 24 * 60 * 60 * 1000;

function getCachedStudents(classId) {
  try {
    const raw = localStorage.getItem(STUDENTS_CACHE_PFX + classId);
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw);
    return (Date.now() - ts < STUDENTS_CACHE_TTL) ? data : null;
  } catch { return null; }
}

function setCachedStudents(classId, data) {
  try {
    localStorage.setItem(
      STUDENTS_CACHE_PFX + classId,
      JSON.stringify({ ts: Date.now(), data })
    );
  } catch { /* storage quota — non-fatal */ }
}

// ─── Teacher: get students for a class ───────────────────────────────────────
async function getClassStudents(classId) {
  if (!isOnline()) {
    const cached = getCachedStudents(classId);
    if (cached) return cached;
    throw new Error('لا يوجد اتصال ولا توجد بيانات محفوظة لهذا الصف');
  }

  const { data, error } = await db
    .from('students')
    .select('id, full_name, national_id, gender, seat_number')
    .eq('class_id',  classId)
    .eq('is_active', true)
    .order('seat_number', { ascending: true,  nullsFirst: false })
    .order('full_name',   { ascending: true });

  if (error) throw error;

  const students = data ?? [];
  setCachedStudents(classId, students);
  return students;
}

// ─── Teacher: check submission status for a class + date ─────────────────────
async function getClassSubmissionStatus(classId, date) {
  const isoDate = date instanceof Date ? date.toISOString().slice(0, 10) : date;

  const { data, error } = await db
    .from('attendance_submissions')
    .select('id, status, submitted_at, confirmed_by, confirmed_at, notes')
    .eq('class_id', classId)
    .eq('date',     isoDate)
    .maybeSingle();

  if (error) throw error;
  return data; // null = not yet submitted
}

// ─── Teacher: load existing attendance records for a class + date ─────────────
// Returns an object: { [student_id]: { status, reason } }
async function getClassAttendanceForDate(classId, date) {
  const isoDate = date instanceof Date ? date.toISOString().slice(0, 10) : date;

  const { data, error } = await db
    .from('daily_student_attendance')
    .select('student_id, status, reason')
    .eq('class_id', classId)
    .eq('date',     isoDate);

  if (error) throw error;

  const map = {};
  for (const row of data ?? []) {
    map[row.student_id] = { status: row.status, reason: row.reason ?? null };
  }
  return map;
}

// ─── Teacher: get attendance report for printing ──────────────────────────────
async function getClassAttendanceReport(classId, date) {
  const isoDate = date instanceof Date ? date.toISOString().slice(0, 10) : date;

  const { data, error } = await db
    .from('daily_student_attendance')
    .select(`
      status, reason,
      students:student_id ( full_name, seat_number )
    `)
    .eq('class_id', classId)
    .eq('date',     isoDate)
    // وبدلاً منه رتّب النتيجة في JS بعد الجلب:
    return (data ?? []).sort
    (
     (a, b) =>
     (a.students?.seat_number ?? 999) - (b.students?.seat_number ?? 999)
    );
}

// ─── Student attendance offline queue ────────────────────────────────────────
function getPendingStudentAttendance() {
  return readQueue(QUEUE_STU_ATT).filter(r => !r.synced);
}

function markStudentAttSynced(localId) {
  const queue = readQueue(QUEUE_STU_ATT).map(r =>
    r.localId === localId ? { ...r, synced: true } : r
  );
  writeQueue(QUEUE_STU_ATT, queue);
}

// Core sync function – called both directly (online path) and by syncPendingV2.
async function syncStudentAttendanceRecord(payload) {
  const { records, classId, schoolId, date, teacherId } = payload;

  const rows = records.map(r => ({
    student_id:  r.studentId,
    class_id:    classId,
    school_id:   schoolId,
    date,
    status:      r.status,
    reason:      r.reason ?? null,
    recorded_by: teacherId,
  }));

  const { error: attErr } = await db
    .from('daily_student_attendance')
    .upsert(rows, { onConflict: 'student_id,date', ignoreDuplicates: false });

  if (attErr) throw attErr;

  const { error: subErr } = await db
    .from('attendance_submissions')
    .upsert(
      {
        class_id:     classId,
        school_id:    schoolId,
        date,
        submitted_by: teacherId,
        submitted_at: new Date().toISOString(),
        status:       'pending',
      },
      { onConflict: 'class_id,date', ignoreDuplicates: false }
    );

  if (subErr) throw subErr;
  return true;
}

async function saveStudentAttendance({ records, classId, schoolId, date, teacherId }) {
  const localId = generateLocalId();
  const payload = {
    localId, records, classId, schoolId, date, teacherId,
    synced: false, createdAt: new Date().toISOString(),
  };

  if (!isOnline()) {
    const queue = readQueue(QUEUE_STU_ATT);
    queue.push(payload);
    writeQueue(QUEUE_STU_ATT, queue);
    return { success: true, localId, synced: false };
  }

  try {
    await syncStudentAttendanceRecord(payload);
    return { success: true, localId, synced: true };
  } catch (err) {
    const queue = readQueue(QUEUE_STU_ATT);
    queue.push(payload);
    writeQueue(QUEUE_STU_ATT, queue);
    console.warn('[NSAMS] saveStudentAttendance: falling back to queue', err);
    return { success: true, localId, synced: false };
  }
}

// ─── School admin: daily summary per class ───────────────────────────────────
async function getSchoolDailySummary(schoolId, date) {
  const isoDate      = date instanceof Date ? date.toISOString().slice(0, 10) : date;
  const academicYear = getAcademicYear(new Date(isoDate));

  const { data: classRows, error: classErr } = await db
    .from('classes')
    .select(`
      id, grade, section,
      class_teacher!left (
        teacher_id,
        users:teacher_id ( full_name )
      )
    `)
    .eq('school_id',    schoolId)
    .eq('academic_year', academicYear);

  if (classErr) throw classErr;

  const classIds = (classRows ?? []).map(c => c.id);
  if (classIds.length === 0) return [];

  const [subRes, attRes, stuRes] = await Promise.all([
    db.from('attendance_submissions')
      .select('id, class_id, status, submitted_at, confirmed_at')
      .eq('school_id', schoolId)
      .eq('date',      isoDate)
      .in('class_id',  classIds),

    db.from('daily_student_attendance')
      .select('class_id, status')
      .eq('school_id', schoolId)
      .eq('date',      isoDate)
      .in('class_id',  classIds),

    db.from('students')
      .select('class_id')
      .eq('school_id', schoolId)
      .eq('is_active', true)
      .in('class_id',  classIds),
  ]);

  if (subRes.error) throw subRes.error;
  if (attRes.error) throw attRes.error;
  if (stuRes.error) throw stuRes.error;

  const subMap = {};
  for (const s of subRes.data ?? []) subMap[s.class_id] = s;

  const attMap = {};
  for (const a of attRes.data ?? []) {
    if (!attMap[a.class_id]) {
      attMap[a.class_id] = { present: 0, absent: 0, late: 0, excused: 0 };
    }
    attMap[a.class_id][a.status]++;
  }

  const stuCount = {};
  for (const s of stuRes.data ?? []) {
    stuCount[s.class_id] = (stuCount[s.class_id] ?? 0) + 1;
  }

  return (classRows ?? []).map(c => {
    const ct = c.class_teacher?.[0];
    return {
      classId:       c.id,
      displayName:   `الصف ${gradeNameAr(c.grade)} / شعبة ${c.section}`,
      grade:         c.grade,
      section:       c.section,
      teacherName:   ct?.users?.full_name ?? '—',
      teacherId:     ct?.teacher_id ?? null,
      submission:    subMap[c.id] ?? null,
      stats:         attMap[c.id] ?? { present: 0, absent: 0, late: 0, excused: 0 },
      totalStudents: stuCount[c.id] ?? 0,
    };
  }).sort((a, b) => a.grade - b.grade || a.section.localeCompare(b.section));
}

// ─── School admin: confirm / reject a class submission ───────────────────────
async function confirmClassSubmission(submissionId, confirmedBy, notes = null) {
  const { error } = await db
    .from('attendance_submissions')
    .update({
      status:       'confirmed',
      confirmed_by: confirmedBy,
      confirmed_at: new Date().toISOString(),
    })
    .eq('id', submissionId)
    .eq('status', 'pending');
  if (error) throw error;
}

async function rejectClassSubmission(submissionId, confirmedBy, notes) {
  if (!notes?.trim()) throw new Error('يجب إدخال سبب الإعادة');
  const { error } = await db
    .from('attendance_submissions')
    .update({
      status:       'rejected',
      confirmed_by: confirmedBy,
      confirmed_at: new Date().toISOString(),
      notes,
    })
    .eq('id', submissionId)
    .eq('status', 'pending');
  if (error) throw error;
}

// ─── Sync ─────────────────────────────────────────────────────────────────────
async function syncPendingV2() {
  const results = {
    attendance: { synced: 0, failed: 0 },
    reports:    { synced: 0, failed: 0 },
    studentAtt: { synced: 0, failed: 0 },
  };

  for (const record of getPendingAttendance()) {
    try {
      await syncAttendanceRecord(record);
      markAttendanceSynced(record.localId);
      results.attendance.synced++;
    } catch { results.attendance.failed++; }
  }

  for (const report of getPendingReports()) {
    try {
      await syncReportRecord(report);
      markReportSynced(report.localId);
      results.reports.synced++;
    } catch { results.reports.failed++; }
  }

  for (const payload of getPendingStudentAttendance()) {
    try {
      await syncStudentAttendanceRecord(payload);
      markStudentAttSynced(payload.localId);
      results.studentAtt.synced++;
    } catch { results.studentAtt.failed++; }
  }

  return results;
}

// ─── Export ───────────────────────────────────────────────────────────────────
window.NSAMS_DB = {
  // Auth
  login,
  logout,
  getCurrentUser,

  // Schools
  getSchools,
  getSchoolStatus,
  getSchoolById,

  // School-level attendance & reports
  saveAttendance,
  getPendingAttendance,
  markAttendanceSynced,
  submitReport,
  getPendingReports,
  markReportSynced,

  // Directorate
  getReportsForDirectorate,
  updateReportStatus,
  getTodaySummary,
  getSchoolsAttendanceStatus,

  // Ministry
  getMinistryAttendanceSummary,
  getGovernoratesCount,

  // Teacher layer
  getAcademicYear,
  gradeNameAr,
  getTeacherClasses,
  getClassStudents,
  getClassSubmissionStatus,
  getClassAttendanceForDate,
  getClassAttendanceReport,
  saveStudentAttendance,
  getPendingStudentAttendance,

  // School admin — class management
  getSchoolDailySummary,
  confirmClassSubmission,
  rejectClassSubmission,

  // Sync
  syncPending: syncPendingV2,
};