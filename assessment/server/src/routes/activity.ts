import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { execute, queryAll, queryOne, transaction } from '../services/db';
import { UPLOADS_DIR, ensureDir, resolveStoredPath, toStoredPath } from '../services/storage';
import { entriesFromImportSource } from '../services/importEntries';
import { ArtifactImportService, type ArtifactImportResult } from '../services/artifactImportService';
import { WorkbookGateway } from '../services/lessonPlanExcel';
import { appendArtifactContents, type ArtifactRow } from '../services/artifactPrompt';
import { buildAnthropicMessageParams, callLLM, createAnthropicMessageBatch, getLLMSettings, type AnthropicBatchRequest } from '../services/llm';
import { decodeUploadFilename } from '../services/filename';
import { parseActivityReflectionCsv } from '../services/activityReflectionCsv';
import { activityDateFromPath, importDateFolders, isReflectionImportPath } from '../services/activityImportPaths';
import { activityFilenameDecision, nextActivityLessonNo } from '../services/activityRules';
import { parseFirstJson } from '../services/json';

const router = Router();
const TEMP_DIR = path.join(UPLOADS_DIR, 'temp');
const ACTIVITY_DIR = path.join(UPLOADS_DIR, 'activity');
[TEMP_DIR, ACTIVITY_DIR].forEach(ensureDir);
const upload = multer({ dest: TEMP_DIR, limits: { fileSize: 500 * 1024 * 1024 } });

interface ClassRow { id: number; year: number; semester: number; grade: number; subject: string; room: string }
interface StudentRow { id: number; student_num: number; name: string }

function resultStudent(student: StudentRow) {
  return {
    studentId: student.id,
    student: `${student.student_num}${student.name}`,
    classNum: Math.floor((student.student_num % 10000) / 100),
    seatNum: student.student_num % 100,
    studentName: student.name,
  };
}

function safeSegment(value: string): string {
  return value.normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim() || '_';
}

function mimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return ({ '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.ipynb': 'application/x-ipynb+json; charset=utf-8', '.py': 'text/x-python; charset=utf-8',
    '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' } as Record<string, string>)[ext] || 'application/octet-stream';
}

async function classById(classId: string | number): Promise<ClassRow | null> {
  return queryOne<ClassRow>('SELECT id,year,semester,grade,subject,room FROM classes WHERE id=?', [classId]);
}

async function planSettings(cls: ClassRow): Promise<any> {
  return queryOne<any>(
    'SELECT * FROM subject_plan_settings WHERE year=? AND semester=? AND grade=? AND subject=?',
    [cls.year, cls.semester, cls.grade, cls.subject]
  );
}

async function assertAppMode(cls: ClassRow): Promise<void> {
  const settings = await planSettings(cls);
  if (settings?.record_mode === 'excel') throw new Error('엑셀 모드에서는 날짜와 관찰을 앱에서 수정할 수 없습니다.');
}

async function progressForLesson(cls: ClassRow, lessonNo: number): Promise<string> {
  const settings = await planSettings(cls);
  if (settings?.record_mode === 'excel') {
    const excelPath = resolveStoredPath(settings.source_filepath || settings.excel_path || '');
    if (!excelPath || !fs.existsSync(excelPath)) return '';
    return (await WorkbookGateway.open(excelPath)).readPlans().find(item => item.lessonNo === lessonNo)?.progress || '';
  }
  const plan = await queryOne<{ progress: string }>(
    'SELECT progress FROM lesson_plans WHERE year=? AND semester=? AND grade=? AND subject=? AND lesson_no=? ORDER BY sort_order LIMIT 1',
    [cls.year, cls.semester, cls.grade, cls.subject, lessonNo]
  );
  return String(plan?.progress || '');
}

async function syncAppProgress(classId: string | number): Promise<void> {
  const cls = await classById(classId);
  if (!cls) return;
  const settings = await planSettings(cls);
  if (settings?.record_mode === 'excel') return;
  const dates = await queryAll<{ id: number; lesson_no: number; progress: string }>('SELECT id,lesson_no,progress FROM activity_dates WHERE class_id=?', [classId]);
  for (const date of dates) {
    const progress = await progressForLesson(cls, Number(date.lesson_no));
    if (progress !== date.progress) await execute('UPDATE activity_dates SET progress=?,updated_at=datetime(\'now\') WHERE id=?', [progress, date.id]);
  }
}

async function syncExcelClass(classId: string | number): Promise<void> {
  const cls = await classById(classId);
  if (!cls) throw new Error('수업을 찾을 수 없습니다.');
  const settings = await planSettings(cls);
  if (settings?.record_mode !== 'excel') return;
  const excelPath = resolveStoredPath(settings.source_filepath || settings.excel_path || '');
  if (!excelPath || !fs.existsSync(excelPath)) throw new Error('일지 엑셀 파일을 찾을 수 없습니다.');
  const reader = await WorkbookGateway.open(excelPath);
  const dates = reader.readClassroom(cls.room);
  const students = await queryAll<StudentRow>('SELECT id,student_num,name FROM class_students WHERE class_id=?', [classId]);
  await transaction(async () => {
    for (const item of dates) {
      await execute(
        `INSERT INTO activity_dates(class_id,activity_date,lesson_no,progress,journal,source_mode,updated_at)
         VALUES(?,?,?,?,?,'excel',datetime('now'))
         ON CONFLICT(class_id,activity_date) DO UPDATE SET lesson_no=excluded.lesson_no,progress=excluded.progress,
           journal=excluded.journal,source_mode='excel',updated_at=datetime('now')`,
        [classId, item.date, item.lessonNo, item.progress, item.journal]
      );
      const dateRow = await queryOne<{ id: number }>('SELECT id FROM activity_dates WHERE class_id=? AND activity_date=?', [classId, item.date]);
      if (!dateRow) continue;
      await execute('DELETE FROM activity_observations WHERE activity_date_id=?', [dateRow.id]);
      for (const observation of item.observations) {
        const expectedStudentNum = cls.grade * 10000 + observation.classNum * 100 + observation.seatNum;
        const student = students.find(candidate => candidate.student_num === expectedStudentNum);
        if (!student) continue;
        await execute(
          `INSERT INTO activity_observations(student_id,activity_date_id,is_absent,note,updated_at)
           VALUES(?,?,?,?,datetime('now'))
           ON CONFLICT(student_id,activity_date_id) DO UPDATE SET is_absent=excluded.is_absent,note=excluded.note,updated_at=datetime('now')`,
          [student.id, dateRow.id, observation.absent ? 1 : 0, observation.note]
        );
      }
    }
    const activeDates = dates.map(item => item.date);
    if (activeDates.length) {
      await execute(
        `UPDATE activity_dates SET source_mode='excel_deleted',updated_at=datetime('now')
         WHERE class_id=? AND source_mode IN ('excel','excel_deleted') AND activity_date NOT IN (${activeDates.map(() => '?').join(',')})`,
        [classId, ...activeDates]
      );
    } else {
      await execute(
        `UPDATE activity_dates SET source_mode='excel_deleted',updated_at=datetime('now')
         WHERE class_id=? AND source_mode IN ('excel','excel_deleted')`,
        [classId]
      );
    }
  });
}

router.get('/:classId/dates', async (req, res) => {
  try {
    await syncExcelClass(req.params.classId);
    await syncAppProgress(req.params.classId);
    const rows = await queryAll<any>(
      `SELECT d.*,
         (SELECT COUNT(*) FROM activity_files f WHERE f.activity_date_id=d.id AND COALESCE(f.summarized_at,'')='') AS pending_file_count
       FROM activity_dates d WHERE d.class_id=? AND d.source_mode!='excel_deleted' ORDER BY d.activity_date,d.id`,
      [req.params.classId]
    );
    res.json(rows);
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
});

router.post('/:classId/dates', async (req, res) => {
  try {
    const cls = await classById(req.params.classId);
    if (!cls) return res.status(404).json({ error: '수업을 찾을 수 없습니다.' });
    await assertAppMode(cls);
    const date = String(req.body.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: '날짜 형식이 올바르지 않습니다.' });
    const previous = await queryOne<{ lesson_no: number }>('SELECT lesson_no FROM activity_dates WHERE class_id=? ORDER BY activity_date DESC,id DESC LIMIT 1', [cls.id]);
    const lessonNo = Number(req.body.lessonNo ?? nextActivityLessonNo(previous?.lesson_no));
    const progress = await progressForLesson(cls, lessonNo);
    const result = await execute(
      `INSERT INTO activity_dates(class_id,activity_date,lesson_no,progress,journal,source_mode)
       VALUES(?,?,?,?,?,'app')`,
      [cls.id, date, lessonNo, progress, String(req.body.journal || '')]
    );
    res.json({ id: Number(result.lastInsertRowid) });
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
});

router.patch('/:classId/dates/:id', async (req, res) => {
  try {
    const cls = await classById(req.params.classId);
    if (!cls) return res.status(404).json({ error: '수업을 찾을 수 없습니다.' });
    await assertAppMode(cls);
    const date = String(req.body.date || '');
    const lessonNo = Number(req.body.lessonNo || 0);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || lessonNo <= 0) return res.status(400).json({ error: '날짜와 차시가 올바르지 않습니다.' });
    const progress = await progressForLesson(cls, lessonNo);
    await execute(
      `UPDATE activity_dates SET activity_date=?,lesson_no=?,progress=?,journal=?,updated_at=datetime('now') WHERE id=? AND class_id=?`,
      [date, lessonNo, progress, String(req.body.journal || ''), req.params.id, cls.id]
    );
    res.json({ ok: true });
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
});

router.delete('/:classId/dates/:id', async (req, res) => {
  try {
    const cls = await classById(req.params.classId);
    if (!cls) return res.status(404).json({ error: '수업을 찾을 수 없습니다.' });
    await assertAppMode(cls);
    const fileCount = await queryOne<{ count: number }>('SELECT COUNT(*) AS count FROM activity_files WHERE activity_date_id=?', [req.params.id]);
    if (Number(fileCount?.count || 0) > 0) return res.status(409).json({ error: '파일이 연결된 날짜는 삭제할 수 없습니다.' });
    await execute('DELETE FROM activity_dates WHERE id=? AND class_id=?', [req.params.id, cls.id]);
    res.json({ ok: true });
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
});

router.get('/:classId/table', async (req, res) => {
  try {
    await syncExcelClass(req.params.classId);
    const date = String(req.query.date || '');
    const dateRow = await queryOne<any>("SELECT * FROM activity_dates WHERE class_id=? AND activity_date=? AND source_mode!='excel_deleted'", [req.params.classId, date]);
    if (!dateRow) return res.status(404).json({ error: '날짜 칸을 찾을 수 없습니다.' });
    const students = await queryAll<any>(
      `SELECT cs.id,cs.student_num,cs.name,
         COALESCE(s.id,0) AS summary_id,COALESCE(s.summary,'') AS summary,COALESCE(s.summary,'') AS saved_summary,COALESCE(s.manually_edited,0) AS manually_edited,
         COALESCE(o.is_absent,0) AS is_absent,COALESCE(o.note,'') AS observation,
         COALESCE(r.topic,'') AS topic,COALESCE(r.plus_text,'') AS plus_text,
         COALESCE(r.minus_text,'') AS minus_text,COALESCE(r.interesting_text,'') AS interesting_text,
         COALESCE(ss.summary,'') AS semester_summary
       FROM class_students cs
       LEFT JOIN activity_summaries s ON s.student_id=cs.id AND s.activity_date_id=?
       LEFT JOIN activity_observations o ON o.student_id=cs.id AND o.activity_date_id=?
       LEFT JOIN activity_reflections r ON r.student_id=cs.id AND r.activity_date=?
       LEFT JOIN activity_semester_summaries ss ON ss.student_id=cs.id
       WHERE cs.class_id=? ORDER BY cs.student_num,cs.id`,
      [dateRow.id, dateRow.id, date, req.params.classId]
    );
    const files = await queryAll<any>(
      `SELECT f.* FROM activity_files f JOIN class_students cs ON cs.id=f.student_id
       WHERE cs.class_id=? AND f.activity_date_id=? ORDER BY f.uploaded_at,f.id`,
      [req.params.classId, dateRow.id]
    );
    res.json({ date: dateRow, students: students.map(student => ({ ...student, files: files.filter(file => file.student_id === student.id) })) });
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
});

router.patch('/summaries/:id', async (req, res) => {
  await execute('UPDATE activity_summaries SET summary=?,manually_edited=1,updated_at=datetime(\'now\') WHERE id=?', [String(req.body.summary || ''), req.params.id]);
  res.json({ ok: true });
});

router.put('/:classId/summaries', async (req, res) => {
  const dateRow = await queryOne<{ id: number }>('SELECT id FROM activity_dates WHERE class_id=? AND activity_date=?', [req.params.classId, String(req.body.date || '')]);
  if (!dateRow) return res.status(404).json({ error: '날짜 칸을 찾을 수 없습니다.' });
  const generated = !!req.body.generated;
  await execute(
    `INSERT INTO activity_summaries(student_id,activity_date_id,summary,manually_edited,updated_at)
     VALUES(?,?,?,?,datetime('now')) ON CONFLICT(student_id,activity_date_id) DO UPDATE SET
       summary=excluded.summary,manually_edited=excluded.manually_edited,updated_at=datetime('now')`,
    [Number(req.body.studentId), dateRow.id, String(req.body.summary || ''), generated ? 0 : 1]
  );
  if (generated) await execute(
    'UPDATE activity_files SET summarized_at=datetime(\'now\') WHERE student_id=? AND activity_date_id=?',
    [Number(req.body.studentId), dateRow.id]
  );
  res.json({ ok: true });
});

router.put('/:classId/semester-summaries', async (req, res) => {
  const student = await queryOne<{ id: number }>('SELECT id FROM class_students WHERE id=? AND class_id=?', [Number(req.body.studentId), req.params.classId]);
  if (!student) return res.status(404).json({ error: '학생을 찾을 수 없습니다.' });
  await execute(
    `INSERT INTO activity_semester_summaries(student_id,summary,updated_at) VALUES(?,?,datetime('now'))
     ON CONFLICT(student_id) DO UPDATE SET summary=excluded.summary,updated_at=datetime('now')`,
    [student.id, String(req.body.summary || '')]
  );
  res.json({ ok: true });
});

router.put('/:classId/observations', async (req, res) => {
  const cls = await classById(req.params.classId);
  if (!cls) return res.status(404).json({ error: '수업을 찾을 수 없습니다.' });
  try { await assertAppMode(cls); } catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  const dateRow = await queryOne<{ id: number }>('SELECT id FROM activity_dates WHERE class_id=? AND activity_date=?', [cls.id, String(req.body.date || '')]);
  if (!dateRow) return res.status(404).json({ error: '날짜 칸을 찾을 수 없습니다.' });
  await execute(
    `INSERT INTO activity_observations(student_id,activity_date_id,is_absent,note,updated_at)
     VALUES(?,?,?,?,datetime('now')) ON CONFLICT(student_id,activity_date_id) DO UPDATE SET
       is_absent=excluded.is_absent,note=excluded.note,updated_at=datetime('now')`,
    [Number(req.body.studentId), dateRow.id, req.body.isAbsent ? 1 : 0, String(req.body.note || '')]
  );
  res.json({ ok: true });
});

router.delete('/:classId/content', async (req, res) => {
  const cls = await classById(req.params.classId);
  if (!cls) return res.status(404).json({ error: '수업을 찾을 수 없습니다.' });
  const requestedIds = Array.isArray(req.body.studentIds) ? req.body.studentIds.map(Number).filter(Number.isFinite) : [];
  const views = new Set(Array.isArray(req.body.views) ? req.body.views.map(String) : []);
  const dates = Array.isArray(req.body.dates) ? req.body.dates.map(String).filter(Boolean) : [];
  if (!requestedIds.length || !views.size) return res.status(400).json({ error: '삭제할 학생과 내용을 선택해 주세요.' });
  const students = await queryAll<{ id: number }>(
    `SELECT id FROM class_students WHERE class_id=? AND id IN (${requestedIds.map(() => '?').join(',')})`,
    [cls.id, ...requestedIds]
  );
  const studentIds = students.map(student => student.id);
  if (!studentIds.length) return res.status(400).json({ error: '선택한 강의실의 학생이 아닙니다.' });
  const dateRows = dates.length ? await queryAll<{ id: number; activity_date: string }>(
    `SELECT id,activity_date FROM activity_dates WHERE class_id=? AND source_mode!='excel_deleted' AND activity_date IN (${dates.map(() => '?').join(',')})`,
    [cls.id, ...dates]
  ) : await queryAll<{ id: number; activity_date: string }>("SELECT id,activity_date FROM activity_dates WHERE class_id=? AND source_mode!='excel_deleted'", [cls.id]);
  const dateIds = dateRows.map(date => date.id);
  const studentMarks = studentIds.map(() => '?').join(',');
  const dateMarks = dateIds.map(() => '?').join(',');
  await transaction(async () => {
    if (views.has('activity') && dateIds.length) await execute(`DELETE FROM activity_summaries WHERE student_id IN (${studentMarks}) AND activity_date_id IN (${dateMarks})`, [...studentIds, ...dateIds]);
    if (views.has('observation') && dateIds.length && (await planSettings(cls))?.record_mode !== 'excel') {
      await execute(`DELETE FROM activity_observations WHERE student_id IN (${studentMarks}) AND activity_date_id IN (${dateMarks})`, [...studentIds, ...dateIds]);
    }
    if (views.has('reflection') && dateRows.length) {
      await execute(`DELETE FROM activity_reflections WHERE student_id IN (${studentMarks}) AND activity_date IN (${dateRows.map(() => '?').join(',')})`, [...studentIds, ...dateRows.map(date => date.activity_date)]);
    }
    if (views.has('comprehensive')) await execute(`DELETE FROM activity_semester_summaries WHERE student_id IN (${studentMarks})`, studentIds);
  });
  res.json({ ok: true });
});

router.post('/:classId/files', upload.array('files'), async (req, res) => {
  const files = (req.files || []) as Express.Multer.File[];
  const moved = new Set<string>();
  try {
    const cls = await classById(req.params.classId);
    if (!cls) return res.status(404).json({ error: '수업을 찾을 수 없습니다.' });
    const studentId = Number(req.body.studentId);
    const date = String(req.body.date || '');
    const student = await queryOne<StudentRow>('SELECT id,student_num,name FROM class_students WHERE id=? AND class_id=?', [studentId, cls.id]);
    if (!student) return res.status(400).json({ error: '선택한 강의실의 학생이 아닙니다.' });
    const dateRow = await queryOne<{ id: number }>('SELECT id FROM activity_dates WHERE class_id=? AND activity_date=?', [cls.id, date]);
    if (!dateRow) return res.status(400).json({ error: '선택한 강의실의 수업 날짜가 아닙니다.' });
    const existingFiles = await queryAll<{ filename: string }>('SELECT filename FROM activity_files WHERE student_id=? AND activity_date_id=?', [student.id, dateRow.id]);
    const existingFilenames = new Set(existingFiles.map(file => file.filename));
    let added = 0, unchanged = 0;
    for (const file of files) {
      const filename = decodeUploadFilename(file.originalname).normalize('NFC');
      if (activityFilenameDecision(existingFilenames, filename) === 'unchanged') { unchanged += 1; continue; }
      const targetDir = path.join(ACTIVITY_DIR, String(cls.year), String(cls.semester), String(cls.grade), safeSegment(cls.subject), safeSegment(cls.room), date);
      ensureDir(targetDir);
      const targetPath = path.join(targetDir, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safeSegment(filename)}`);
      fs.renameSync(file.path, targetPath);
      moved.add(file.path);
      await execute(
        `INSERT INTO activity_files(student_id,activity_date_id,filename,original_filename,filepath,mime_type,size)
         VALUES(?,?,?,?,?,?,?)`,
        [student.id, dateRow.id, filename, originalFilename(filename), toStoredPath(targetPath), mimeType(filename), file.size]
      );
      existingFilenames.add(filename);
      added += 1;
    }
    res.json({ ok: true, added, unchanged });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    for (const file of files) if (!moved.has(file.path)) try { fs.unlinkSync(file.path); } catch {}
  }
});

function originalFilename(filename: string): string {
  return filename.match(/^\d+_[^_]+__\d{4}-\d{2}-\d{2}_\d{4}__(.+)$/)?.[1] || filename;
}

async function importReflections(buffer: Buffer, student: StudentRow): Promise<number> {
  const records = parseActivityReflectionCsv(buffer);
  for (const record of records) {
    await execute(
      `INSERT INTO activity_reflections(student_id,activity_date,topic,plus_text,minus_text,interesting_text,updated_at)
       VALUES(?,?,?,?,?,?,datetime('now')) ON CONFLICT(student_id,activity_date) DO UPDATE SET
       topic=excluded.topic,plus_text=excluded.plus_text,minus_text=excluded.minus_text,
       interesting_text=excluded.interesting_text,updated_at=datetime('now')`,
      [student.id, record.date, record.topic, record.plus, record.minus, record.interesting]
    );
  }
  return records.length;
}

router.post('/:classId/import', upload.single('file'), async (req: Request, res: Response) => {
  const tempPath = req.file?.path || '';
  try {
    const cls = await classById(req.params.classId);
    if (!cls) throw new Error('수업을 찾을 수 없습니다.');
    await syncExcelClass(cls.id);
    const folderPath = String(req.body.folderPath || '');
    const selectedDate = String(req.body.selectedDate || '');
    const allowDateFolders = req.body.allowDateFolders === true || req.body.allowDateFolders === 'true';
    if (!req.file && !folderPath) throw new Error('ZIP 파일 또는 폴더 경로가 필요합니다.');
    const entries = await entriesFromImportSource({ zipPath: req.file?.path, folderPath });
    const dateFolders = importDateFolders(entries);
    if (selectedDate && dateFolders.length && !allowDateFolders) {
      return res.status(409).json({
        code: 'DATE_FOLDERS_FOUND',
        error: `선택한 폴더 안에 날짜로 시작하는 폴더가 있습니다: ${dateFolders.join(', ')}`,
        dateFolders,
      });
    }
    const students = await queryAll<StudentRow>('SELECT id,student_num,name FROM class_students WHERE class_id=?', [cls.id]);
    const dateRows = await queryAll<{ id: number; activity_date: string }>("SELECT id,activity_date FROM activity_dates WHERE class_id=? AND source_mode!='excel_deleted'", [cls.id]);
    const dateMap = new Map(dateRows.map(row => [row.activity_date, row.id]));
    type ActivityTarget =
      | { kind: 'reflection' }
      | { kind: 'artifact'; activityDate: string; dateId: number; original: string; previous: boolean };
    let reflections = 0;
    const importer = new ArtifactImportService<StudentRow, ActivityTarget>(students, {
      include: (entry, filename) => {
        if (filename.startsWith('_')) return false;
        const reflection = isReflectionImportPath(entry.relativePath);
        if (selectedDate) return !reflection;
        if (reflection) return path.extname(filename).toLowerCase() === '.csv';
        return !!activityDateFromPath(entry.relativePath);
      },
      studentResult: resultStudent,
      resolve: async context => {
        if (isReflectionImportPath(context.path)) return { kind: 'read', target: { kind: 'reflection' } };
        const activityDate = selectedDate || activityDateFromPath(context.path);
        const dateId = dateMap.get(activityDate);
        if (!dateId) return { kind: 'result', result: { path: context.path, status: 'date_missing', ...resultStudent(context.student), date: activityDate, reason: '날짜 칸 없음' } };
        const same = await queryOne<{ id: number }>('SELECT id FROM activity_files WHERE student_id=? AND activity_date_id=? AND filename=?', [context.student.id, dateId, context.filename]);
        if (same) return { kind: 'result', result: { path: context.path, status: 'unchanged', ...resultStudent(context.student), date: activityDate, filename: context.filename } };
        const original = originalFilename(context.filename);
        const previous = !!await queryOne<{ id: number }>('SELECT id FROM activity_files WHERE student_id=? AND activity_date_id=? AND original_filename=? LIMIT 1', [context.student.id, dateId, original]);
        return { kind: 'read', target: { kind: 'artifact', activityDate, dateId, original, previous } };
      },
      store: async context => {
        if (context.target.kind === 'reflection') {
          const count = await importReflections(context.buffer, context.student);
          reflections += count;
          return { path: context.path, status: 'reflection', ...resultStudent(context.student), reason: `${count}개 성찰 반영` };
        }
        const targetDir = path.join(ACTIVITY_DIR, String(cls.year), String(cls.semester), String(cls.grade), safeSegment(cls.subject), safeSegment(cls.room), context.target.activityDate);
        ensureDir(targetDir);
        const targetPath = path.join(targetDir, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safeSegment(context.filename)}`);
        fs.writeFileSync(targetPath, context.buffer);
        await execute(
          `INSERT INTO activity_files(student_id,activity_date_id,filename,original_filename,filepath,mime_type,size)
           VALUES(?,?,?,?,?,?,?)`,
          [context.student.id, context.target.dateId, context.filename, context.target.original, toStoredPath(targetPath), mimeType(context.filename), context.buffer.length]
        );
        return { path: context.path, status: context.target.previous ? 'updated' : 'added', ...resultStudent(context.student), date: context.target.activityDate, filename: context.filename };
      },
    });
    const imported = await importer.run(entries);
    const results: ArtifactImportResult[] = imported.results;
    const added = results.filter(result => result.status === 'added').length;
    const updated = results.filter(result => result.status === 'updated').length;
    const unchanged = results.filter(result => result.status === 'unchanged').length;
    res.json({ message: '활동 기록 불러오기를 완료했습니다.', total: imported.total, added, updated, unchanged, reflections,
      studentCount: imported.matchedStudentIds.size, unmatchedCount: results.filter(r => r.status === 'unmatched').length,
      dateMissingCount: results.filter(r => r.status === 'date_missing').length,
      conflictCount: results.filter(r => r.status === 'conflict').length,
      errorCount: results.filter(r => r.status === 'read_error').length, results });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    if (tempPath) try { fs.unlinkSync(tempPath); } catch {}
  }
});

function findSourceFile(root: string, filename: string): string {
  if (!root || !filename || !fs.existsSync(root)) return '';
  const target = path.basename(filename).normalize('NFC');
  const walk = (dir: string): string => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.normalize('NFC') === target) return full;
      if (entry.isDirectory()) { const found = walk(full); if (found) return found; }
    }
    return '';
  };
  return walk(root);
}

function sanitizeStudentText(text: string, student: { student_num: number; name: string; personal_num?: string }): string {
  let result = text;
  for (const value of [String(student.student_num), student.name, String(student.personal_num || '')].filter(Boolean)) {
    result = result.split(value).join('[삭제]');
  }
  return result.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[이메일 삭제]');
}

function summaryFromResponse(text: string): string {
  const parsed = parseFirstJson<{ summary?: unknown }>(text, 'object');
  return String(parsed.summary || '').trim();
}

router.post('/:classId/generate', async (req, res) => {
  let streamStarted = false;
  try {
    const cls = await classById(req.params.classId);
    if (!cls) return res.status(404).json({ error: '수업을 찾을 수 없습니다.' });
    const llmSettings = await getLLMSettings();
    const mode = req.body.mode === 'semester' ? 'semester' : 'date';
    const requestedTargets = Array.isArray(req.body.targets) ? req.body.targets : [];
    const targets = mode === 'semester'
      ? requestedTargets.map((item: any) => ({ student_id: Number(item.studentId) }))
      : requestedTargets.length
        ? requestedTargets.map((item: any) => ({ student_id: Number(item.studentId), activity_date_id: Number(item.activityDateId) }))
        : [];
    if (!targets.length) return res.status(400).json({ error: '생성할 활동 기록 셀이 없습니다.' });
    const subjectSettings = await planSettings(cls) || {};
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    streamStarted = true;
    const sendEvent = (event: Record<string, unknown>) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    const controller = new AbortController();
    req.on('aborted', () => controller.abort());
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    let completed = 0;
    for (const target of targets) {
      if (controller.signal.aborted) break;
      const student = await queryOne<any>('SELECT id,student_num,name,personal_num FROM class_students WHERE id=? AND class_id=?', [target.student_id, cls.id]);
      if (!student) continue;
      const activityDateId = mode === 'date' ? Number(target.activity_date_id) : 0;
      const domain = mode === 'semester' ? '__ACTIVITY_SEMESTER__' : String(activityDateId);
      try {
        let parts: string[] = [];
        const attachments: any[] = [];
        if (mode === 'semester') {
          const records = await queryAll<any>(
            `SELECT d.activity_date,d.lesson_no,d.progress,COALESCE(s.summary,'') AS summary,
               COALESCE(o.is_absent,0) AS is_absent,COALESCE(o.note,'') AS observation,
               COALESCE(r.plus_text,'') AS plus_text,COALESCE(r.minus_text,'') AS minus_text,COALESCE(r.interesting_text,'') AS interesting_text
             FROM activity_dates d
             LEFT JOIN activity_summaries s ON s.activity_date_id=d.id AND s.student_id=?
             LEFT JOIN activity_observations o ON o.activity_date_id=d.id AND o.student_id=?
             LEFT JOIN activity_reflections r ON r.activity_date=d.activity_date AND r.student_id=?
             WHERE d.class_id=? AND d.source_mode!='excel_deleted' ORDER BY d.activity_date`,
            [student.id, student.id, student.id, cls.id]
          );
          if (!records.some(row => row.summary || row.observation || row.is_absent || row.plus_text || row.minus_text || row.interesting_text)) throw new Error('종합할 활동 기록이 없습니다.');
          parts = [`[지시]\n${subjectSettings.comprehensive_prompt || '학생의 학기 전체 활동을 구체적 사실 중심으로 간결하게 종합한다. 학생 이름과 평가·점수는 쓰지 않는다.'}`,
            `[학기 활동 기록]\n${records.map(row => `${row.activity_date} ${row.lesson_no}차시 ${row.progress}\n활동: ${row.summary}\n관찰: ${row.is_absent ? '결석' : row.observation}\n성찰: Plus ${row.plus_text} / Minus ${row.minus_text} / Interesting ${row.interesting_text}`).join('\n\n')}`,
            '위 기록을 바탕으로 학기 활동 종합을 작성한다.'];
        } else {
          const date = await queryOne<any>("SELECT * FROM activity_dates WHERE id=? AND class_id=? AND source_mode!='excel_deleted'", [activityDateId, cls.id]);
          if (!date) throw new Error('수업 날짜를 찾을 수 없습니다.');
          let plan: any = await queryOne<any>('SELECT * FROM lesson_plans WHERE year=? AND semester=? AND grade=? AND subject=? AND lesson_no=? ORDER BY sort_order LIMIT 1', [cls.year, cls.semester, cls.grade, cls.subject, date.lesson_no]);
          const excelPath = resolveStoredPath(subjectSettings.source_filepath || subjectSettings.excel_path || '');
          if (!plan && subjectSettings.record_mode === 'excel' && excelPath) {
            const excelPlan = (await WorkbookGateway.open(excelPath)).readPlans().find(item => item.lessonNo === Number(date.lesson_no));
            if (excelPlan) plan = { kind: excelPlan.kind, content: excelPlan.content, prompt: excelPlan.prompt, source_files: excelPlan.sourceFiles };
          }
          const kindPrompt = plan?.kind === '실습' ? subjectSettings.practice_prompt : plan?.kind === '탐구' ? subjectSettings.inquiry_prompt : plan?.kind === '개념' ? subjectSettings.concept_prompt : subjectSettings.other_prompt;
          parts = [subjectSettings.common_prompt || '제출물에 있는 사실만 쓰고 학생 이름과 평가·점수는 쓰지 않는다.', kindPrompt || '', plan?.prompt ? `[차시 추가 요청]\n${plan.prompt}` : '', `[차시]\n${date.lesson_no}차시\n진도: ${date.progress}\n내용: ${plan?.content || ''}`].filter(Boolean);
          const files = await queryAll<any>('SELECT id,filename,filepath,mime_type FROM activity_files WHERE student_id=? AND activity_date_id=? ORDER BY uploaded_at,id', [student.id, activityDateId]);
          const artifacts: ArtifactRow[] = files.map(file => ({ id: file.id, filename: file.filename, filepath: file.filepath, mime_type: file.mime_type }));
          const sourceFiles = String(plan?.source_files || '').split(',').map(value => value.trim()).filter(Boolean);
          for (const [sourceIndex, filename] of sourceFiles.entries()) {
            const filepath = findSourceFile(subjectSettings.source_folder || '', filename);
            if (filepath) artifacts.unshift({ id: -(sourceIndex + 1), filename, filepath, mime_type: mimeType(filename) });
            else parts.push(`[원본 파일 누락]\n${filename}`);
          }
          await appendArtifactContents(parts, artifacts, llmSettings, attachments);
          parts.push('학생 파일 전체를 바탕으로 이번 차시 활동을 요약한다. 다시 제출한 내용이 있으면 달라진 점을 먼저 쓴다.');
        }
        const prompt = sanitizeStudentText(parts.join('\n\n---\n\n'), student);
        const output = await callLLM(prompt, llmSettings, controller.signal, undefined, attachments, llmSettings.temperatures.recordsComments, undefined, {
          type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false,
        }, 'activity');
        const summary = summaryFromResponse(output);
        if (!summary) throw new Error('활동 기록 생성 결과가 비어 있습니다.');
        completed += 1;
        sendEvent({ type: 'progress', studentId: student.id, name: student.name, contentType: 'activity', domain, content: summary, completed, total: targets.length });
      } catch (error) {
        if (controller.signal.aborted) break;
        completed += 1;
        sendEvent({ type: 'error', studentId: student.id, name: student.name, contentType: 'activity', domain, error: error instanceof Error ? error.message : String(error), completed, total: targets.length });
      }
    }
    sendEvent({ type: 'done', completed, total: targets.length });
    res.end();
  } catch (error) {
    if (streamStarted) {
      res.write(`data: ${JSON.stringify({ type: 'fatal', error: error instanceof Error ? error.message : String(error) })}\n\n`);
      res.end();
    } else res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.post('/:classId/batch', async (req, res) => {
  try {
    const cls = await classById(req.params.classId);
    if (!cls) return res.status(404).json({ error: '수업을 찾을 수 없습니다.' });
    const llmSettings = await getLLMSettings();
    if (llmSettings.provider !== 'anthropic') return res.status(400).json({ error: 'Claude 공급자에서만 배치 요청을 사용할 수 있습니다.' });
    const mode = req.body.mode === 'semester' ? 'semester' : 'date';
    const requestedTargets = Array.isArray(req.body.targets) ? req.body.targets : [];
    const targets = mode === 'semester'
      ? requestedTargets.map((item: any) => ({ student_id: Number(item.studentId) }))
      : requestedTargets.length
        ? requestedTargets.map((item: any) => ({ student_id: Number(item.studentId), activity_date_id: Number(item.activityDateId) }))
        : await queryAll<any>(
            `SELECT DISTINCT f.student_id,f.activity_date_id FROM activity_files f
             JOIN class_students cs ON cs.id=f.student_id
             JOIN activity_dates d ON d.id=f.activity_date_id
             LEFT JOIN activity_summaries s ON s.student_id=f.student_id AND s.activity_date_id=f.activity_date_id
             WHERE cs.class_id=? AND d.source_mode!='excel_deleted' AND COALESCE(f.summarized_at,'')='' AND COALESCE(s.manually_edited,0)=0`,
            [cls.id]
          );
    const subjectSettings = await planSettings(cls) || {};
    const requests: AnthropicBatchRequest[] = [];
    const requestMeta: any[] = [];
    for (const [index, target] of targets.entries()) {
      const student = await queryOne<any>('SELECT id,student_num,name,personal_num FROM class_students WHERE id=? AND class_id=?', [target.student_id, cls.id]);
      if (!student) continue;
      let parts: string[] = [];
      let artifacts: ArtifactRow[] = [];
      let fileIds: number[] = [];
      let activityDateId: number | undefined;
      if (mode === 'semester') {
        const records = await queryAll<any>(
          `SELECT d.activity_date,d.lesson_no,d.progress,COALESCE(s.summary,'') AS summary,
             COALESCE(o.is_absent,0) AS is_absent,COALESCE(o.note,'') AS observation,
             COALESCE(r.plus_text,'') AS plus_text,COALESCE(r.minus_text,'') AS minus_text,COALESCE(r.interesting_text,'') AS interesting_text
           FROM activity_dates d
           LEFT JOIN activity_summaries s ON s.activity_date_id=d.id AND s.student_id=?
           LEFT JOIN activity_observations o ON o.activity_date_id=d.id AND o.student_id=?
           LEFT JOIN activity_reflections r ON r.activity_date=d.activity_date AND r.student_id=?
           WHERE d.class_id=? AND d.source_mode!='excel_deleted' ORDER BY d.activity_date`,
          [student.id, student.id, student.id, cls.id]
        );
        if (!records.some(row => row.summary || row.observation || row.is_absent || row.plus_text || row.minus_text || row.interesting_text)) continue;
        parts = [`[지시]\n${subjectSettings.comprehensive_prompt || '학생의 학기 전체 활동 요약, 관찰, 성찰에서 반복되는 관심, 시도, 변화와 구체적 사실을 간결하게 종합한다. 학생 이름과 평가·점수는 쓰지 않는다.'}`,
          `[학기 활동 기록]\n${records.map(row => `${row.activity_date} ${row.lesson_no}차시 ${row.progress}\n활동: ${row.summary}\n관찰: ${row.is_absent ? '결석' : row.observation}\n성찰: Plus ${row.plus_text} / Minus ${row.minus_text} / Interesting ${row.interesting_text}`).join('\n\n')}`];
      } else {
        activityDateId = Number(target.activity_date_id);
        const date = await queryOne<any>("SELECT * FROM activity_dates WHERE id=? AND class_id=? AND source_mode!='excel_deleted'", [activityDateId, cls.id]);
        if (!date) continue;
        let plan: any = await queryOne<any>(
          'SELECT * FROM lesson_plans WHERE year=? AND semester=? AND grade=? AND subject=? AND lesson_no=? ORDER BY sort_order LIMIT 1',
          [cls.year, cls.semester, cls.grade, cls.subject, date.lesson_no]
        );
        const excelPath = resolveStoredPath(subjectSettings.source_filepath || subjectSettings.excel_path || '');
        if (!plan && subjectSettings.record_mode === 'excel' && excelPath) {
          const excelPlan = (await WorkbookGateway.open(excelPath)).readPlans().find(item => item.lessonNo === Number(date.lesson_no));
          if (excelPlan) plan = { kind: excelPlan.kind, content: excelPlan.content, prompt: excelPlan.prompt, source_files: excelPlan.sourceFiles };
        }
        const kindPrompt = plan?.kind === '실습' ? subjectSettings.practice_prompt : plan?.kind === '탐구' ? subjectSettings.inquiry_prompt : plan?.kind === '개념' ? subjectSettings.concept_prompt : subjectSettings.other_prompt;
        parts = [subjectSettings.common_prompt || '제출물에 있는 사실만 쓴다. 학생 이름을 쓰지 않는다. 한국어로 쓴다.', kindPrompt || '', plan?.prompt ? `[차시 추가 요청]\n${plan.prompt}` : '', `[차시]\n${date.lesson_no}차시\n진도: ${date.progress}\n내용: ${plan?.content || ''}`].filter(Boolean);
        const files = await queryAll<any>('SELECT id,filename,filepath,mime_type FROM activity_files WHERE student_id=? AND activity_date_id=? ORDER BY uploaded_at,id', [student.id, activityDateId]);
        fileIds = files.map(file => Number(file.id));
        artifacts = files.map(file => ({ id: file.id, filename: file.filename, filepath: file.filepath, mime_type: file.mime_type }));
        const sourceFiles = String(plan?.source_files || '').split(',').map(value => value.trim()).filter(Boolean);
        for (const [sourceIndex, filename] of sourceFiles.entries()) {
          const filepath = findSourceFile(subjectSettings.source_folder || '', filename);
          if (filepath) artifacts.unshift({ id: -(sourceIndex + 1), filename, filepath, mime_type: mimeType(filename) });
          else parts.push(`[원본 파일 누락]\n${filename}`);
        }
        const attachments: any[] = [];
        await appendArtifactContents(parts, artifacts, llmSettings, attachments);
        (target as any)._attachments = attachments;
      }
      parts.push(mode === 'semester' ? '위 기록을 바탕으로 학기 활동 종합을 작성한다.' : '학생 파일 전체를 바탕으로 이번 차시 활동을 요약한다. 다시 제출한 내용이 있으면 달라진 점을 먼저 쓴다.');
      const prompt = sanitizeStudentText(parts.join('\n\n---\n\n'), student);
      const customId = `activity_${student.id}_${mode}_${activityDateId || 0}_${index}`;
      requests.push({ custom_id: customId, params: buildAnthropicMessageParams(prompt, llmSettings, (target as any)._attachments || [], llmSettings.temperatures.recordsComments, undefined, {
        type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false,
      }, 'activity') });
      requestMeta.push({ customId, studentId: student.id, studentName: student.name, activityDateId, fileIds, mode });
    }
    if (!requests.length) return res.json({ ok: true, batchId: '', status: 'ended', requestCount: 0 });
    const batch = await createAnthropicMessageBatch(llmSettings, requests);
    await execute(
      `INSERT INTO ai_batch_jobs(provider_batch_id,class_id,domain,content_type,status,request_count,metadata,updated_at)
       VALUES(?,?,?,'activity',?,?,?,datetime('now'))`,
      [batch.id, cls.id, mode === 'semester' ? '__ACTIVITY_SEMESTER__' : '__ACTIVITY__', batch.processing_status || 'in_progress', requests.length, JSON.stringify({ requests: requestMeta })]
    );
    res.json({ ok: true, batchId: batch.id, status: batch.processing_status || 'in_progress', requestCount: requests.length });
  } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
});

router.get('/:classId/pending', async (req, res) => {
  res.json(await queryAll<any>(
    `SELECT cs.id AS student_id,cs.student_num,cs.name,d.id AS activity_date_id,d.activity_date,d.lesson_no,d.progress,
       COUNT(f.id) AS pending_file_count,COALESCE(s.manually_edited,0) AS manually_edited
     FROM activity_files f JOIN class_students cs ON cs.id=f.student_id
     JOIN activity_dates d ON d.id=f.activity_date_id
     LEFT JOIN activity_summaries s ON s.student_id=cs.id AND s.activity_date_id=d.id
     WHERE cs.class_id=? AND d.source_mode!='excel_deleted' AND COALESCE(f.summarized_at,'')=''
     GROUP BY cs.id,d.id ORDER BY d.activity_date,cs.student_num`,
    [req.params.classId]
  ));
});

router.get('/:classId/semester-summaries', async (req, res) => {
  res.json(await queryAll<any>(
    `SELECT cs.id AS student_id,COALESCE(s.summary,'') AS summary FROM class_students cs
     LEFT JOIN activity_semester_summaries s ON s.student_id=cs.id WHERE cs.class_id=? ORDER BY cs.student_num`,
    [req.params.classId]
  ));
});

router.get('/files/:id', async (req, res) => {
  const file = await queryOne<{ filename: string; filepath: string; mime_type: string }>('SELECT filename,filepath,mime_type FROM activity_files WHERE id=?', [req.params.id]);
  const filepath = file ? resolveStoredPath(file.filepath) : '';
  if (!file || !fs.existsSync(filepath)) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
  res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
  res.sendFile(path.resolve(filepath));
});

export default router;
