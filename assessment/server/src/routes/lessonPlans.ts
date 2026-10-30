import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';
import ExcelJS from 'exceljs';
import { execute, queryAll, queryOne, transaction } from '../services/db';
import { WorkbookGateway, type JournalClassroom, type LessonPlanRow } from '../services/lessonPlanExcel';
import { decodeUploadFilename } from '../services/filename';
import { ensureDir, moveFileToTrash, resolveStoredPath, toStoredPath, UPLOADS_DIR } from '../services/storage';

const router = Router();
const LESSON_PLAN_UPLOAD_DIR = path.join(UPLOADS_DIR, 'lesson-plans');
ensureDir(LESSON_PLAN_UPLOAD_DIR);
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, LESSON_PLAN_UPLOAD_DIR),
    filename: (_req, file, callback) => callback(null, `${Date.now()}_${decodeUploadFilename(file.originalname)}`),
  }),
});

interface Scope {
  year: number;
  semester: number;
  grade: number;
  subject: string;
}

function scope(req: Request): Scope {
  return {
    year: Number(req.body.year ?? req.query.year),
    semester: Number(req.body.semester ?? req.query.semester),
    grade: Number(req.body.grade ?? req.query.grade),
    subject: String(req.params.subject || req.body.subject || req.query.subject || '').trim(),
  };
}

function validScope(value: Scope): boolean {
  return !!(value.year && value.semester && value.grade && value.subject);
}

const DEFAULTS = {
  record_mode: 'app', excel_path: '', source_folder: '',
  source_filename: '', source_filepath: '',
  common_prompt: '제출물에 있는 사실만 쓴다. 칭찬, 평가, 점수는 쓰지 않는다. 학생 이름을 쓰지 않는다. 한국어로 쓴다.',
  practice_prompt: '원본과 비교해 진행도를 n/m으로 쓴다. 마지막으로 완료한 단계, 결과가 없거나 오류가 있는 단계, 원본에서 바꾼 부분을 쓴다.',
  inquiry_prompt: '질문, 사용한 데이터와 방법, 결과를 2~3문장으로 쓴다. 다시 제출한 경우 달라진 점을 먼저 쓴다.',
  concept_prompt: '1문장으로 쓴다. 제출물이 없으면 "제출물 없음"이라고 쓴다.',
  other_prompt: '1문장으로 쓴다.',
  comprehensive_prompt: '학기 전체의 활동 요약, 관찰, 성찰을 바탕으로 반복되는 관심, 시도, 변화와 구체적인 사실을 간결하게 종합한다. 학생 이름과 평가·점수는 쓰지 않는다.',
  record_chat: '[]', comprehensive_chat: '[]',
};

function safeDownloadName(name: string): string {
  return encodeURIComponent(name).replace(/['()]/g, escape);
}

function workbookCellText(value: ExcelJS.CellValue): string {
  if (value == null) return '';
  if (typeof value === 'object' && 'text' in value) return String(value.text ?? '').trim();
  return String(value).trim();
}

function formatWorkbook(workbook: ExcelJS.Workbook) {
  for (const sheet of workbook.worksheets) {
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.columns.forEach(column => {
      const values = (column.values as unknown[]).filter(value => value != null);
      column.width = Math.max(12, Math.min(60, ...values.map(value => String(value).length + 3)));
      column.alignment = { vertical: 'top', wrapText: true };
    });
  }
}

async function readSettings(value: Scope) {
  const row = await queryOne<any>(
    'SELECT * FROM subject_plan_settings WHERE year=? AND semester=? AND grade=? AND subject=?',
    [value.year, value.semester, value.grade, value.subject]
  );
  return { ...DEFAULTS, ...row, ...value };
}

async function readPlanRows(value: Scope, providedSettings?: any): Promise<LessonPlanRow[]> {
  const settings = providedSettings ?? await readSettings(value);
  if (settings.record_mode === 'excel') {
    const filepath = resolveStoredPath(settings.source_filepath || settings.excel_path || '');
    if (!filepath || !fs.existsSync(filepath)) throw new Error('연결한 일지 엑셀 파일을 찾을 수 없습니다.');
    return (await WorkbookGateway.open(filepath)).readPlans();
  }
  const stored = await queryAll<any>(
    `SELECT id,lesson_no,progress,content,memo,kind,source_files,prompt
     FROM lesson_plans WHERE year=? AND semester=? AND grade=? AND subject=? ORDER BY sort_order,id`,
    [value.year, value.semester, value.grade, value.subject]
  );
  return stored.map(row => ({ id: row.id, lessonNo: row.lesson_no, progress: row.progress, content: row.content,
    memo: row.memo, kind: row.kind, sourceFiles: row.source_files, prompt: row.prompt }));
}

function addPlanSheet(workbook: ExcelJS.Workbook, rows: LessonPlanRow[]) {
  const plans = workbook.addWorksheet('진도');
  plans.addRow(['차시', '진도', '내용', '메모', '종류', '산출물', '프롬프트']);
  rows.forEach(row => plans.addRow([row.lessonNo, row.progress, row.content, row.memo, row.kind, row.sourceFiles, row.prompt]));
  return plans;
}

router.get('/subjects', async (_req, res) => {
  const subjects = await queryAll<any>(`
    SELECT source.year,source.semester,source.grade,source.subject,
      CASE WHEN COALESCE(settings.source_filename,'') != '' OR COALESCE(settings.source_filepath,'') != ''
        OR COALESCE(settings.excel_path,'') != '' THEN 1 ELSE 0 END AS has_source
    FROM (
      SELECT year,semester,grade,subject FROM subject_domains
      UNION
      SELECT year,semester,grade,subject FROM custom_domains
    ) source
    LEFT JOIN subject_plan_settings settings
      ON settings.year=source.year AND settings.semester=source.semester
      AND settings.grade=source.grade AND settings.subject=source.subject
    GROUP BY source.year,source.semester,source.grade,source.subject
    ORDER BY source.year DESC,source.semester,source.grade,source.subject
  `);
  res.json(subjects);
});

router.put('/source-file', async (req, res) => {
  const value = scope(req);
  const filepath = path.resolve(String(req.body.filepath || ''));
  if (!validScope(value) || !req.body.filepath) return res.status(400).json({ error: '과목과 일지 엑셀 파일 경로가 필요합니다.' });
  if (!fs.existsSync(filepath) || !fs.statSync(filepath).isFile()) return res.status(400).json({ error: '선택한 일지 엑셀 파일을 찾을 수 없습니다.' });
  try {
    await WorkbookGateway.open(filepath).then(reader => reader.readPlans());
    const current = await readSettings(value);
    if (current.source_filepath) moveFileToTrash(current.source_filepath, 'lesson-plans');
    await execute(
      `INSERT INTO subject_plan_settings(year,semester,grade,subject,record_mode,source_filename,source_filepath,excel_path,updated_at)
       VALUES(?,?,?,?,'excel',?,?,?,datetime('now'))
       ON CONFLICT(year,semester,grade,subject) DO UPDATE SET
         record_mode='excel',source_filename=excluded.source_filename,
         source_filepath='',excel_path=excluded.excel_path,updated_at=datetime('now')`,
      [value.year, value.semester, value.grade, value.subject, path.basename(filepath), '', filepath]
    );
    res.json({ ok: true, ...value, filename: path.basename(filepath), filepath });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.post('/source-file', upload.single('file'), async (req, res) => {
  const value = scope(req);
  const filepath = req.file?.path || '';
  if (!validScope(value) || !req.file) {
    if (filepath && fs.existsSync(filepath)) fs.unlinkSync(filepath);
    return res.status(400).json({ error: '과목과 일지 엑셀 파일이 필요합니다.' });
  }
  try {
    await WorkbookGateway.open(filepath).then(reader => reader.readPlans());
    const current = await readSettings(value);
    if (current.source_filepath) moveFileToTrash(current.source_filepath, 'lesson-plans');
    await execute(
      `INSERT INTO subject_plan_settings(year,semester,grade,subject,record_mode,source_filename,source_filepath,excel_path,updated_at)
       VALUES(?,?,?,?,'excel',?,?,?,datetime('now'))
       ON CONFLICT(year,semester,grade,subject) DO UPDATE SET
         record_mode='excel',source_filename=excluded.source_filename,
         source_filepath=excluded.source_filepath,excel_path='',updated_at=datetime('now')`,
      [value.year, value.semester, value.grade, value.subject, decodeUploadFilename(req.file.originalname), toStoredPath(filepath), '']
    );
    res.json({ ok: true, ...value, filename: decodeUploadFilename(req.file.originalname) });
  } catch (error) {
    if (filepath && fs.existsSync(filepath)) fs.unlinkSync(filepath);
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.get('/source-file', async (req, res) => {
  const value = scope(req);
  const settings = await readSettings(value);
  const filepath = resolveStoredPath(settings.source_filepath || settings.excel_path || '');
  if (!filepath || !fs.existsSync(filepath)) return res.status(404).json({ error: '업로드한 일지 엑셀 파일을 찾을 수 없습니다.' });
  const filename = settings.source_filename || path.basename(filepath).replace(/^\d+_/, '');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${safeDownloadName(filename)}`);
  res.sendFile(filepath);
});

router.delete('/source-file', async (req, res) => {
  const value = scope(req);
  if (!validScope(value)) return res.status(400).json({ error: '과목 정보가 필요합니다.' });
  const settings = await readSettings(value);
  if (settings.source_filepath) moveFileToTrash(settings.source_filepath, 'lesson-plans');
  await execute(
    `UPDATE subject_plan_settings
     SET record_mode='app',source_filename='',source_filepath='',excel_path='',updated_at=datetime('now')
     WHERE year=? AND semester=? AND grade=? AND subject=?`,
    [value.year, value.semester, value.grade, value.subject]
  );
  res.json({ ok: true });
});

router.get('/settings/:subject', async (req, res) => {
  const value = scope(req);
  if (!validScope(value)) return res.status(400).json({ error: '학년도, 학기, 학년, 과목이 필요합니다.' });
  res.json(await readSettings(value));
});

router.put('/settings/:subject', async (req, res) => {
  const value = scope(req);
  if (!validScope(value)) return res.status(400).json({ error: '학년도, 학기, 학년, 과목이 필요합니다.' });
  const current = await readSettings(value);
  const mode = current.source_filename || current.source_filepath || current.excel_path ? 'excel' : 'app';
  const next = { ...DEFAULTS, ...req.body, record_mode: mode };
  await execute(
    `INSERT INTO subject_plan_settings(
       year,semester,grade,subject,record_mode,excel_path,source_folder,common_prompt,
       practice_prompt,inquiry_prompt,concept_prompt,other_prompt,comprehensive_prompt,record_chat,comprehensive_chat,updated_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
     ON CONFLICT(year,semester,grade,subject) DO UPDATE SET
       record_mode=excluded.record_mode,
       source_folder=excluded.source_folder, common_prompt=excluded.common_prompt,
       practice_prompt=excluded.practice_prompt, inquiry_prompt=excluded.inquiry_prompt,
       concept_prompt=excluded.concept_prompt, other_prompt=excluded.other_prompt,
       comprehensive_prompt=excluded.comprehensive_prompt, record_chat=excluded.record_chat,
       comprehensive_chat=excluded.comprehensive_chat,
       updated_at=datetime('now')`,
    [value.year, value.semester, value.grade, value.subject, mode, String(next.excel_path || ''),
      String(next.source_folder || ''), String(next.common_prompt || ''), String(next.practice_prompt || ''),
      String(next.inquiry_prompt || ''), String(next.concept_prompt || ''), String(next.other_prompt || ''),
      String(next.comprehensive_prompt || ''), String(next.record_chat || '[]'), String(next.comprehensive_chat || '[]')]
  );
  res.json(await readSettings(value));
});

function missingSourceFiles(rows: LessonPlanRow[], sourceFolder: string): string[] {
  if (!sourceFolder || !fs.existsSync(sourceFolder)) return [];
  const names = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else names.add(entry.name.normalize('NFC'));
    }
  };
  walk(sourceFolder);
  return [...new Set(rows.flatMap(row => row.sourceFiles.split(',').map(v => v.trim()).filter(Boolean)))]
    .filter(name => !names.has(path.basename(name).normalize('NFC')));
}

async function artifactSourceFolderState(value: Scope) {
  const settings = await readSettings(value);
  const sourceFolder = String(settings.source_folder || '');
  const rows = await readPlanRows(value, settings);
  return {
    sourceFolder,
    exists: !!sourceFolder && fs.existsSync(sourceFolder) && fs.statSync(sourceFolder).isDirectory(),
    missingSourceFiles: missingSourceFiles(rows, sourceFolder),
  };
}

router.get('/artifact-source-folder/:subject', async (req, res) => {
  const value = scope(req);
  if (!validScope(value)) return res.status(400).json({ error: '학년도, 학기, 학년, 과목이 필요합니다.' });
  try {
    res.json(await artifactSourceFolderState(value));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.put('/artifact-source-folder/:subject', async (req, res) => {
  const value = scope(req);
  const folderPath = path.resolve(String(req.body.folderPath || ''));
  if (!validScope(value) || !req.body.folderPath) return res.status(400).json({ error: '과목과 산출물 원본 폴더 경로가 필요합니다.' });
  if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) return res.status(400).json({ error: '선택한 산출물 원본 폴더를 찾을 수 없습니다.' });
  const current = await readSettings(value);
  await execute(
    `INSERT INTO subject_plan_settings(year,semester,grade,subject,record_mode,source_folder,updated_at)
     VALUES(?,?,?,?,?,?,datetime('now'))
     ON CONFLICT(year,semester,grade,subject) DO UPDATE SET
       source_folder=excluded.source_folder,updated_at=datetime('now')`,
    [value.year, value.semester, value.grade, value.subject, current.record_mode || 'app', folderPath]
  );
  res.json(await artifactSourceFolderState(value));
});

router.delete('/artifact-source-folder/:subject', async (req, res) => {
  const value = scope(req);
  if (!validScope(value)) return res.status(400).json({ error: '학년도, 학기, 학년, 과목이 필요합니다.' });
  await execute(
    `UPDATE subject_plan_settings SET source_folder='',updated_at=datetime('now')
     WHERE year=? AND semester=? AND grade=? AND subject=?`,
    [value.year, value.semester, value.grade, value.subject]
  );
  res.json({ sourceFolder: '', exists: false, missingSourceFiles: [] });
});

router.get('/plans/:subject', async (req, res) => {
  const value = scope(req);
  if (!validScope(value)) return res.status(400).json({ error: '학년도, 학기, 학년, 과목이 필요합니다.' });
  const settings = await readSettings(value);
  let rows: LessonPlanRow[];
  if (settings.record_mode === 'excel') {
    const filepath = resolveStoredPath(settings.source_filepath || settings.excel_path || '');
    if (!filepath || !fs.existsSync(filepath)) return res.status(400).json({ error: '업로드한 일지 엑셀 파일을 찾을 수 없습니다.' });
    rows = (await WorkbookGateway.open(filepath)).readPlans();
  } else {
    const stored = await queryAll<any>(
      `SELECT id, lesson_no, progress, content, memo, kind, source_files, prompt
       FROM lesson_plans WHERE year=? AND semester=? AND grade=? AND subject=? ORDER BY sort_order,id`,
      [value.year, value.semester, value.grade, value.subject]
    );
    rows = stored.map(row => ({ id: row.id, lessonNo: row.lesson_no, progress: row.progress, content: row.content,
      memo: row.memo, kind: row.kind, sourceFiles: row.source_files, prompt: row.prompt }));
  }
  res.json({ settings, rows, missingSourceFiles: missingSourceFiles(rows, settings.source_folder) });
});

router.put('/plans/:subject', async (req, res) => {
  const value = scope(req);
  if (!validScope(value) || !Array.isArray(req.body.rows)) return res.status(400).json({ error: '저장할 계획이 필요합니다.' });
  const settings = await readSettings(value);
  if (settings.record_mode !== 'app') return res.status(400).json({ error: '엑셀 모드에서는 앱에서 계획을 수정할 수 없습니다.' });
  const rows = req.body.rows as any[];
  await transaction(async () => {
    await execute('DELETE FROM lesson_plans WHERE year=? AND semester=? AND grade=? AND subject=?', [value.year, value.semester, value.grade, value.subject]);
    for (const [index, row] of rows.entries()) {
      const kind = ['개념', '실습', '탐구', '기타'].includes(row.kind) ? row.kind : '기타';
      await execute(
        `INSERT INTO lesson_plans(id,year,semester,grade,subject,lesson_no,progress,content,memo,kind,source_files,prompt,sort_order,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`,
        [String(row.id || crypto.randomUUID()), value.year, value.semester, value.grade, value.subject,
          Math.max(1, Math.trunc(Number(row.lessonNo || 1))), String(row.progress || ''), String(row.content || ''), String(row.memo || ''),
          kind, String(row.sourceFiles || ''), String(row.prompt || ''), index]
      );
    }
  });
  res.json({ ok: true });
});

router.get('/export/plan', async (req, res) => {
  const value = scope(req);
  if (!validScope(value)) return res.status(400).json({ error: '과목 정보가 필요합니다.' });
  try {
    const buffer = await WorkbookGateway.createPlan(await readPlanRows(value)).writeBuffer();
    const filename = `${value.year} ${value.grade}학년 ${value.subject} 진도.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${safeDownloadName(filename)}`);
    res.send(Buffer.from(buffer));
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
});

router.get('/export/journal', async (req, res) => {
  const value = scope(req);
  if (!validScope(value)) return res.status(400).json({ error: '과목 정보가 필요합니다.' });
  try {
    const settings = await readSettings(value);
    const filename = `${value.year} ${value.grade}학년 ${value.subject} 일지.xlsx`;
    const linkedPath = resolveStoredPath(settings.source_filepath || settings.excel_path || '');
    if (settings.record_mode === 'excel' && linkedPath && fs.existsSync(linkedPath)) {
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${safeDownloadName(filename)}`);
      return res.sendFile(path.resolve(linkedPath));
    }

    const planRows = await readPlanRows(value, settings);
    const classes = await queryAll<any>(
      'SELECT id,room FROM classes WHERE year=? AND semester=? AND grade=? AND subject=? ORDER BY room,id',
      [value.year, value.semester, value.grade, value.subject]
    );
    const classrooms: JournalClassroom[] = [];
    for (const cls of classes) {
      const students = await queryAll<any>('SELECT id,student_num,name FROM class_students WHERE class_id=? ORDER BY student_num,id', [cls.id]);
      const dates = await queryAll<any>("SELECT * FROM activity_dates WHERE class_id=? AND source_mode!='excel_deleted' ORDER BY activity_date,id", [cls.id]);
      const journalDates: JournalClassroom['dates'] = [];
      for (const date of dates) {
        const observations = await queryAll<any>('SELECT student_id,is_absent,note FROM activity_observations WHERE activity_date_id=?', [date.id]);
        journalDates.push({
          date: String(date.activity_date), lessonNo: Number(date.lesson_no), progress: String(date.progress || ''), journal: String(date.journal || ''),
          observations: new Map(observations.map(item => [Number(item.student_id), { isAbsent: !!item.is_absent, note: String(item.note || '') }])),
        });
      }
      classrooms.push({
        room: String(cls.room),
        students: students.map(student => ({
          id: Number(student.id), classNum: Math.floor((Number(student.student_num) % 10000) / 100),
          seatNum: Number(student.student_num) % 100, name: String(student.name),
        })),
        dates: journalDates,
      });
    }
    const buffer = await WorkbookGateway.createJournal(planRows, classrooms).writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${safeDownloadName(filename)}`);
    res.send(Buffer.from(buffer));
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
});

router.get('/backup/export', async (req, res) => {
  const value = scope(req);
  if (!validScope(value)) return res.status(400).json({ error: '과목 정보가 필요합니다.' });
  const settings = await readSettings(value);
  let rows: LessonPlanRow[] = [];
  if (settings.record_mode === 'excel') {
    const filepath = resolveStoredPath(settings.source_filepath || settings.excel_path || '');
    if (filepath && fs.existsSync(filepath)) rows = (await WorkbookGateway.open(filepath)).readPlans();
  } else {
    const stored = await queryAll<any>(
      `SELECT id,lesson_no,progress,content,memo,kind,source_files,prompt
       FROM lesson_plans WHERE year=? AND semester=? AND grade=? AND subject=? ORDER BY sort_order,id`,
      [value.year, value.semester, value.grade, value.subject]
    );
    rows = stored.map(row => ({ id: row.id, lessonNo: row.lesson_no, progress: row.progress, content: row.content,
      memo: row.memo, kind: row.kind, sourceFiles: row.source_files, prompt: row.prompt }));
  }

  const workbook = new ExcelJS.Workbook();
  const info = workbook.addWorksheet('기본정보');
  info.addRow(['학년도', '학기', '학년', '과목']);
  info.addRow([value.year, value.semester, value.grade, value.subject]);
  const plans = workbook.addWorksheet('차시계획');
  plans.addRow(['ID', '차시', '진도', '내용', '메모', '종류', '산출물', '프롬프트']);
  rows.forEach(row => plans.addRow([row.id, row.lessonNo, row.progress, row.content, row.memo, row.kind, row.sourceFiles, row.prompt]));
  const records = workbook.addWorksheet('기록기준');
  records.addRow(['구분', '기준']);
  records.addRows([
    ['공통', settings.common_prompt], ['실습', settings.practice_prompt], ['탐구', settings.inquiry_prompt],
    ['개념', settings.concept_prompt], ['기타', settings.other_prompt],
  ]);
  const comprehensive = workbook.addWorksheet('종합기준');
  comprehensive.addRow(['구분', '기준']);
  comprehensive.addRow(['공통', settings.comprehensive_prompt]);
  formatWorkbook(workbook);
  const buffer = await workbook.xlsx.writeBuffer();
  const filename = `${value.year}_${value.semester}학기_${value.grade}학년_${value.subject}_수업계획_백업.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${safeDownloadName(filename)}`);
  res.send(Buffer.from(buffer));
});

router.post('/backup/upload', upload.single('file'), async (req, res) => {
  const value = scope(req);
  const filepath = req.file?.path || '';
  if (!validScope(value) || !req.file) {
    if (filepath && fs.existsSync(filepath)) fs.unlinkSync(filepath);
    return res.status(400).json({ error: '과목과 백업 파일이 필요합니다.' });
  }
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filepath);
    const planSheet = workbook.getWorksheet('차시계획');
    const recordSheet = workbook.getWorksheet('기록기준');
    const comprehensiveSheet = workbook.getWorksheet('종합기준');
    if (!planSheet || !recordSheet || !comprehensiveSheet) throw new Error('수업 계획 백업 파일 형식이 아닙니다.');

    const plans: LessonPlanRow[] = [];
    for (let rowNumber = 2; rowNumber <= planSheet.rowCount; rowNumber += 1) {
      const row = planSheet.getRow(rowNumber);
      const lessonNo = Math.trunc(Number(row.getCell(2).value || 0));
      if (!lessonNo) continue;
      const kindValue = workbookCellText(row.getCell(6).value);
      plans.push({
        id: workbookCellText(row.getCell(1).value) || crypto.randomUUID(),
        lessonNo,
        progress: workbookCellText(row.getCell(3).value), content: workbookCellText(row.getCell(4).value),
        memo: workbookCellText(row.getCell(5).value),
        kind: ['개념', '실습', '탐구', '기타'].includes(kindValue) ? kindValue as LessonPlanRow['kind'] : '기타',
        sourceFiles: workbookCellText(row.getCell(7).value), prompt: workbookCellText(row.getCell(8).value),
      });
    }
    const prompts: Record<string, string> = {};
    for (let rowNumber = 2; rowNumber <= recordSheet.rowCount; rowNumber += 1) {
      prompts[workbookCellText(recordSheet.getCell(rowNumber, 1).value)] = workbookCellText(recordSheet.getCell(rowNumber, 2).value);
    }
    const comprehensivePrompt = workbookCellText(comprehensiveSheet.getCell(2, 2).value);
    const current = await readSettings(value);
    await transaction(async () => {
      await execute(
        `INSERT INTO subject_plan_settings(year,semester,grade,subject,record_mode,common_prompt,practice_prompt,inquiry_prompt,concept_prompt,other_prompt,comprehensive_prompt,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
         ON CONFLICT(year,semester,grade,subject) DO UPDATE SET
           common_prompt=excluded.common_prompt,practice_prompt=excluded.practice_prompt,
           inquiry_prompt=excluded.inquiry_prompt,concept_prompt=excluded.concept_prompt,
           other_prompt=excluded.other_prompt,comprehensive_prompt=excluded.comprehensive_prompt,updated_at=datetime('now')`,
        [value.year, value.semester, value.grade, value.subject, current.record_mode,
          prompts['공통'] ?? current.common_prompt, prompts['실습'] ?? current.practice_prompt,
          prompts['탐구'] ?? current.inquiry_prompt, prompts['개념'] ?? current.concept_prompt,
          prompts['기타'] ?? current.other_prompt, comprehensivePrompt || current.comprehensive_prompt]
      );
      if (current.record_mode !== 'excel') {
        await execute('DELETE FROM lesson_plans WHERE year=? AND semester=? AND grade=? AND subject=?', [value.year, value.semester, value.grade, value.subject]);
        for (const [index, row] of plans.entries()) {
          await execute(
            `INSERT INTO lesson_plans(id,year,semester,grade,subject,lesson_no,progress,content,memo,kind,source_files,prompt,sort_order,updated_at)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`,
            [row.id, value.year, value.semester, value.grade, value.subject, row.lessonNo, row.progress, row.content,
              row.memo, row.kind, row.sourceFiles, row.prompt, index]
          );
        }
      }
    });
    res.json({ ok: true, importedPlans: current.record_mode === 'excel' ? 0 : plans.length });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    if (filepath && fs.existsSync(filepath)) fs.unlinkSync(filepath);
  }
});

export default router;
