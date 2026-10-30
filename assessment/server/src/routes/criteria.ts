import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import ExcelJS from 'exceljs';
import { queryAll, queryOne, execute, transaction } from '../services/db';
import { UPLOADS_DIR, ensureDir } from '../services/storage';
import { decodeUploadFilename } from '../services/filename';
import { parseAreaManagementExcel, parseAchievementStandardsExcel } from '../services/excel';
import informationCurriculumStandards from '../data/informationCurriculumStandards.json';
import {
  deleteAssignmentConfigsForScope,
  pruneAssignmentConfigsForAssessmentScope,
} from './assignmentConfigs';

const router = Router();
const CRITERIA_UPLOAD_DIR = path.join(UPLOADS_DIR, 'criteria');
const DOMAIN_UPLOAD_DIR = path.join(UPLOADS_DIR, 'domain');
ensureDir(CRITERIA_UPLOAD_DIR);
ensureDir(DOMAIN_UPLOAD_DIR);

function sourceUpload(dir: string) {
  return multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, dir),
      filename: (_req, file, cb) => cb(null, `${Date.now()}_${decodeUploadFilename(file.originalname)}`),
    }),
  });
}

const criteriaUpload = sourceUpload(CRITERIA_UPLOAD_DIR);
const domainUpload = sourceUpload(DOMAIN_UPLOAD_DIR);
const tempUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, CRITERIA_UPLOAD_DIR),
    filename: (_req, file, cb) => cb(null, `${Date.now()}_${decodeUploadFilename(file.originalname)}`),
  }),
});

function safeDownloadName(name: string): string {
  return encodeURIComponent(name).replace(/['()]/g, escape);
}

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

function formatConfigWorkbook(wb: ExcelJS.Workbook): void {
  for (const sheet of wb.worksheets) {
    sheet.getRow(1).font = { bold: true };
    sheet.columns.forEach(col => {
      const vals = (col.values as (unknown)[]).filter(v => v !== undefined && v !== null);
      const maxLen = vals.length > 0
        ? Math.max(...vals.map(v => String(v).length + 4))
        : 14;
      col.width = Math.max(14, Math.min(60, maxLen));
      col.alignment = { vertical: 'top', wrapText: true };
    });
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
  }
}

function findUploadedSourceFile(originalName: string, preferredDir: string): string | null {
  const normalized = originalName.normalize('NFC');
  const basename = path.basename(normalized);
  const candidates = new Set([
    normalized,
    basename,
    normalized.replace(/\//g, ':'),
    basename.replace(/\//g, ':'),
    normalized.replace(/:/g, '/'),
    basename.replace(/:/g, '/'),
  ]);

  const dirs = [preferredDir, CRITERIA_UPLOAD_DIR, DOMAIN_UPLOAD_DIR]
    .filter((dir, index, list) => list.indexOf(dir) === index);
  for (const dir of dirs) {
    for (const candidate of candidates) {
      const direct = path.isAbsolute(candidate) ? candidate : path.join(dir, candidate);
      if (fs.existsSync(direct)) return direct;
    }

    const files = fs.existsSync(dir) ? fs.readdirSync(dir).sort().reverse() : [];
    const found = files.find((file) => {
      const normalizedFile = file.normalize('NFC');
      return [...candidates].some((candidate) => (
        normalizedFile.endsWith(`_${candidate}`) ||
        normalizedFile.endsWith(`_${candidate.replace(/\//g, ':')}`)
      ));
    });
    if (found) return path.join(dir, found);
  }
  return null;
}

async function getStandardsSource(year: number, semester: number, grade: number, subject: string) {
  return queryOne<{ source_filename: string }>(
    `SELECT source_filename FROM achievement_standards
     WHERE year=? AND semester=? AND grade=? AND subject=?
       AND source_filename != ''
     ORDER BY id DESC LIMIT 1`,
    [year, semester, grade, subject]
  );
}

async function getDomainsSource(year: number, semester: number, grade: number, subject: string) {
  return queryOne<{ source_filename: string }>(
    `SELECT source_filename FROM subject_domains
     WHERE year=? AND semester=? AND grade=? AND subject=? AND sort_order >= 0
       AND source_filename != ''
     ORDER BY id DESC LIMIT 1`,
    [year, semester, grade, subject]
  );
}

// --- 레거시 기준 세트 (RecordsPage 호환용) ---
router.get('/sets', async (_req: Request, res: Response) => {
  const sets = await queryAll('SELECT * FROM criteria_sets ORDER BY id DESC');
  res.json(sets);
});

// --- 과목 목록 및 고정 영역 조회 ---
router.get('/subjects', async (req: Request, res: Response) => {
  const subjects = await queryAll<{
    year: number; semester: number; grade: number; subject: string; class_id: number;
  }>(`
    SELECT year, semester, grade, subject, MIN(class_id) as class_id
    FROM (
      SELECT year, semester, grade, subject, 0 as class_id FROM subject_domains
      UNION ALL
      SELECT year, semester, grade, subject, 0 as class_id FROM custom_domains
    )
    GROUP BY year, semester, grade, subject
    ORDER BY year ASC, semester, grade, subject
  `);

  const result = [];
  for (const sub of subjects) {
    let fixedDomains = await queryAll<{ name: string; max_score: number; ratio: number; sort_order: number }>(
      `SELECT name, max_score, ratio, sort_order
       FROM subject_domains
       WHERE year=? AND semester=? AND grade=? AND subject=? AND eval_type='수행' AND reflected='O'
       ORDER BY sort_order`,
      [sub.year, sub.semester, sub.grade, sub.subject]
    );

    const customDomains = await queryAll<{ id: number; name: string }>(
      `SELECT id, name FROM custom_domains WHERE year=? AND semester=? AND grade=? AND subject=?
       UNION ALL
       SELECT id, name FROM subject_domains WHERE year=? AND semester=? AND grade=? AND subject=? AND eval_type='기록'
       ORDER BY id`,
      [sub.year, sub.semester, sub.grade, sub.subject, sub.year, sub.semester, sub.grade, sub.subject]
    );

    // 파일 업로드 여부: source_filename이 설정된 행이 있으면 업로드된 과목
    const hasSourceRow = await queryOne<{ has_source: number }>(
      `SELECT MAX(CASE WHEN source_filename != '' THEN 1 ELSE 0 END) as has_source
       FROM subject_domains WHERE year=? AND semester=? AND grade=? AND subject=? AND sort_order >= 0`,
      [sub.year, sub.semester, sub.grade, sub.subject]
    );
    const lessonSource = await queryOne<{ source_filename: string; source_filepath: string; excel_path: string }>(
      `SELECT source_filename,source_filepath,excel_path FROM subject_plan_settings
       WHERE year=? AND semester=? AND grade=? AND subject=?`,
      [sub.year, sub.semester, sub.grade, sub.subject]
    );
    result.push({
      ...sub,
      fixedDomains,
      customDomains,
      has_source: Number(hasSourceRow?.has_source ?? 0),
      has_lesson_source: lessonSource && (lessonSource.source_filename || lessonSource.source_filepath || lessonSource.excel_path) ? 1 : 0,
    });
  }
  res.json(result);
});

router.get('/subject-domains', async (req: Request, res: Response) => {
  const { year, semester, grade, subject } = req.query;
  // Exclude anchor rows (sort_order=-1). Returns all real rows including file-sourced ones.
  const rows = await queryAll(
    `SELECT id, year, semester, grade, subject, credit, eval_type, name, reflected, ratio, max_score, sort_order, source_filename
     FROM subject_domains
     WHERE year=? AND semester=? AND grade=? AND subject=? AND sort_order >= 0
     ORDER BY sort_order`,
    [Number(year), Number(semester), Number(grade), String(subject)]
  );
  res.json(rows);
});

router.put('/subject-domains/bulk', async (req: Request, res: Response) => {
  const { year, semester, grade, subject, rows } = req.body;
  await transaction(async () => {
    const inputRows = Array.isArray(rows) ? rows as any[] : [];
    // 파일에서 업로드된 행(source_filename!='')은 보존하고,
    // 사용자가 추가한 기록 행(eval_type='기록', source_filename='')만 교체한다.
    const hasFileRows = await queryOne<{ found: number }>(
      `SELECT 1 as found FROM subject_domains
       WHERE year=? AND semester=? AND grade=? AND subject=?
         AND sort_order >= 0
         AND source_filename != ''
       LIMIT 1`,
      [year, semester, grade, subject]
    );

    if (hasFileRows) {
      // 업로드 과목: 사용자 추가 기록 행만 삭제 후 재삽입
      await execute(
        `DELETE FROM subject_domains
         WHERE year=? AND semester=? AND grade=? AND subject=?
           AND eval_type='기록' AND source_filename=''`,
        [year, semester, grade, subject]
      );
      const editableRows = inputRows.filter(row => !row.source_filename);
      for (let i = 0; i < editableRows.length; i++) {
        const row = editableRows[i];
        await execute(
          `INSERT INTO subject_domains(year, semester, grade, subject, credit, eval_type, name, reflected, ratio, max_score, sort_order, source_filename)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
          [year, semester, grade, subject, 0, '기록', row.name || '', 'X', Number(row.ratio) || 0, Number(row.max_score) || 0, 1000 + i, '']
        );
      }
    } else {
      // 수동 추가 과목: 기존 사용자 행 전체 교체 (anchor 행 제외)
      await execute(
        `DELETE FROM subject_domains WHERE year=? AND semester=? AND grade=? AND subject=? AND source_filename=''`,
        [year, semester, grade, subject]
      );
      if (inputRows.length === 0) {
        // 행이 없으면 anchor 행 삽입 (다른 테이블에 없을 경우에만)
        const existsElsewhere = await queryOne(
          `SELECT 1 as found FROM achievement_standards
           WHERE year=? AND semester=? AND grade=? AND subject=?
           UNION ALL
           SELECT 1 FROM custom_domains
           WHERE year=? AND semester=? AND grade=? AND subject=?
           LIMIT 1`,
          [year, semester, grade, subject, year, semester, grade, subject]
        );
        if (!existsElsewhere) {
          await execute(
            `INSERT INTO subject_domains(year, semester, grade, subject, credit, eval_type, name, reflected, ratio, max_score, sort_order, source_filename)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
            [year, semester, grade, subject, 0, '', '', 'X', 0, 0, -1, '']
          );
        }
      } else {
        for (let i = 0; i < inputRows.length; i++) {
          const row = inputRows[i];
          const evalType = ['지필', '수행', '기록'].includes(row.eval_type) ? row.eval_type : '수행';
          await execute(
            `INSERT INTO subject_domains(year, semester, grade, subject, credit, eval_type, name, reflected, ratio, max_score, sort_order, source_filename)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
          [year, semester, grade, subject, 0, evalType, row.name || '', evalType === '기록' ? 'X' : 'O', evalType === '기록' ? 0 : (Number(row.ratio) || 0), evalType === '기록' ? 0 : (Number(row.max_score) || 0), i, '']
          );
        }
      }
    }
  });
  res.json({ ok: true });
});

router.get('/domain-subjects', async (_req: Request, res: Response) => {
  const subjects = await queryAll(`
    SELECT year, semester, grade, subject, MAX(credit) as credit, COUNT(*) as domain_count
    FROM subject_domains
    GROUP BY year, semester, grade, subject
    ORDER BY year ASC, semester, grade, subject
  `);
  res.json(subjects);
});

router.get('/standard-subjects', async (_req: Request, res: Response) => {
  const subjects = await queryAll(`
    SELECT year, semester, grade, subject, domain_name, MAX(credit) as credit, COUNT(*) as standards_count,
           MAX(CASE WHEN source_filename != '' THEN 1 ELSE 0 END) as has_source
    FROM achievement_standards
    GROUP BY year, semester, grade, subject, domain_name
    ORDER BY year ASC, semester, grade, subject, domain_name
  `);
  res.json(subjects);
});

router.get('/standards/source-file', async (req: Request, res: Response) => {
  const year = Number(req.query.year);
  const semester = Number(req.query.semester);
  const grade = Number(req.query.grade);
  const subject = String(req.query.subject || '');
  const source = await getStandardsSource(year, semester, grade, subject);
  if (!source?.source_filename) return res.status(404).json({ error: '원본 파일 정보가 없습니다.' });
  const filepath = findUploadedSourceFile(source.source_filename, CRITERIA_UPLOAD_DIR);
  if (!filepath) return res.status(404).json({ error: '원본 파일을 찾을 수 없습니다.' });
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${safeDownloadName(source.source_filename)}`);
  res.sendFile(filepath);
});

router.delete('/standards/source-file', async (req: Request, res: Response) => {
  const year = Number(req.query.year);
  const semester = Number(req.query.semester);
  const grade = Number(req.query.grade);
  const subject = String(req.query.subject || '');
  const source = await getStandardsSource(year, semester, grade, subject);
  if (source?.source_filename) {
    const filepath = findUploadedSourceFile(source.source_filename, CRITERIA_UPLOAD_DIR);
    if (filepath) try { fs.unlinkSync(filepath); } catch {}
  }
  await transaction(async () => {
    await execute(
      'DELETE FROM achievement_standards WHERE year=? AND semester=? AND grade=? AND subject=?',
      [year, semester, grade, subject]
    );
    await execute(
      'DELETE FROM domain_comments WHERE year=? AND semester=? AND grade=? AND subject=?',
      [year, semester, grade, subject]
    );
    await execute(
      'DELETE FROM domain_eval WHERE year=? AND semester=? AND grade=? AND subject=?',
      [year, semester, grade, subject]
    );
    await execute(
      'DELETE FROM domain_ai_prompts WHERE year=? AND semester=? AND grade=? AND subject=?',
      [year, semester, grade, subject]
    );
  });
  res.json({ ok: true });
});

router.post('/standards/manual-domain', async (req: Request, res: Response) => {
  const year = Number(req.body?.year);
  const semester = Number(req.body?.semester);
  const grade = Number(req.body?.grade);
  const subject = String(req.body?.subject || '').trim();
  const credit = Number(req.body?.credit || 0);
  const domainName = String(req.body?.domainName || '').trim();
  if (!year || !semester || !grade || !subject || !domainName) {
    return res.status(400).json({ error: '학년도, 학기, 학년, 과목, 카테고리를 입력하세요.' });
  }

  const existing = await queryOne<{ id: number }>(
    `SELECT id FROM achievement_standards
     WHERE year=? AND semester=? AND grade=? AND subject=? AND domain_name=?
     LIMIT 1`,
    [year, semester, grade, subject, domainName]
  );
  if (existing) return res.json({ id: existing.id, existed: true });

  const r = await execute(
    `INSERT INTO achievement_standards(year, semester, grade, subject, credit, domain_name, code, content, level, description, sort_order, source_filename)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    [year, semester, grade, subject, credit, domainName, '', '', '', '', 0, '']
  );
  res.json({ id: Number(r.lastInsertRowid), existed: false });
});

type CurriculumStandard = {
  domainName: string;
  code: string;
  content: string;
  levels: Array<{ level: string; description: string }>;
};

router.post('/standards/from-curriculum', async (req: Request, res: Response) => {
  const year = Number(req.body?.year);
  const semester = Number(req.body?.semester);
  const grade = Number(req.body?.grade);
  const subject = String(req.body?.subject || '').trim();
  const credit = Number(req.body?.credit || 0);
  if (!year || !semester || !grade || !subject) {
    return res.status(400).json({ error: '학년도, 학기, 학년, 과목을 입력하세요.' });
  }

  const subjects = (informationCurriculumStandards as {
    subjects: Record<string, CurriculumStandard[]>;
  }).subjects;
  const standards = subjects[subject];
  if (!standards) {
    return res.status(404).json({
      error: '내장 성취 기준과 일치하는 과목이 없습니다. 현재 지원 과목: 정보, 인공지능 기초, 데이터 과학, 소프트웨어와 생활',
    });
  }

  await transaction(async () => {
    await execute(
      'DELETE FROM achievement_standards WHERE year=? AND semester=? AND grade=? AND subject=?',
      [year, semester, grade, subject]
    );
    let sortOrder = 0;
    for (const standard of standards) {
      for (const level of standard.levels) {
        await execute(
          `INSERT INTO achievement_standards(year, semester, grade, subject, credit, domain_name, code, content, level, description, sort_order, source_filename)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            year,
            semester,
            grade,
            subject,
            credit,
            standard.domainName,
            standard.code.startsWith('[') ? standard.code : `[${standard.code}]`,
            standard.content,
            level.level,
            level.description,
            sortOrder++,
            '',
          ]
        );
      }
    }
  });
  res.json({ year, semester, grade, subject, credit, standardsCount: standards.length });
});

router.delete('/standards/scope', async (req: Request, res: Response) => {
  const year = Number(req.query.year);
  const semester = req.query.semester !== undefined ? Number(req.query.semester) : undefined;
  const grade = req.query.grade !== undefined ? Number(req.query.grade) : undefined;
  const subject = req.query.subject !== undefined ? String(req.query.subject) : undefined;
  const domainName = req.query.domainName !== undefined ? String(req.query.domainName) : undefined;
  if (!year) return res.status(400).json({ error: '학년도가 필요합니다.' });

  const conditions = ['year=?'];
  const args: Array<string | number> = [year];
  if (semester !== undefined) { conditions.push('semester=?'); args.push(semester); }
  if (grade !== undefined) { conditions.push('grade=?'); args.push(grade); }
  if (subject !== undefined) { conditions.push('subject=?'); args.push(subject); }
  if (domainName !== undefined) { conditions.push('domain_name=?'); args.push(domainName); }
  const r = await execute(`DELETE FROM achievement_standards WHERE ${conditions.join(' AND ')}`, args);
  res.json({ ok: true, deleted: r.rowsAffected });
});

router.put('/standards/scope', async (req: Request, res: Response) => {
  const { from, to } = req.body || {};
  const year = Number(from?.year);
  if (!year || !to) return res.status(400).json({ error: '변경할 범위와 값이 필요합니다.' });

  const conditions = ['year=?'];
  const args: Array<string | number> = [year];
  if (from.semester !== undefined) { conditions.push('semester=?'); args.push(Number(from.semester)); }
  if (from.grade !== undefined) { conditions.push('grade=?'); args.push(Number(from.grade)); }
  if (from.subject !== undefined) { conditions.push('subject=?'); args.push(String(from.subject)); }
  if (from.domainName !== undefined) { conditions.push('domain_name=?'); args.push(String(from.domainName)); }

  const assignments: string[] = [];
  const values: Array<string | number> = [];
  if (to.year !== undefined) { assignments.push('year=?'); values.push(Number(to.year)); }
  if (to.semester !== undefined) { assignments.push('semester=?'); values.push(Number(to.semester)); }
  if (to.grade !== undefined) { assignments.push('grade=?'); values.push(Number(to.grade)); }
  if (to.subject !== undefined) { assignments.push('subject=?'); values.push(String(to.subject)); }
  if (to.domainName !== undefined) { assignments.push('domain_name=?'); values.push(String(to.domainName)); }
  if (!assignments.length) return res.status(400).json({ error: '변경할 값이 없습니다.' });

  const r = await execute(
    `UPDATE achievement_standards SET ${assignments.join(', ')} WHERE ${conditions.join(' AND ')}`,
    [...values, ...args]
  );
  res.json({ ok: true, updated: r.rowsAffected });
});

router.get('/domains/source-file', async (req: Request, res: Response) => {
  const year = Number(req.query.year);
  const semester = Number(req.query.semester);
  const grade = Number(req.query.grade);
  const subject = String(req.query.subject || '');
  const source = await getDomainsSource(year, semester, grade, subject);
  if (!source?.source_filename) return res.status(404).json({ error: '원본 파일 정보가 없습니다.' });
  const filepath = findUploadedSourceFile(source.source_filename, DOMAIN_UPLOAD_DIR);
  if (!filepath) return res.status(404).json({ error: '원본 파일을 찾을 수 없습니다.' });
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${safeDownloadName(source.source_filename)}`);
  res.sendFile(filepath);
});

router.delete('/domains/source-file', async (req: Request, res: Response) => {
  const year = Number(req.query.year);
  const semester = Number(req.query.semester);
  const grade = Number(req.query.grade);
  const subject = String(req.query.subject || '');
  const source = await getDomainsSource(year, semester, grade, subject);
  if (source?.source_filename) {
    const filepath = findUploadedSourceFile(source.source_filename, DOMAIN_UPLOAD_DIR);
    if (filepath) try { fs.unlinkSync(filepath); } catch {}
  }
  await transaction(async () => {
    await execute(
      'DELETE FROM subject_domains WHERE year=? AND semester=? AND grade=? AND subject=?',
      [year, semester, grade, subject]
    );
    await execute(
      'DELETE FROM custom_domains WHERE year=? AND semester=? AND grade=? AND subject=?',
      [year, semester, grade, subject]
    );
    await execute(
      'DELETE FROM domain_comments WHERE year=? AND semester=? AND grade=? AND subject=?',
      [year, semester, grade, subject]
    );
    await execute(
      'DELETE FROM domain_eval WHERE year=? AND semester=? AND grade=? AND subject=?',
      [year, semester, grade, subject]
    );
    await execute(
      'DELETE FROM domain_ai_prompts WHERE year=? AND semester=? AND grade=? AND subject=?',
      [year, semester, grade, subject]
    );
  });
  await deleteAssignmentConfigsForScope({ year, semester, grade, subject });
  res.json({ ok: true });
});

router.delete('/domains/scope', async (req: Request, res: Response) => {
  const year = Number(req.query.year);
  const semester = req.query.semester !== undefined ? Number(req.query.semester) : undefined;
  const grade = req.query.grade !== undefined ? Number(req.query.grade) : undefined;
  const subject = req.query.subject !== undefined ? String(req.query.subject) : undefined;
  const domainName = req.query.domainName !== undefined ? String(req.query.domainName) : undefined;
  if (!year) return res.status(400).json({ error: '학년도가 필요합니다.' });

  const conditions = ['year=?'];
  const args: Array<string | number> = [year];
  if (semester !== undefined) { conditions.push('semester=?'); args.push(semester); }
  if (grade !== undefined) { conditions.push('grade=?'); args.push(grade); }
  if (subject !== undefined) { conditions.push('subject=?'); args.push(subject); }
  const where = conditions.join(' AND ');

  await transaction(async () => {
    if (domainName !== undefined) {
      await execute(`DELETE FROM subject_domains WHERE ${where} AND name=?`, [...args, domainName]);
      await execute(`DELETE FROM custom_domains WHERE ${where} AND name=?`, [...args, domainName]);
      await execute(`DELETE FROM domain_comments WHERE ${where} AND domain_name=?`, [...args, domainName]);
      await execute(`DELETE FROM domain_eval WHERE ${where} AND domain_name=?`, [...args, domainName]);
      await execute(`DELETE FROM domain_ai_prompts WHERE ${where} AND domain_name=?`, [...args, domainName]);
    } else {
      await execute(`DELETE FROM subject_domains WHERE ${where}`, args);
      await execute(`DELETE FROM custom_domains WHERE ${where}`, args);
      await execute(`DELETE FROM domain_comments WHERE ${where}`, args);
      await execute(`DELETE FROM domain_eval WHERE ${where}`, args);
      await execute(`DELETE FROM domain_ai_prompts WHERE ${where}`, args);
    }
  });
  await deleteAssignmentConfigsForScope({ year, semester, grade, subject, domainName });
  res.json({ ok: true });
});

router.put('/domains/scope', async (req: Request, res: Response) => {
  const { from, to } = req.body || {};
  const year = Number(from?.year);
  if (!year || !to) return res.status(400).json({ error: '변경할 범위와 값이 필요합니다.' });

  const conditions = ['year=?'];
  const args: Array<string | number> = [year];
  if (from.semester !== undefined) { conditions.push('semester=?'); args.push(Number(from.semester)); }
  if (from.grade !== undefined) { conditions.push('grade=?'); args.push(Number(from.grade)); }
  if (from.subject !== undefined) { conditions.push('subject=?'); args.push(String(from.subject)); }
  const domainName = from.domainName !== undefined ? String(from.domainName) : undefined;
  const where = conditions.join(' AND ');

  const assignments: string[] = [];
  const values: Array<string | number> = [];
  if (to.year !== undefined) { assignments.push('year=?'); values.push(Number(to.year)); }
  if (to.semester !== undefined) { assignments.push('semester=?'); values.push(Number(to.semester)); }
  if (to.grade !== undefined) { assignments.push('grade=?'); values.push(Number(to.grade)); }
  if (to.subject !== undefined) { assignments.push('subject=?'); values.push(String(to.subject)); }
  const toDomainName = to.domainName !== undefined ? String(to.domainName) : undefined;
  if (!assignments.length && toDomainName === undefined) return res.status(400).json({ error: '변경할 값이 없습니다.' });

  await transaction(async () => {
    if (assignments.length) {
      await execute(`UPDATE subject_domains SET ${assignments.join(', ')} WHERE ${where}${domainName !== undefined ? ' AND name=?' : ''}`, [...values, ...args, ...(domainName !== undefined ? [domainName] : [])]);
      await execute(`UPDATE custom_domains SET ${assignments.join(', ')} WHERE ${where}${domainName !== undefined ? ' AND name=?' : ''}`, [...values, ...args, ...(domainName !== undefined ? [domainName] : [])]);
      await execute(`UPDATE domain_comments SET ${assignments.join(', ')} WHERE ${where}${domainName !== undefined ? ' AND domain_name=?' : ''}`, [...values, ...args, ...(domainName !== undefined ? [domainName] : [])]);
      await execute(`UPDATE domain_eval SET ${assignments.join(', ')} WHERE ${where}${domainName !== undefined ? ' AND domain_name=?' : ''}`, [...values, ...args, ...(domainName !== undefined ? [domainName] : [])]);
    }
    if (toDomainName !== undefined && domainName !== undefined) {
      await execute(`UPDATE subject_domains SET name=? WHERE ${where} AND name=?`, [toDomainName, ...args, domainName]);
      await execute(`UPDATE custom_domains SET name=? WHERE ${where} AND name=?`, [toDomainName, ...args, domainName]);
      await execute(`UPDATE domain_comments SET domain_name=? WHERE ${where} AND domain_name=?`, [toDomainName, ...args, domainName]);
      await execute(`UPDATE domain_eval SET domain_name=? WHERE ${where} AND domain_name=?`, [toDomainName, ...args, domainName]);
    }
  });
  res.json({ ok: true });
});

router.get('/domains', async (req: Request, res: Response) => {
  const { year, semester, grade, subject } = req.query;
  const rows = await queryAll(
    `SELECT * FROM subject_domains
     WHERE year=? AND semester=? AND grade=? AND subject=?
     ORDER BY sort_order, id`,
    [Number(year), Number(semester), Number(grade), String(subject)]
  );
  res.json(rows);
});

router.post('/domains/anchor', async (req: Request, res: Response) => {
  const { year, semester, grade, subject } = req.body;
  const existing = await queryOne(
    `SELECT 1 FROM subject_domains WHERE year=? AND semester=? AND grade=? AND subject=? LIMIT 1`,
    [year, semester, grade, subject]
  );
  if (!existing) {
    await execute(
      `INSERT INTO subject_domains(year, semester, grade, subject, credit, eval_type, name, reflected, ratio, max_score, sort_order, source_filename)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      [year, semester, grade, subject, 0, '', '', 'X', 0, 0, -1, '']
    );
  }
  res.json({ ok: true });
});

router.post('/domains/upload', domainUpload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });
  const originalName = decodeUploadFilename(req.file.originalname);
  try {
    const parsed = await parseAreaManagementExcel(req.file.path);
    // Only existing real domain rows should block a domain upload.
    // Standards for the same subject can legitimately be uploaded separately.
    if (!req.query.overwrite) {
      const existing = await queryOne(
        `SELECT 1 as found FROM subject_domains
         WHERE year=? AND semester=? AND grade=? AND subject=? AND sort_order >= 0
         LIMIT 1`,
        [parsed.info.year, parsed.info.semester, parsed.info.grade, parsed.info.subject]
      );
      if (existing) {
        return res.status(409).json({
          conflict: true,
          year: parsed.info.year, semester: parsed.info.semester,
          grade: parsed.info.grade, subject: parsed.info.subject,
        });
      }
    }
    await transaction(async () => {
      await execute(
        'DELETE FROM subject_domains WHERE year=? AND semester=? AND grade=? AND subject=?',
        [parsed.info.year, parsed.info.semester, parsed.info.grade, parsed.info.subject]
      );
      for (const row of parsed.rows) {
        await execute(
          `INSERT INTO subject_domains(year, semester, grade, subject, credit, eval_type, name, reflected, ratio, max_score, sort_order, source_filename)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            parsed.info.year, parsed.info.semester, parsed.info.grade, parsed.info.subject, parsed.info.credit,
            row.evalType, row.name, row.reflected, row.ratio, row.maxScore, row.sortOrder, originalName,
          ]
        );
      }
    });
    await pruneAssignmentConfigsForAssessmentScope(
      parsed.info.year,
      parsed.info.semester,
      parsed.info.grade,
      parsed.info.subject
    );
    res.json({
      ...parsed.info,
      credit: parsed.info.credit,
      totalCount: parsed.rows.length,
      reflectedPerformanceCount: parsed.rows.filter((row) => row.evalType === '수행' && row.reflected === 'O').length,
    });
  } catch (e: unknown) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

router.get('/standards', async (req: Request, res: Response) => {
  const { year, semester, grade, subject } = req.query;
  const rows = await queryAll(
    `SELECT * FROM achievement_standards
     WHERE year=? AND semester=? AND grade=? AND subject=?
     ORDER BY domain_name, sort_order, id`,
    [Number(year), Number(semester), Number(grade), String(subject)]
  );
  res.json(rows);
});

router.post('/standards/anchor', async (req: Request, res: Response) => {
  const { year, semester, grade, subject } = req.body;
  const existing = await queryOne(
    `SELECT 1 FROM achievement_standards WHERE year=? AND semester=? AND grade=? AND subject=? LIMIT 1`,
    [year, semester, grade, subject]
  );
  if (!existing) {
    await execute(
      `INSERT INTO achievement_standards(year, semester, grade, subject, credit, domain_name, code, content, level, description, sort_order, source_filename)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      [year, semester, grade, subject, 0, '', '', '', '', '', -1, '']
    );
  }
  res.json({ ok: true });
});

router.post('/standards/upload', criteriaUpload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });
  const originalName = decodeUploadFilename(req.file.originalname);
  try {
    const parsed = await parseAchievementStandardsExcel(req.file.path);
    if (!req.query.overwrite) {
      const existing = await queryOne(
        `SELECT 1 as found FROM achievement_standards
         WHERE year=? AND semester=? AND grade=? AND subject=? AND sort_order >= 0
         LIMIT 1`,
        [parsed.info.year, parsed.info.semester, parsed.info.grade, parsed.info.subject]
      );
      if (existing) {
        return res.status(409).json({
          conflict: true,
          year: parsed.info.year, semester: parsed.info.semester,
          grade: parsed.info.grade, subject: parsed.info.subject,
        });
      }
    }
    await transaction(async () => {
      await execute(
        'DELETE FROM achievement_standards WHERE year=? AND semester=? AND grade=? AND subject=?',
        [parsed.info.year, parsed.info.semester, parsed.info.grade, parsed.info.subject]
      );
      for (const row of parsed.rows) {
        await execute(
          `INSERT INTO achievement_standards(year, semester, grade, subject, credit, domain_name, code, content, level, description, sort_order, source_filename)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            parsed.info.year, parsed.info.semester, parsed.info.grade, parsed.info.subject, parsed.info.credit,
            row.domainName, row.code, row.content, row.level, row.description, row.sortOrder, originalName,
          ]
        );
      }
    });
    res.json({ ...parsed.info, standardsCount: parsed.rows.length });
  } catch (e: unknown) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

router.get('/standards-config/export', async (req: Request, res: Response) => {
  const year = Number(req.query.year);
  const semester = Number(req.query.semester);
  const grade = Number(req.query.grade);
  const subject = String(req.query.subject || '');
  const domainName = String(req.query.domainName || '');

  const rows = await queryAll<{ code: string; content: string; level: string; description: string; sort_order: number }>(
    `SELECT code, content, level, description, sort_order
     FROM achievement_standards
     WHERE year=? AND semester=? AND grade=? AND subject=? AND domain_name=?
     ORDER BY sort_order, id`,
    [year, semester, grade, subject, domainName]
  );

  const wb = new ExcelJS.Workbook();
  const meta = wb.addWorksheet('기본정보');
  meta.addRows([
    ['학년도', year],
    ['학기', semester],
    ['학년', grade],
    ['과목', subject],
    ['영역', domainName],
  ]);

  const sheet = wb.addWorksheet('성취기준');
  sheet.addRow(['sort_order', 'code', 'content', 'level', 'description']);
  rows.forEach((row, index) => {
    sheet.addRow([row.sort_order ?? index, row.code, row.content, row.level, row.description]);
  });

  for (const ws of wb.worksheets) {
    ws.getRow(1).font = { bold: true };
    ws.columns.forEach(col => {
      const vals = (col.values as unknown[]).filter(v => v !== undefined && v !== null);
      const maxLen = vals.length ? Math.max(...vals.map(v => String(v).length + 4)) : 14;
      col.width = Math.max(14, Math.min(60, maxLen));
      col.alignment = { vertical: 'top', wrapText: true };
    });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  }

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${safeDownloadName(`${year}_${semester}_${grade}_${subject}_${domainName}_성취기준.xlsx`)}`);
  res.send(buffer);
});

router.post('/standards-config/upload', tempUpload.single('file'), async (req: Request, res: Response) => {
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
    const domainName = String(meta['영역'] || '').trim();
    if (!year || !semester || !grade || !subject || !domainName) {
      return res.status(400).json({ error: '기본정보 시트에서 학년도, 학기, 학년, 과목, 영역을 찾을 수 없습니다.' });
    }

    const sheet = wb.getWorksheet('성취기준');
    if (!sheet) return res.status(400).json({ error: '"성취기준" 시트를 찾을 수 없습니다.' });
    const h = headerMap(sheet.getRow(1));
    const rows: { code: string; content: string; level: string; description: string; sort_order: number }[] = [];
    sheet.eachRow((row, rowNum) => {
      if (rowNum === 1) return;
      const code = cellText(row.getCell(h.code).value);
      const content = cellText(row.getCell(h.content).value);
      const level = cellText(row.getCell(h.level).value);
      const description = cellText(row.getCell(h.description).value);
      if (!code && !content && !description) return;
      rows.push({
        sort_order: Number(cellText(row.getCell(h.sort_order).value)) || rows.length,
        code,
        content,
        level,
        description,
      });
    });

    await transaction(async () => {
      await execute(
        'DELETE FROM achievement_standards WHERE year=? AND semester=? AND grade=? AND subject=? AND domain_name=?',
        [year, semester, grade, subject, domainName]
      );
      for (const [index, row] of rows.entries()) {
        await execute(
          `INSERT INTO achievement_standards(year, semester, grade, subject, credit, domain_name, code, content, level, description, sort_order, source_filename)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
          [year, semester, grade, subject, 0, domainName, row.code, row.content, row.level, row.description, row.sort_order ?? index, '']
        );
      }
    });

    res.json({ ok: true, year, semester, grade, subject, domain_name: domainName, standards: rows.length });
  } catch (e: unknown) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  } finally {
    try { if (req.file?.path) fs.unlinkSync(req.file.path); } catch { /* ignore */ }
  }
});

// --- 커스텀 수행평가 영역 (세특 전용) ---
router.post('/custom-domains', async (req: Request, res: Response) => {
  const { year, semester, grade, subject, name } = req.body;
  const r = await execute(
    'INSERT INTO custom_domains(year, semester, grade, subject, name) VALUES(?,?,?,?,?)',
    [year, semester, grade, subject, name]
  );
  res.json({ id: Number(r.lastInsertRowid) });
});

router.delete('/custom-domains/:id', async (req: Request, res: Response) => {
  const existing = await queryOne<{ year: number; semester: number; grade: number; subject: string; name: string }>(
    'SELECT year, semester, grade, subject, name FROM custom_domains WHERE id=?',
    [req.params.id]
  );
  if (existing) {
    await transaction(async () => {
      await execute('DELETE FROM custom_domains WHERE id=?', [req.params.id]);
      await execute(
        'DELETE FROM domain_comments WHERE year=? AND semester=? AND grade=? AND subject=? AND domain_name=?',
        [existing.year, existing.semester, existing.grade, existing.subject, existing.name]
      );
      await execute(
        'DELETE FROM domain_eval WHERE year=? AND semester=? AND grade=? AND subject=? AND domain_name=?',
        [existing.year, existing.semester, existing.grade, existing.subject, existing.name]
      );
      await execute(
        'DELETE FROM domain_ai_prompts WHERE year=? AND semester=? AND grade=? AND subject=? AND domain_name=?',
        [existing.year, existing.semester, existing.grade, existing.subject, existing.name]
      );
    });
    await pruneAssignmentConfigsForAssessmentScope(
      existing.year,
      existing.semester,
      existing.grade,
      existing.subject
    );
  }
  res.json({ ok: true });
});

router.put('/custom-domains/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const name = String(req.body?.name || '').trim();
  if (!id || !name) return res.status(400).json({ error: '영역 이름이 필요합니다.' });
  const existing = await queryOne<{ year: number; semester: number; grade: number; subject: string; name: string }>(
    'SELECT year, semester, grade, subject, name FROM custom_domains WHERE id=?',
    [id]
  );
  if (!existing) return res.status(404).json({ error: '영역을 찾을 수 없습니다.' });
  await transaction(async () => {
    await execute('UPDATE custom_domains SET name=? WHERE id=?', [name, id]);
    await execute(
      'UPDATE domain_comments SET domain_name=? WHERE year=? AND semester=? AND grade=? AND subject=? AND domain_name=?',
      [name, existing.year, existing.semester, existing.grade, existing.subject, existing.name]
    );
    await execute(
      'UPDATE domain_eval SET domain_name=? WHERE year=? AND semester=? AND grade=? AND subject=? AND domain_name=?',
      [name, existing.year, existing.semester, existing.grade, existing.subject, existing.name]
    );
    await execute(
      'UPDATE domain_ai_prompts SET domain_name=? WHERE year=? AND semester=? AND grade=? AND subject=? AND domain_name=?',
      [name, existing.year, existing.semester, existing.grade, existing.subject, existing.name]
    );
  });
  res.json({ ok: true });
});

// --- 세특 기준 ---
router.get('/comments', async (req: Request, res: Response) => {
  const { year, semester, grade, subject, domainName } = req.query;
  const items = await queryAll(
    'SELECT * FROM domain_comments WHERE year=? AND semester=? AND grade=? AND subject=? AND domain_name=? ORDER BY sort_order, id',
    [Number(year), Number(semester), Number(grade), String(subject), String(domainName)]
  );
  res.json(items);
});

router.put('/comments/bulk', async (req: Request, res: Response) => {
  const { year, semester, grade, subject, domainName, items } = req.body as {
    year: number; semester: number; grade: number; subject: string; domainName: string;
    items: { type: string; title: string; prompt: string; extensions: string; sort_order: number }[];
  };

  await transaction(async () => {
    await execute(
      'DELETE FROM domain_comments WHERE year=? AND semester=? AND grade=? AND subject=? AND domain_name=?', 
      [year, semester, grade, subject, domainName]
    );
    const comprehensiveItem = domainName === '__SUBJECT_COMPREHENSIVE__'
      ? items.find(item => item.type === '세특') ?? items.find(item => item.type === '종합')
      : undefined;
    const normalizedItems = domainName === '__SUBJECT_COMPREHENSIVE__'
      ? comprehensiveItem
        ? [{ ...comprehensiveItem, type: '세특', title: '세특', sort_order: 0 }]
        : []
      : items;
    for (const item of normalizedItems) {
      await execute(
        'INSERT INTO domain_comments(year, semester, grade, subject, domain_name, type, title, prompt, extensions, sort_order) VALUES(?,?,?,?,?,?,?,?,?,?)',
        [year, semester, grade, subject, domainName, item.type, item.title, item.prompt, item.extensions, item.sort_order]
      );
    }
  });
  res.json({ ok: true });
});

// --- 평가 기준 (채점) ---
router.get('/eval', async (req: Request, res: Response) => {
  const { year, semester, grade, subject, domainName } = req.query;
  const items = await queryAll(
    'SELECT * FROM domain_eval WHERE year=? AND semester=? AND grade=? AND subject=? AND domain_name=? ORDER BY sort_order, id',
    [Number(year), Number(semester), Number(grade), String(subject), String(domainName)]
  );
  res.json(items);
});

router.put('/eval/bulk', async (req: Request, res: Response) => {
  const { year, semester, grade, subject, domainName, items } = req.body as {
    year: number; semester: number; grade: number; subject: string; domainName: string;
    items: { name: string; score: string; item_type: string; rubric: string; sort_order: number }[];
  };

  await transaction(async () => {
    await execute(
      'DELETE FROM domain_eval WHERE year=? AND semester=? AND grade=? AND subject=? AND domain_name=?',
      [year, semester, grade, subject, domainName]
    );
    for (const item of items) {
      await execute(
        'INSERT INTO domain_eval(year, semester, grade, subject, domain_name, name, score, item_type, rubric, sort_order) VALUES(?,?,?,?,?,?,?,?,?,?)',
        [year, semester, grade, subject, domainName, item.name, item.score, item.item_type, item.rubric, item.sort_order]
      );
    }
  });
  res.json({ ok: true });
});

router.get('/ai-prompts', async (req: Request, res: Response) => {
  const { year, semester, grade, subject, domainName } = req.query;
  const items = await queryAll<{ prompt_key: string; prompt: string }>(
    'SELECT prompt_key, prompt FROM domain_ai_prompts WHERE year=? AND semester=? AND grade=? AND subject=? AND domain_name=? ORDER BY prompt_key',
    [Number(year), Number(semester), Number(grade), String(subject), String(domainName || '__SUBJECT_COMPREHENSIVE__')]
  );
  res.json(items);
});

router.put('/ai-prompts/bulk', async (req: Request, res: Response) => {
  const { year, semester, grade, subject, domainName, prompts } = req.body as {
    year: number;
    semester: number;
    grade: number;
    subject: string;
    domainName: string;
    prompts: { prompt_key: string; prompt: string }[];
  };
  const scopedDomainName = domainName || '__SUBJECT_COMPREHENSIVE__';
  await transaction(async () => {
    await execute(
      'DELETE FROM domain_ai_prompts WHERE year=? AND semester=? AND grade=? AND subject=? AND domain_name=?',
      [year, semester, grade, subject, scopedDomainName]
    );
    for (const item of prompts || []) {
      const key = String(item.prompt_key || '').trim();
      const prompt = String(item.prompt || '');
      if (!key && !prompt.trim()) continue;
      await execute(
        'INSERT OR REPLACE INTO domain_ai_prompts(year, semester, grade, subject, domain_name, prompt_key, prompt, updated_at) VALUES(?,?,?,?,?,?,?,datetime(\'now\'))',
        [year, semester, grade, subject, scopedDomainName, key, prompt]
      );
    }
  });
  res.json({ ok: true });
});

router.get('/subject-config/export', async (req: Request, res: Response) => {
  const year = Number(req.query.year);
  const semester = Number(req.query.semester);
  const grade = Number(req.query.grade);
  const subject = String(req.query.subject || '').trim();
  if (!year || !semester || !grade || !subject) {
    return res.status(400).json({ error: '학년도, 학기, 학년, 과목이 필요합니다.' });
  }

  const rows = await queryAll<{
    eval_type: string; name: string; reflected: string;
    ratio: number; max_score: number; sort_order: number;
  }>(
    `SELECT eval_type, name, reflected, ratio, max_score, sort_order
     FROM subject_domains
     WHERE year=? AND semester=? AND grade=? AND subject=? AND sort_order >= 0
     ORDER BY sort_order, id`,
    [year, semester, grade, subject]
  );
  const aiPrompts = await queryAll<{ prompt_key: string; prompt: string }>(
    `SELECT prompt_key, prompt FROM domain_ai_prompts
     WHERE year=? AND semester=? AND grade=? AND subject=?
       AND domain_name='__SUBJECT_COMPREHENSIVE__' AND prompt_key='subject_domains'
     ORDER BY prompt_key`,
    [year, semester, grade, subject]
  );

  const wb = new ExcelJS.Workbook();
  const meta = wb.addWorksheet('기본정보');
  meta.addRows([
    ['학년도', year],
    ['학기', semester],
    ['학년', grade],
    ['과목', subject],
  ]);

  const domainsSheet = wb.addWorksheet('평가영역');
  domainsSheet.addRow(['sort_order', '평가종류', '영역명', '학기말반영', '반영비율', '만점']);
  rows.forEach((row, index) => {
    domainsSheet.addRow([
      row.sort_order ?? index,
      row.eval_type,
      row.name,
      row.reflected,
      row.ratio,
      row.max_score,
    ]);
  });

  const promptSheet = wb.addWorksheet('AI요청');
  promptSheet.addRow(['prompt_key', 'prompt']);
  aiPrompts.forEach(item => promptSheet.addRow([item.prompt_key, item.prompt]));

  formatConfigWorkbook(wb);
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${safeDownloadName(`${year}_${semester}_${grade}_${subject}_평가영역.xlsx`)}`);
  res.send(buffer);
});

router.post('/subject-config/upload', tempUpload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });

  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(req.file.path);

    const meta: Record<string, string> = {};
    wb.getWorksheet('기본정보')?.eachRow((row) => {
      const key = cellText(row.getCell(1).value);
      if (key) meta[key] = cellText(row.getCell(2).value);
    });

    const year = Number(req.body.year || meta['학년도']);
    const semester = Number(req.body.semester || meta['학기']);
    const grade = Number(req.body.grade || meta['학년']);
    const subject = String(req.body.subject || meta['과목'] || '').trim();
    if (!year || !semester || !grade || !subject) {
      return res.status(400).json({ error: '기본정보 시트에서 학년도, 학기, 학년, 과목을 찾을 수 없습니다.' });
    }

    const domainsSheet = wb.getWorksheet('평가영역');
    if (!domainsSheet) {
      return res.status(400).json({ error: '평가영역 시트를 찾을 수 없습니다.' });
    }

    const domainRows: {
      eval_type: string; name: string; reflected: string;
      ratio: number; max_score: number; sort_order: number;
    }[] = [];
    const h = headerMap(domainsSheet.getRow(1));
    domainsSheet.eachRow((row, rowNum) => {
      if (rowNum === 1) return;
      const evalType = cellText(row.getCell(h['평가종류']).value);
      const name = cellText(row.getCell(h['영역명']).value);
      if (!evalType && !name) return;
      if (!['지필', '수행', '기록'].includes(evalType)) {
        throw new Error(`평가영역 시트 ${rowNum}행의 평가종류는 지필, 수행, 기록 중 하나여야 합니다.`);
      }
      domainRows.push({
        eval_type: evalType,
        name,
        reflected: evalType === '기록'
          ? 'X'
          : (cellText(row.getCell(h['학기말반영']).value).toUpperCase() === 'X' ? 'X' : 'O'),
        ratio: evalType === '기록' ? 0 : (Number(cellText(row.getCell(h['반영비율']).value)) || 0),
        max_score: evalType === '기록' ? 0 : (Number(cellText(row.getCell(h['만점']).value)) || 0),
        sort_order: Number(cellText(row.getCell(h.sort_order).value)) || domainRows.length,
      });
    });

    const aiPromptRows: { prompt_key: string; prompt: string }[] = [];
    const aiPromptSheet = wb.getWorksheet('AI요청');
    if (aiPromptSheet) {
      const promptHeaders = headerMap(aiPromptSheet.getRow(1));
      aiPromptSheet.eachRow((row, rowNum) => {
        if (rowNum === 1) return;
        const promptKey = cellText(row.getCell(promptHeaders.prompt_key).value);
        const prompt = cellText(row.getCell(promptHeaders.prompt).value);
        if (promptKey === 'subject_domains') aiPromptRows.push({ prompt_key: promptKey, prompt });
      });
    }

    await transaction(async () => {
      const current = await queryOne<{ credit: number }>(
        `SELECT MAX(credit) as credit FROM subject_domains
         WHERE year=? AND semester=? AND grade=? AND subject=?`,
        [year, semester, grade, subject]
      );
      const credit = Number(current?.credit) || 0;
      const existingSourceRows = await queryAll<{
        eval_type: string; name: string; source_filename: string;
      }>(
        `SELECT eval_type, name, source_filename FROM subject_domains
         WHERE year=? AND semester=? AND grade=? AND subject=? AND source_filename != ''`,
        [year, semester, grade, subject]
      );

      await execute(
        'DELETE FROM subject_domains WHERE year=? AND semester=? AND grade=? AND subject=?',
        [year, semester, grade, subject]
      );
      if (domainRows.length === 0) {
        await execute(
          `INSERT INTO subject_domains(year, semester, grade, subject, credit, eval_type, name, reflected, ratio, max_score, sort_order, source_filename)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
          [year, semester, grade, subject, credit, '', '', 'X', 0, 0, -1, '']
        );
      } else {
        for (const [index, row] of domainRows.entries()) {
          const matchingSourceRow = existingSourceRows.find(existing => (
            existing.eval_type === row.eval_type && existing.name === row.name
          ));
          await execute(
            `INSERT INTO subject_domains(year, semester, grade, subject, credit, eval_type, name, reflected, ratio, max_score, sort_order, source_filename)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
              year,
              semester,
              grade,
              subject,
              credit,
              row.eval_type,
              row.name,
              row.reflected,
              row.ratio,
              row.max_score,
              row.sort_order ?? index,
              matchingSourceRow?.source_filename || '',
            ]
          );
        }
      }

      await execute(
        `DELETE FROM domain_ai_prompts
         WHERE year=? AND semester=? AND grade=? AND subject=?
           AND domain_name='__SUBJECT_COMPREHENSIVE__' AND prompt_key='subject_domains'`,
        [year, semester, grade, subject]
      );
      for (const row of aiPromptRows) {
        await execute(
          `INSERT OR REPLACE INTO domain_ai_prompts(
             year, semester, grade, subject, domain_name, prompt_key, prompt, updated_at
           ) VALUES(?,?,?,?,?,'subject_domains',?,datetime('now'))`,
          [year, semester, grade, subject, '__SUBJECT_COMPREHENSIVE__', row.prompt]
        );
      }
    });
    await pruneAssignmentConfigsForAssessmentScope(year, semester, grade, subject);

    res.json({
      ok: true,
      kind: 'subject',
      year,
      semester,
      grade,
      subject,
      domains: domainRows.length,
      prompts: aiPromptRows.length,
    });
  } catch (e: unknown) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  } finally {
    try { if (req.file?.path) fs.unlinkSync(req.file.path); } catch { /* ignore */ }
  }
});

router.get('/domain-config/export', async (req: Request, res: Response) => {
  const year = Number(req.query.year);
  const semester = Number(req.query.semester);
  const grade = Number(req.query.grade);
  const subject = String(req.query.subject || '');
  const domainName = String(req.query.domainName || '__SUBJECT_COMPREHENSIVE__');

  const wb = new ExcelJS.Workbook();
  const meta = wb.addWorksheet('기본정보');
  meta.addRows([
    ['학년도', year],
    ['학기', semester],
    ['학년', grade],
    ['과목', subject],
    ['영역', domainName],
  ]);
  meta.getColumn(1).width = 14;
  meta.getColumn(2).width = 40;

  const commentsItems = await queryAll<{ type: string; title: string; prompt: string; extensions: string; sort_order: number }>(
    'SELECT type, title, prompt, extensions, sort_order FROM domain_comments WHERE year=? AND semester=? AND grade=? AND subject=? AND domain_name=? ORDER BY sort_order, id',
    [year, semester, grade, subject, domainName]
  );
  const evalItems = await queryAll<{ name: string; score: string; item_type: string; rubric: string; sort_order: number }>(
    'SELECT name, score, item_type, rubric, sort_order FROM domain_eval WHERE year=? AND semester=? AND grade=? AND subject=? AND domain_name=? ORDER BY sort_order, id',
    [year, semester, grade, subject, domainName]
  );
  const aiPrompts = await queryAll<{ prompt_key: string; prompt: string }>(
    'SELECT prompt_key, prompt FROM domain_ai_prompts WHERE year=? AND semester=? AND grade=? AND subject=? AND domain_name=? ORDER BY prompt_key',
    [year, semester, grade, subject, domainName]
  );
  const comprehensiveItems = await queryAll<{ type: string; title: string; prompt: string; extensions: string; sort_order: number }>(
    `SELECT type, title, prompt, extensions, sort_order FROM domain_comments
     WHERE year=? AND semester=? AND grade=? AND subject=?
       AND domain_name='__SUBJECT_COMPREHENSIVE__' AND type IN ('세특', '종합')
     ORDER BY sort_order, id`,
    [year, semester, grade, subject]
  );

  const standards = wb.addWorksheet('성취평가기준');
  standards.addRow(['sort_order', 'domain_name_ref', 'code', 'content']);
  commentsItems.filter(item => item.type === '성취기준').forEach((item, index) => {
    let ref = { domain_name_ref: '', code: item.title, content: '' };
    try { const p = JSON.parse(item.extensions || '{}'); ref = { domain_name_ref: p.domain_name_ref || '', code: p.code || item.title, content: p.content || '' }; } catch { /* use fallback */ }
    standards.addRow([item.sort_order ?? index, ref.domain_name_ref, ref.code, ref.content]);
  });

  const evalSheet = wb.addWorksheet('채점기준');
  evalSheet.addRow(['sort_order', 'item_type', 'name', 'score', 'rubric']);
  evalItems.forEach((item, index) => evalSheet.addRow([item.sort_order ?? index, item.item_type, item.name, item.score, item.rubric]));

  const commentsSheet = wb.addWorksheet('기록기준');
  commentsSheet.addRow(['sort_order', 'type', 'title', 'prompt', 'extensions']);
  const recordItems = domainName === '__SUBJECT_COMPREHENSIVE__'
    ? []
    : commentsItems.filter(item => item.type !== '성취기준');
  recordItems.forEach((item, index) => {
    commentsSheet.addRow([item.sort_order ?? index, item.type, item.title, item.prompt, item.extensions]);
  });

  const comprehensiveSheet = wb.addWorksheet('세특기준');
  comprehensiveSheet.addRow(['sort_order', 'type', 'title', 'prompt', 'extensions']);
  comprehensiveItems.slice(0, 1).forEach((item, index) => {
    comprehensiveSheet.addRow([item.sort_order ?? index, '세특', '세특', item.prompt, item.extensions]);
  });

  const promptSheet = wb.addWorksheet('AI요청');
  promptSheet.addRow(['prompt_key', 'prompt']);
  aiPrompts.forEach(item => {
    promptSheet.addRow([item.prompt_key, item.prompt]);
  });

  formatConfigWorkbook(wb);

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  const safeDomain = domainName === '__SUBJECT_COMPREHENSIVE__' ? '세특' : domainName;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${safeDownloadName(`${year}_${semester}_${grade}_${subject}_${safeDomain}_기준.xlsx`)}`);
  res.send(buffer);
});

router.post('/domain-config/upload', tempUpload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });

  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(req.file.path);

    const metaSheet = wb.getWorksheet('기본정보');
    const meta: Record<string, string> = {};
    if (metaSheet) {
      metaSheet.eachRow((row) => {
        const key = cellText(row.getCell(1).value);
        if (!key) return;
        meta[key] = cellText(row.getCell(2).value);
      });
    }

    const year = Number(req.body.year || meta['학년도']);
    const semester = Number(req.body.semester || meta['학기']);
    const grade = Number(req.body.grade || meta['학년']);
    const subject = String(req.body.subject || meta['과목'] || '').trim();
    const domainName = String(req.body.domainName || meta['영역'] || '__SUBJECT_COMPREHENSIVE__').trim();

    if (!year || !semester || !grade || !subject) {
      return res.status(400).json({ error: '기본정보 시트에서 학년도, 학기, 학년, 과목을 찾을 수 없습니다.' });
    }

    const standardRows: { domain_name_ref: string; code: string; content: string; sort_order: number }[] = [];
    const standards = wb.getWorksheet('성취평가기준');
    if (standards) {
      const h = headerMap(standards.getRow(1));
      standards.eachRow((row, rowNum) => {
        if (rowNum === 1) return;
        const code = cellText(row.getCell(h.code).value);
        if (!code) return;
        standardRows.push({
          sort_order: Number(cellText(row.getCell(h.sort_order).value)) || standardRows.length,
          domain_name_ref: cellText(row.getCell(h.domain_name_ref).value),
          code,
          content: cellText(row.getCell(h.content).value),
        });
      });
    }

    const evalRows: { name: string; score: string; item_type: string; rubric: string; sort_order: number }[] = [];
    const evalSheet = wb.getWorksheet('채점기준');
    if (evalSheet) {
      const h = headerMap(evalSheet.getRow(1));
      evalSheet.eachRow((row, rowNum) => {
        if (rowNum === 1) return;
        const name = cellText(row.getCell(h.name).value);
        const itemType = cellText(row.getCell(h.item_type).value) || 'llm';
        if (!name && itemType !== 'formula') return;
        evalRows.push({
          sort_order: Number(cellText(row.getCell(h.sort_order).value)) || evalRows.length,
          item_type: itemType,
          name: name || '합계',
          score: cellText(row.getCell(h.score ?? h.excel_col).value),
          rubric: cellText(row.getCell(h.rubric).value),
        });
      });
    }

    type ImportedCommentRow = {
      type: string; title: string; prompt: string; extensions: string; sort_order: number;
    };
    const parseCommentRows = (sheet?: ExcelJS.Worksheet): ImportedCommentRow[] => {
      const parsed: ImportedCommentRow[] = [];
      if (sheet) {
        const h = headerMap(sheet.getRow(1));
        sheet.eachRow((row, rowNum) => {
          if (rowNum === 1) return;
          const type = cellText(row.getCell(h.type).value) || '항목';
          const title = cellText(row.getCell(h.title).value);
          const prompt = cellText(row.getCell(h.prompt).value);
          if (!title && !prompt) return;
          parsed.push({
            sort_order: Number(cellText(row.getCell(h.sort_order).value)) || parsed.length,
            type,
            title,
            prompt,
            extensions: cellText(row.getCell(h.extensions).value),
          });
        });
      }
      return parsed;
    };

    const recordSheet = wb.getWorksheet('기록기준');
    const legacyOrComprehensiveSheet = wb.getWorksheet('세특기준');
    // 이전 파일은 영역의 기록 기준을 '세특기준'이라는 이름으로 저장했다.
    const commentsRows = parseCommentRows(
      recordSheet || (domainName !== '__SUBJECT_COMPREHENSIVE__' ? legacyOrComprehensiveSheet : undefined)
    );
    const hasComprehensiveSheet = Boolean(
      recordSheet ? legacyOrComprehensiveSheet : domainName === '__SUBJECT_COMPREHENSIVE__' ? legacyOrComprehensiveSheet : undefined
    );
    const comprehensiveRows = parseCommentRows(
      recordSheet
        ? legacyOrComprehensiveSheet
        : domainName === '__SUBJECT_COMPREHENSIVE__'
          ? legacyOrComprehensiveSheet
          : undefined
    );
    const importedComprehensiveItem = comprehensiveRows.find(row => row.type === '세특')
      ?? comprehensiveRows.find(row => row.type === '종합')
      ?? comprehensiveRows[0];

    const aiPromptRows: { prompt_key: string; prompt: string }[] = [];
    const aiPromptSheet = wb.getWorksheet('AI요청');
    if (aiPromptSheet) {
      const h = headerMap(aiPromptSheet.getRow(1));
      aiPromptSheet.eachRow((row, rowNum) => {
        if (rowNum === 1) return;
        const promptKey = cellText(row.getCell(h.prompt_key).value);
        const prompt = cellText(row.getCell(h.prompt).value);
        if (!promptKey && !prompt) return;
        aiPromptRows.push({ prompt_key: promptKey, prompt });
      });
    }

    await transaction(async () => {
      await execute('DELETE FROM domain_comments WHERE year=? AND semester=? AND grade=? AND subject=? AND domain_name=?', [year, semester, grade, subject, domainName]);
      await execute('DELETE FROM domain_eval WHERE year=? AND semester=? AND grade=? AND subject=? AND domain_name=?', [year, semester, grade, subject, domainName]);
      await execute('DELETE FROM domain_ai_prompts WHERE year=? AND semester=? AND grade=? AND subject=? AND domain_name=?', [year, semester, grade, subject, domainName]);
      if (domainName !== '__SUBJECT_COMPREHENSIVE__' && hasComprehensiveSheet) {
        await execute(
          `DELETE FROM domain_comments
           WHERE year=? AND semester=? AND grade=? AND subject=? AND domain_name='__SUBJECT_COMPREHENSIVE__'`,
          [year, semester, grade, subject]
        );
      }

      const existingSubject = await queryOne(
        `SELECT 1 as found FROM (
           SELECT 1 FROM subject_domains WHERE year=? AND semester=? AND grade=? AND subject=?
           UNION ALL
           SELECT 1 FROM custom_domains WHERE year=? AND semester=? AND grade=? AND subject=?
         ) LIMIT 1`,
        [year, semester, grade, subject, year, semester, grade, subject]
      );
      if (!existingSubject && domainName === '__SUBJECT_COMPREHENSIVE__') {
        await execute(
          `INSERT INTO subject_domains(year, semester, grade, subject, credit, eval_type, name, reflected, ratio, max_score, sort_order, source_filename)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
          [year, semester, grade, subject, 0, '', '', 'X', 0, 0, -1, '']
        );
      }

      if (domainName !== '__SUBJECT_COMPREHENSIVE__') {
        const existingDomain = await queryOne(
          `SELECT 1 as found FROM (
             SELECT 1 FROM subject_domains
             WHERE year=? AND semester=? AND grade=? AND subject=? AND name=?
             UNION ALL
             SELECT 1 FROM custom_domains
             WHERE year=? AND semester=? AND grade=? AND subject=? AND name=?
           ) LIMIT 1`,
          [year, semester, grade, subject, domainName, year, semester, grade, subject, domainName]
        );
        if (!existingDomain) {
          await execute(
            'INSERT INTO custom_domains(year, semester, grade, subject, name) VALUES(?,?,?,?,?)',
            [year, semester, grade, subject, domainName]
          );
        }
      }

      for (const [index, row] of standardRows.entries()) {
        const extensions = JSON.stringify({
          domain_name_ref: row.domain_name_ref,
          code: row.code,
          content: row.content,
        });
        await execute(
          'INSERT INTO domain_comments(year, semester, grade, subject, domain_name, type, title, prompt, extensions, sort_order) VALUES(?,?,?,?,?,?,?,?,?,?)',
          [year, semester, grade, subject, domainName, '성취기준', row.code, '', extensions, row.sort_order ?? index]
        );
      }
      const normalizedCommentsRows = domainName === '__SUBJECT_COMPREHENSIVE__'
        ? importedComprehensiveItem
          ? [{ ...importedComprehensiveItem, type: '세특', title: '세특', sort_order: 0 }]
          : []
        : commentsRows;
      for (const [index, row] of normalizedCommentsRows.entries()) {
        await execute(
          'INSERT INTO domain_comments(year, semester, grade, subject, domain_name, type, title, prompt, extensions, sort_order) VALUES(?,?,?,?,?,?,?,?,?,?)',
          [year, semester, grade, subject, domainName, row.type, row.title, row.prompt, row.extensions, row.sort_order ?? standardRows.length + index]
        );
      }
      if (domainName !== '__SUBJECT_COMPREHENSIVE__' && hasComprehensiveSheet && importedComprehensiveItem) {
        await execute(
          'INSERT INTO domain_comments(year, semester, grade, subject, domain_name, type, title, prompt, extensions, sort_order) VALUES(?,?,?,?,?,?,?,?,?,?)',
          [year, semester, grade, subject, '__SUBJECT_COMPREHENSIVE__', '세특', '세특', importedComprehensiveItem.prompt, importedComprehensiveItem.extensions, 0]
        );
      }
      for (const [index, row] of evalRows.entries()) {
        await execute(
          'INSERT INTO domain_eval(year, semester, grade, subject, domain_name, name, score, item_type, rubric, sort_order) VALUES(?,?,?,?,?,?,?,?,?,?)',
          [year, semester, grade, subject, domainName, row.name, row.score, row.item_type === 'formula' ? 'formula' : 'llm', row.rubric, row.sort_order ?? index]
        );
      }
      for (const row of aiPromptRows) {
        await execute(
          'INSERT OR REPLACE INTO domain_ai_prompts(year, semester, grade, subject, domain_name, prompt_key, prompt, updated_at) VALUES(?,?,?,?,?,?,?,datetime(\'now\'))',
          [year, semester, grade, subject, domainName, row.prompt_key, row.prompt]
        );
      }
    });

    res.json({
      ok: true,
      kind: 'domain',
      year,
      semester,
      grade,
      subject,
      domainName,
      standards: standardRows.length,
      comments: commentsRows.length,
      comprehensive: importedComprehensiveItem ? 1 : 0,
      eval: evalRows.length,
      prompts: aiPromptRows.length,
    });
  } catch (e: unknown) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  } finally {
    try { if (req.file?.path) fs.unlinkSync(req.file.path); } catch { /* ignore */ }
  }
});

export default router;
