import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import ExcelJS from 'exceljs';
import { queryAll, queryOne, execute, transaction } from '../services/db';
import { UPLOADS_DIR, ensureDir, resolveStoredPath } from '../services/storage';
import { parseScoringExcel, parseStudentExcel, exportToExcel, writeScoringToExcel, writeCommentsToExcel } from '../services/excel';
import { decodeUploadFilename } from '../services/filename';

const UPLOAD_DIR = path.join(UPLOADS_DIR, 'records');
ensureDir(UPLOAD_DIR);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => cb(null, `excel_${Date.now()}_${decodeUploadFilename(file.originalname)}`),
});
const upload = multer({ storage });

const router = Router();

function cellText(value: ExcelJS.CellValue): string {
  if (value == null) return '';
  if (typeof value === 'object' && 'text' in value) return String(value.text ?? '').trim();
  return String(value).trim();
}

function headerMap(row: ExcelJS.Row): Record<string, number> {
  const map: Record<string, number> = {};
  row.eachCell((cell, col) => { map[cellText(cell.value)] = col; });
  return map;
}

function parseGeneratedContentValue(contentType: string, content: string): Array<{ item: string; value: string }> {
  try {
    const parsed = JSON.parse(content || '{}');
    return Object.entries(parsed)
      .filter(([item]) => !item.startsWith('__'))
      .map(([item, value]) => ({ item, value: String(value ?? '') }));
  } catch {
    return [{ item: contentType === 'comments' ? 'text' : 'raw', value: content || '' }];
  }
}

router.get('/students/:studentId/content', async (req: Request, res: Response) => {
  const content = await queryAll(
    'SELECT * FROM generated_content WHERE student_id=?',
    [req.params.studentId]
  );
  res.json(content);
});

router.get('/classes/:classId/content', async (req: Request, res: Response) => {
  const { domain } = req.query;
  let sql = `
    SELECT gc.* 
    FROM generated_content gc
    JOIN class_students cs ON gc.student_id = cs.id
    WHERE cs.class_id = ?
  `;
  const args: any[] = [req.params.classId];
  if (domain) {
    sql += ' AND gc.domain = ?';
    args.push(domain);
  }
  const content = await queryAll(sql, args);
  res.json(content);
});

router.get('/classes/:classId/written-exams', async (req: Request, res: Response) => {
  const classId = Number(req.params.classId);
  const cls = await queryOne<{ year: number; semester: number; grade: number; subject: string }>(
    'SELECT year, semester, grade, subject FROM classes WHERE id=?',
    [classId]
  );
  if (!cls) return res.status(404).json({ error: '수업을 찾을 수 없습니다.' });

  const exams = await queryAll<{
    domain_name: string; max_score: number; ratio: number; sort_order: number;
    file_id: number | null; filename: string | null; uploaded_at: string | null;
  }>(
    `SELECT sd.name AS domain_name,
            sd.max_score AS max_score,
            sd.ratio AS ratio,
            sd.sort_order AS sort_order,
            wf.id AS file_id,
            wf.filename AS filename,
            wf.uploaded_at AS uploaded_at
     FROM subject_domains sd
     LEFT JOIN written_exam_files wf
       ON wf.class_id=? AND wf.domain_name=sd.name
     WHERE sd.year=? AND sd.semester=? AND sd.grade=? AND sd.subject=? AND sd.eval_type='지필'
     ORDER BY sd.sort_order, sd.id`,
    [classId, cls.year, cls.semester, cls.grade, cls.subject]
  );

  const scores = await queryAll<{ student_id: number; domain_name: string; score: string; source_file_id: number | null }>(
    `SELECT student_id, domain_name, score, source_file_id
     FROM written_exam_scores
     WHERE class_id=?`,
    [classId]
  );
  res.json({ exams, scores });
});

router.put('/students/:studentId/content', async (req: Request, res: Response) => {
  const { content_type, domain, content } = req.body as { content_type: string; domain: string; content: string };
  await execute(`
    INSERT INTO generated_content(student_id, content_type, domain, content, updated_at)
    VALUES(?,?,?,?,datetime('now'))
    ON CONFLICT(student_id, content_type, domain)
    DO UPDATE SET content=excluded.content, updated_at=excluded.updated_at
  `, [req.params.studentId, content_type, domain, content]);
  res.json({ ok: true });
});

router.put('/classes/:classId/written-scores', async (req: Request, res: Response) => {
  const classId = Number(req.params.classId);
  const items = Array.isArray(req.body?.items) ? req.body.items as Array<{ student_id: number; domain_name: string; score: string }> : [];
  const lockedRows = await queryAll<{ student_id: number; domain_name: string }>(
    `SELECT student_id, domain_name
     FROM written_exam_scores
     WHERE class_id=? AND source_file_id IS NOT NULL`,
    [classId]
  );
  const locked = new Set(lockedRows.map(row => `${row.student_id}::${row.domain_name}`));

  await transaction(async () => {
    for (const item of items) {
      const studentId = Number(item.student_id);
      const domainName = String(item.domain_name || '').trim();
      if (!studentId || !domainName || locked.has(`${studentId}::${domainName}`)) continue;
      await execute(
        `INSERT INTO written_exam_scores(class_id, student_id, domain_name, score, source_file_id, updated_at)
         VALUES(?,?,?,?,NULL,datetime('now'))
         ON CONFLICT(class_id, student_id, domain_name)
         DO UPDATE SET score=excluded.score, source_file_id=NULL, updated_at=excluded.updated_at`,
        [classId, studentId, domainName, String(item.score ?? '')]
      );
    }
  });
  res.json({ ok: true, saved: items.length });
});

router.get('/export/:classId', async (req: Request, res: Response) => {
  const classId = req.params.classId;
  const type = (req.query.type as string) || 'comments';

  const cls = await queryOne<{
    year: number; semester: number; grade: number; subject: string; room: string;
    scoring_filename: string; scoring_filepath: string;
    comments_filename: string; comments_filepath: string; filename: string;
  }>('SELECT * FROM classes WHERE id=?', [classId]);
  if (!cls) return res.status(404).json({ error: '수업을 찾을 수 없습니다.' });

  const students = await queryAll<{
    id: number; student_num: number; name: string; excel_row: number; personal_num: string;
  }>('SELECT * FROM class_students WHERE class_id=? ORDER BY student_num', [classId]);
  if (!students.length) return res.status(400).json({ error: '학생 데이터가 없습니다.' });

  try {
    let buffer: Buffer;
    let downloadName: string;

    if (type === 'scoring') {
      // ── 채점 파일에 영역별 합계 점수 기록 ─────────────────────────────
      const scoringFilepath = resolveStoredPath(cls.scoring_filepath);
      if (!cls.scoring_filepath || !fs.existsSync(scoringFilepath)) {
        return res.status(400).json({ error: '채점 원본 파일이 없습니다. 파일을 먼저 업로드해주세요.' });
      }

      const domains = await queryAll<{ name: string; excel_col: string }>(
        'SELECT name, excel_col FROM assessment_domains WHERE class_id=? ORDER BY sort_order',
        [classId]
      );
      const parsedScoring = await parseScoringExcel(scoringFilepath);
      const scoringRowByStudentNum = new Map(
        parsedScoring.students.map(student => [cls.grade * 10000 + student.studentNum, student.excelRow])
      );

      const entries: { excelRow: number; excelCol: string; score: number | null }[] = [];
      for (const s of students) {
        const excelRow = scoringRowByStudentNum.get(s.student_num) ?? s.excel_row;
        for (const d of domains) {
          if (!d.excel_col) continue;
          const row = await queryOne<{ content: string }>(
            `SELECT content FROM generated_content WHERE student_id=? AND content_type='scoring' AND domain=?`,
            [s.id, d.name]
          );
          let score: number | null = null;
          if (row?.content) {
            try {
              const parsed = JSON.parse(row.content);
              score = parsed.total != null ? Number(parsed.total) : null;
            } catch { /* ignore */ }
          }
          entries.push({ excelRow, excelCol: d.excel_col, score });
        }
      }

      buffer = await writeScoringToExcel(scoringFilepath, entries);
      downloadName = cls.scoring_filename || cls.filename;

    } else {
      // ── 세특 파일에 종합 세특 기록 ────────────────────────────────────
      const commentsFilepath = resolveStoredPath(cls.comments_filepath);
      if (!cls.comments_filepath || !fs.existsSync(commentsFilepath)) {
        return res.status(400).json({ error: '세특 원본 파일이 없습니다. 파일을 먼저 업로드해주세요.' });
      }

      const entries: { personalNum: string; commentsText: string }[] = [];
      for (const s of students) {
        if (!s.personal_num) continue;
        const row = await queryOne<{ content: string }>(
          `SELECT content FROM generated_content WHERE student_id=? AND content_type='comments' AND domain='__SUBJECT_COMPREHENSIVE__'`,
          [s.id]
        );
        let text = '';
        if (row?.content) {
          try {
            const parsed = JSON.parse(row.content);
            text = parsed.text || '';
          } catch { text = row.content; }
        }
        if (text) entries.push({ personalNum: s.personal_num, commentsText: text });
      }

      buffer = await writeCommentsToExcel(commentsFilepath, entries);
      downloadName = cls.comments_filename;
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`);
    res.send(buffer);
  } catch (e: unknown) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

router.get('/export-full/:classId', async (req: Request, res: Response) => {
  const classId = Number(req.params.classId);
  const cls = await queryOne<{ year: number; semester: number; grade: number; subject: string; room: string }>(
    'SELECT year, semester, grade, subject, room FROM classes WHERE id=?',
    [classId]
  );
  if (!cls) return res.status(404).json({ error: '수업을 찾을 수 없습니다.' });

  const students = await queryAll<{ id: number; student_num: number; name: string }>(
    'SELECT id, student_num, name FROM class_students WHERE class_id=? ORDER BY student_num',
    [classId]
  );
  const rows = await queryAll<{ student_id: number; student_num: number; name: string; content_type: string; domain: string; content: string; updated_at: string }>(
    `SELECT gc.student_id, cs.student_num, cs.name, gc.content_type, gc.domain, gc.content, gc.updated_at
     FROM generated_content gc
     JOIN class_students cs ON cs.id = gc.student_id
     WHERE cs.class_id=?
     ORDER BY cs.student_num, gc.content_type, gc.domain`,
    [classId]
  );

  const wb = new ExcelJS.Workbook();
  const meta = wb.addWorksheet('기본정보');
  meta.addRows([
    ['class_id', classId],
    ['학년도', cls.year],
    ['학기', cls.semester],
    ['학년', cls.grade],
    ['과목', cls.subject],
    ['강의실', cls.room],
  ]);

  const studentsSheet = wb.addWorksheet('학생');
  studentsSheet.addRow(['student_num', 'name']);
  students.forEach(student => studentsSheet.addRow([student.student_num, student.name]));

  const contentSheet = wb.addWorksheet('내용');
  contentSheet.addRow(['student_num', 'name', 'content_type', 'domain', 'item', 'value', 'updated_at']);
  for (const row of rows) {
    for (const parsed of parseGeneratedContentValue(row.content_type, row.content)) {
      contentSheet.addRow([row.student_num, row.name, row.content_type, row.domain, parsed.item, parsed.value, row.updated_at]);
    }
  }

  for (const sheet of wb.worksheets) {
    sheet.getRow(1).font = { bold: true };
    sheet.columns.forEach(col => {
      col.width = Math.max(12, Math.min(60, Math.max(...(col.values || []).map(v => String(v || '').length + 4))));
      col.alignment = { vertical: 'top', wrapText: true };
    });
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
  }

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  const filename = `전체기록_${cls.year}_${cls.semester}_${cls.grade}_${cls.subject}_${cls.room}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.send(buffer);
});

router.post('/import-full', upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(req.file.path);

    const metaSheet = wb.getWorksheet('기본정보');
    const meta: Record<string, string> = {};
    if (metaSheet) {
      metaSheet.eachRow((row) => {
        const key = cellText(row.getCell(1).value);
        if (key) meta[key] = cellText(row.getCell(2).value);
      });
    }

    const year = Number(meta['학년도']);
    const semester = Number(meta['학기']);
    const grade = Number(meta['학년']);
    const subject = String(meta['과목'] || '').trim();
    const room = String(meta['강의실'] || '').trim();
    if (!year || !semester || !grade || !subject || !room) {
      return res.status(400).json({ error: '기본정보 시트에서 학년도, 학기, 학년, 과목, 강의실을 찾을 수 없습니다.' });
    }

    const studentsSheet = wb.getWorksheet('학생');
    if (!studentsSheet) return res.status(400).json({ error: '"학생" 시트를 찾을 수 없습니다.' });
    const studentHeader = headerMap(studentsSheet.getRow(1));
    const studentRows: { student_num: number; name: string }[] = [];
    studentsSheet.eachRow((row, rowNum) => {
      if (rowNum === 1) return;
      const studentNum = Number(cellText(row.getCell(studentHeader.student_num).value));
      const name = cellText(row.getCell(studentHeader.name).value);
      if (!studentNum || !name) return;
      studentRows.push({ student_num: studentNum, name });
    });

    let cls = await queryOne<{ id: number }>(
      'SELECT id FROM classes WHERE year=? AND semester=? AND grade=? AND subject=? AND room=? ORDER BY id DESC LIMIT 1',
      [year, semester, grade, subject, room]
    );
    if (!cls) {
      const r = await execute(
        'INSERT INTO classes(year, semester, grade, subject, room) VALUES(?,?,?,?,?)',
        [year, semester, grade, subject, room]
      );
      cls = { id: Number(r.lastInsertRowid) };
    }

    for (const student of studentRows) {
      const existing = await queryOne(
        'SELECT 1 FROM class_students WHERE class_id=? AND student_num=? LIMIT 1',
        [cls.id, student.student_num]
      );
      if (!existing) {
        await execute(
          'INSERT INTO class_students(class_id, student_num, name, excel_row) VALUES(?,?,?,?)',
          [cls.id, student.student_num, student.name, student.student_num]
        );
      }
    }

    req.params.classId = String(cls.id);
    const students = await queryAll<{ id: number; student_num: number }>(
      'SELECT id, student_num FROM class_students WHERE class_id=?',
      [cls.id]
    );
    const studentMap = new Map(students.map(student => [String(student.student_num), student.id]));
    const sheet = wb.getWorksheet('내용');
    if (!sheet) return res.status(400).json({ error: '"내용" 시트를 찾을 수 없습니다.' });
    const h = headerMap(sheet.getRow(1));
    const grouped = new Map<string, { studentId: number; contentType: string; domain: string; items: Record<string, string> }>();

    sheet.eachRow((row, rowNum) => {
      if (rowNum === 1) return;
      const studentNum = cellText(row.getCell(h.student_num).value);
      const studentId = studentMap.get(studentNum);
      const contentType = cellText(row.getCell(h.content_type).value);
      const domain = cellText(row.getCell(h.domain).value);
      const item = cellText(row.getCell(h.item).value);
      const value = cellText(row.getCell(h.value).value);
      if (!studentId || !contentType || !domain || !item) return;
      const key = `${studentId}||${contentType}||${domain}`;
      const entry = grouped.get(key) || { studentId, contentType, domain, items: {} };
      entry.items[item] = value;
      grouped.set(key, entry);
    });

    let saved = 0;
    await transaction(async () => {
      for (const entry of grouped.values()) {
        const content = JSON.stringify(entry.items);
        await execute(`
          INSERT INTO generated_content(student_id, content_type, domain, content, updated_at)
          VALUES(?,?,?,?,datetime('now'))
          ON CONFLICT(student_id, content_type, domain)
          DO UPDATE SET content=excluded.content, updated_at=excluded.updated_at
        `, [entry.studentId, entry.contentType, entry.domain, content]);
        saved++;
      }
    });

    res.json({ ok: true, classId: cls.id, saved });
  } catch (e: unknown) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  } finally {
    try { if (req.file?.path) fs.unlinkSync(req.file.path); } catch { /* ignore */ }
  }
});

router.post('/import-full/:classId', upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });
  const classId = Number(req.params.classId);
  try {
    const students = await queryAll<{ id: number; student_num: number }>(
      'SELECT id, student_num FROM class_students WHERE class_id=?',
      [classId]
    );
    const studentMap = new Map(students.map(student => [String(student.student_num), student.id]));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(req.file.path);
    const sheet = wb.getWorksheet('내용');
    if (!sheet) return res.status(400).json({ error: '"내용" 시트를 찾을 수 없습니다.' });
    const h = headerMap(sheet.getRow(1));
    const grouped = new Map<string, { studentId: number; contentType: string; domain: string; items: Record<string, string> }>();

    sheet.eachRow((row, rowNum) => {
      if (rowNum === 1) return;
      const studentNum = cellText(row.getCell(h.student_num).value);
      const studentId = studentMap.get(studentNum);
      const contentType = cellText(row.getCell(h.content_type).value);
      const domain = cellText(row.getCell(h.domain).value);
      const item = cellText(row.getCell(h.item).value);
      const value = cellText(row.getCell(h.value).value);
      if (!studentId || !contentType || !domain || !item) return;
      const key = `${studentId}||${contentType}||${domain}`;
      const entry = grouped.get(key) || { studentId, contentType, domain, items: {} };
      entry.items[item] = value;
      grouped.set(key, entry);
    });

    let saved = 0;
    await transaction(async () => {
      for (const entry of grouped.values()) {
        const content = JSON.stringify(entry.items);
        await execute(`
          INSERT INTO generated_content(student_id, content_type, domain, content, updated_at)
          VALUES(?,?,?,?,datetime('now'))
          ON CONFLICT(student_id, content_type, domain)
          DO UPDATE SET content=excluded.content, updated_at=excluded.updated_at
        `, [entry.studentId, entry.contentType, entry.domain, content]);
        saved++;
      }
    });

    res.json({ ok: true, saved });
  } catch (e: unknown) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  } finally {
    try { if (req.file?.path) fs.unlinkSync(req.file.path); } catch { /* ignore */ }
  }
});

router.post('/delete-content', async (req: Request, res: Response) => {
  const { classId, studentIds, domain, contentTypes } = req.body as {
    classId: number;
    studentIds?: number[];
    domain?: string;
    contentTypes: string[];
  };

  try {
    let sql = `
      DELETE FROM generated_content
      WHERE student_id IN (SELECT id FROM class_students WHERE class_id = ?)
    `;
    const params: any[] = [classId];

    if (studentIds && studentIds.length > 0) {
      sql += ` AND student_id IN (${studentIds.map(() => '?').join(',')})`;
      params.push(...studentIds);
    }

    if (domain && domain !== 'all') {
      sql += ` AND domain = ?`;
      params.push(domain);
    }

    if (contentTypes && contentTypes.length > 0) {
      sql += ` AND content_type IN (${contentTypes.map(() => '?').join(',')})`;
      params.push(...contentTypes);
    }

    await execute(sql, params);
    res.json({ ok: true });
  } catch (e: unknown) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

export default router;
