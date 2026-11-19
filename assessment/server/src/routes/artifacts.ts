import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import * as unzipper from 'unzipper';
import * as cheerio from 'cheerio';
import { queryOne, queryAll } from '../services/db';
import { assignmentExecute, assignmentQueryAll, assignmentQueryOne, assignmentTransaction } from '../services/assignmentDb';
import { assignmentArtifactSummaryForStudent } from '../services/assignmentArtifacts';
import { UPLOADS_DIR, ensureDir, moveFileToTrash, restoreTrashedFile, toStoredPath } from '../services/storage';
import { decodeUploadFilename } from '../services/filename';
import { entriesFromImportSource, entryFilename } from '../services/importEntries';
import { ArtifactImportService, parseBulkExistingPolicy, preflightArtifactImports } from '../services/artifactImportService';
import { storedArtifactFilename } from '../services/artifactStorageFilename';
import { artifactContentType, sendArtifactFile } from '../services/artifactFileResponse';

const router = Router();

const UPLOAD_DIR = path.join(UPLOADS_DIR, 'artifacts');
const TEMP_DIR = path.join(UPLOADS_DIR, 'temp');
[UPLOAD_DIR, TEMP_DIR].forEach(ensureDir);

const upload = multer({ dest: TEMP_DIR, limits: { fileSize: 200 * 1024 * 1024 } });

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function safePathSegment(value: string): string {
  return value
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim() || '_';
}

function uniqueArtifactPath(
  baseDir: string,
  student: { student_num: number; name: string },
  filename: string,
): string {
  let candidate = path.join(baseDir, storedArtifactFilename(student.student_num, student.name, filename));
  while (fs.existsSync(candidate)) {
    candidate = path.join(baseDir, storedArtifactFilename(student.student_num, student.name, filename));
  }
  return candidate;
}

type ExistingBulkArtifact = {
  id: number;
  filepath: string;
  source: 'artifact' | 'assignment';
  studentId: number;
};

async function existingBulkArtifacts(
  classId: number | string,
  domain: string,
  students: Array<{ id: number; student_num: number; name: string }>,
  matchedStudentIds: Set<number>,
): Promise<ExistingBulkArtifact[]> {
  if (!matchedStudentIds.size) return [];
  const targetStudents = students.filter(student => matchedStudentIds.has(student.id));
  const studentIds = targetStudents.map(student => student.id);
  const placeholders = studentIds.map(() => '?').join(',');
  const manual = await assignmentQueryAll<{ id: number; filepath: string; assessment_student_id: number }>(
    `SELECT id, filepath, assessment_student_id
     FROM assignment_artifacts
     WHERE domain=? AND assessment_student_id IN (${placeholders})`,
    [domain, ...studentIds]
  );
  const submitted = await assignmentQueryAll<{
    id: number;
    filepath: string;
    assessment_student_id: number;
    student_num: number;
    name: string;
  }>(
    `SELECT sub.id, sub.filepath, COALESCE(ast.assessment_student_id, 0) AS assessment_student_id,
            sub.student_num, sub.name
     FROM assignment_submissions sub
     JOIN assignment_runs run ON run.id=sub.run_id
     JOIN assignment_configs cfg ON cfg.id=run.config_id
     JOIN assignment_classes ac ON ac.id=run.assignment_class_id
     LEFT JOIN assignment_students ast ON ast.id=sub.assignment_student_id
     WHERE cfg.domain_name=? AND ac.assessment_class_id=?
       AND sub.status='accepted' AND sub.submission_slot_id!=''`,
    [domain, classId]
  );
  const targetById = new Map(targetStudents.map(student => [student.id, student]));
  const targetByIdentity = new Map(targetStudents.map(student => [`${student.student_num}::${student.name}`, student.id]));
  return [
    ...manual.map(row => ({
      id: Number(row.id),
      filepath: String(row.filepath || ''),
      source: 'artifact' as const,
      studentId: Number(row.assessment_student_id),
    })),
    ...submitted.flatMap(row => {
      const linkedId = Number(row.assessment_student_id);
      const studentId = targetById.has(linkedId)
        ? linkedId
        : targetByIdentity.get(`${row.student_num}::${row.name}`);
      return studentId ? [{
        id: Number(row.id),
        filepath: String(row.filepath || ''),
        source: 'assignment' as const,
        studentId,
      }] : [];
    }),
  ];
}

// HWPX → HTML 변환
async function hwpxToHtml(buffer: Buffer): Promise<string> {
  const dir = await unzipper.Open.buffer(buffer);

  let xmlEntry = dir.files.find(f => f.path === 'Contents/section0.xml');
  if (!xmlEntry) xmlEntry = dir.files.find(f => f.path.toLowerCase().endsWith('section0.xml'));
  if (!xmlEntry) throw new Error('HWPX: section0.xml을 찾을 수 없습니다.');

  const xmlContent = (await xmlEntry.buffer()).toString('utf8');
  const $ = cheerio.load(xmlContent, { xmlMode: true });

  // 첫 번째 표의 첫 행 삭제
  $('hp\\:tbl').first().find('hp\\:tr').first().remove();

  // hp:run → <span style="...">text</span>
  function renderRun(run: any): string {
    const text = $(run).find('hp\\:t').map((_: number, t: any) => $(t).text()).get().join('');
    if (!text) return '';

    const charPr = $(run).find('hp\\:charPr').first();
    const styles: string[] = [];

    // Bold: <hp:bold/> 또는 <hp:bold val="1"/> 또는 속성 bold="1"
    const boldEl = charPr.find('hp\\:bold');
    if (boldEl.length && boldEl.attr('val') !== '0') styles.push('font-weight:bold');
    if (!boldEl.length && (charPr.attr('bold') === '1' || charPr.attr('bold') === 'true')) styles.push('font-weight:bold');

    // Italic
    const italicEl = charPr.find('hp\\:italic');
    if (italicEl.length && italicEl.attr('val') !== '0') styles.push('font-style:italic');
    if (!italicEl.length && (charPr.attr('italic') === '1' || charPr.attr('italic') === 'true')) styles.push('font-style:italic');

    // Underline
    const ulEl = charPr.find('hp\\:underline');
    const ulVal = ulEl.attr('val') ?? charPr.attr('underline') ?? '';
    if (ulVal && ulVal !== 'none' && ulVal !== '0' && ulVal !== 'false') styles.push('text-decoration:underline');

    // Strikeout
    const soEl = charPr.find('hp\\:strikeout');
    if (soEl.length && soEl.attr('val') !== 'none' && soEl.attr('val') !== '0') styles.push('text-decoration:line-through');

    // Font color: <hp:fontColor val="RRGGBB"/> 또는 속성
    const colorEl = charPr.find('hp\\:fontColor');
    const colorVal = (colorEl.attr('val') ?? charPr.attr('fontColor') ?? '').replace(/^#/, '');
    if (colorVal && !/^0{6}$/i.test(colorVal) && !/^f{6}$/i.test(colorVal)) {
      styles.push(`color:#${colorVal}`);
    }

    // Font size: HWP는 0.1pt 단위로 저장 (예: 100 = 10pt)
    const sizeEl = charPr.find('hp\\:fontSize');
    const sizeVal = sizeEl.attr('val') ?? charPr.attr('fontSize') ?? '';
    if (sizeVal) {
      const pt = Math.round(parseInt(sizeVal) / 10);
      if (pt > 0 && pt !== 10) styles.push(`font-size:${pt}pt`);
    }

    const styleAttr = styles.length ? ` style="${styles.join(';')}"` : '';
    return `<span${styleAttr}>${escHtml(text)}</span>`;
  }

  // hp:p → <p style="...">...</p>
  function renderPara(p: any): string {
    const paraPr = $(p).find('hp\\:paraPr').first();
    const styles: string[] = [];

    // 정렬
    const jc = paraPr.find('hp\\:jc').attr('val') ?? paraPr.attr('align') ?? '';
    if (jc === 'center') styles.push('text-align:center');
    else if (jc === 'right') styles.push('text-align:right');
    else if (jc === 'justify' || jc === 'distribute') styles.push('text-align:justify');

    // 들여쓰기
    const indent = paraPr.find('hp\\:ind').attr('left') ?? '';
    if (indent) {
      const indPt = Math.round(parseInt(indent) / 100);
      if (indPt > 0) styles.push(`padding-left:${indPt}pt`);
    }

    let content = '';
    $(p).children('hp\\:run').each((_: number, run: any) => { content += renderRun(run); });
    // hp:ctrl 내부 텍스트도 수집 (탭, 특수문자 등)
    $(p).children('hp\\:ctrl').each((_: number, ctrl: any) => {
      const t = $(ctrl).find('hp\\:t').map((_: number, el: any) => $(el).text()).get().join('');
      if (t.trim()) content += escHtml(t);
    });

    if (!content.trim()) return '<p>&nbsp;</p>';
    const styleAttr = styles.length ? ` style="${styles.join(';')}"` : '';
    return `<p${styleAttr}>${content}</p>\n`;
  }

  // hp:tc → <td colspan rowspan>...</td>
  function renderCell(tc: any): string {
    // colspan/rowspan: 속성 또는 자식 hp:cellSpan
    let colSpan = parseInt($(tc).attr('colSpan') ?? $(tc).attr('colspan') ?? '1') || 1;
    let rowSpan = parseInt($(tc).attr('rowSpan') ?? $(tc).attr('rowspan') ?? '1') || 1;
    const spanEl = $(tc).find('hp\\:cellSpan').first();
    if (spanEl.length) {
      colSpan = parseInt(spanEl.attr('colSpan') ?? spanEl.attr('colspan') ?? String(colSpan)) || colSpan;
      rowSpan = parseInt(spanEl.attr('rowSpan') ?? spanEl.attr('rowspan') ?? String(rowSpan)) || rowSpan;
    }

    let content = '';
    $(tc).find('hp\\:subList > hp\\:p').each((_: number, p: any) => { content += renderPara(p); });
    if (!content) {
      // subList 없는 경우 직접 p 탐색
      $(tc).children('hp\\:p').each((_: number, p: any) => { content += renderPara(p); });
    }

    const attrs = [
      colSpan > 1 ? `colspan="${colSpan}"` : '',
      rowSpan > 1 ? `rowspan="${rowSpan}"` : '',
    ].filter(Boolean).join(' ');

    return `<td${attrs ? ' ' + attrs : ''}>${content || '&nbsp;'}</td>`;
  }

  let bodyHtml = '';

  $('hp\\:body hp\\:section').children().each((_: number, elem: any) => {
    const tagName = ((elem as any).tagName || '').toLowerCase();

    if (tagName === 'hp:p') {
      bodyHtml += renderPara(elem);
    } else if (tagName === 'hp:tbl') {
      bodyHtml += '<table>\n';
      $(elem).find('> hp\\:tr, hp\\:tblBody > hp\\:tr').each((_: number, tr: any) => {
        bodyHtml += '<tr>';
        $(tr).children('hp\\:tc').each((_: number, tc: any) => { bodyHtml += renderCell(tc); });
        bodyHtml += '</tr>\n';
      });
      bodyHtml += '</table>\n';
    }
  });

  // fallback
  if (!bodyHtml.trim()) {
    const allText = $('hp\\:t').map((_: number, t: any) => $(t).text()).get().filter((s: string) => s.trim()).join('\n');
    bodyHtml = `<pre>${escHtml(allText)}</pre>`;
  }

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
body { font-family: '맑은 고딕', 'Malgun Gothic', sans-serif; line-height: 1.8; padding: 24px; font-size: 11pt; color: #111; }
table { border-collapse: collapse; width: 100%; margin: 10px 0; }
td, th { border: 1px solid #888; padding: 5px 8px; vertical-align: top; }
p { margin: 0.15em 0; }
pre { white-space: pre-wrap; font-family: inherit; }
</style>
</head>
<body>
${bodyHtml || '<p>(내용 없음)</p>'}
</body>
</html>`;
}

// ── 개별 파일 업로드 ──────────────────────────────────────────────────────────
router.post('/student/:studentId', upload.array('files', 20), async (req: Request, res: Response) => {
  const files = req.files as Express.Multer.File[];
  if (!files?.length) return res.status(400).json({ error: '파일이 없습니다.' });

  const domain = (req.body.domain as string) || '';
  const student = await queryOne<{
    id: number;
    student_num: number;
    name: string;
    year: number;
    semester: number;
    grade: number;
    subject: string;
    room: string;
  }>(
    `SELECT cs.id, cs.student_num, cs.name, c.year, c.semester, c.grade, c.subject, c.room
     FROM class_students cs
     JOIN classes c ON c.id = cs.class_id
     WHERE cs.id=?`,
    [req.params.studentId]
  );
  if (!student) {
    for (const file of files) {
      try { if (file.path) fs.unlinkSync(file.path); } catch {}
    }
    return res.status(404).json({ error: '학생을 찾을 수 없습니다.' });
  }

  const uploadNames = files.map(file => decodeUploadFilename(file.originalname).normalize('NFC'));

  const baseUploadDir = path.join(
    UPLOAD_DIR,
    String(student.year),
    String(student.semester),
    String(student.grade),
    safePathSegment(student.subject),
    safePathSegment(student.room),
    safePathSegment(domain)
  );
  fs.mkdirSync(baseUploadDir, { recursive: true });

  const inserted: Array<{ id: number; filename: string; filepath: string }> = [];
  const movedPaths: string[] = [];

  try {
    for (const [index, file] of files.entries()) {
      const origName = uploadNames[index];

      const finalPath = uniqueArtifactPath(baseUploadDir, student, origName);
      const finalName = origName;
      const mimeType = artifactContentType(origName, file.mimetype);

      fs.renameSync(file.path, finalPath);
      movedPaths.push(finalPath);
      const r = await assignmentExecute(
        `INSERT INTO assignment_artifacts(assessment_student_id, domain, filename, filepath, mime_type, size)
         VALUES(?,?,?,?,?,?)`,
        [req.params.studentId, domain, finalName, toStoredPath(finalPath), mimeType, file.size || 0]
      );
      inserted.push({ id: Number(r.lastInsertRowid), filename: finalName, filepath: finalPath });
    }
    res.json({
      uploaded: inserted.length,
      artifacts: inserted,
      storageDir: baseUploadDir,
      message: `${inserted.length}개 파일을 업로드했습니다.`,
    });
  } catch (e: any) {
    for (const row of inserted) {
      try { await assignmentExecute('DELETE FROM assignment_artifacts WHERE id=?', [row.id]); } catch {}
    }
    for (const file of files) {
      try { if (file.path && fs.existsSync(file.path)) fs.unlinkSync(file.path); } catch {}
    }
    for (const movedPath of movedPaths) {
      try { if (fs.existsSync(movedPath)) fs.unlinkSync(movedPath); } catch {}
    }
    res.status(500).json({ error: e.message });
  }
});

// ── 도메인별 산출물 조회 ───────────────────────────────────────────────────────
router.get('/student/:studentId/domain/:domain', async (req: Request, res: Response) => {
  res.json(await assignmentArtifactSummaryForStudent(req.params.studentId, req.params.domain));
});

// ── 일괄 산출물 업로드 (ZIP 또는 폴더) ─────────────────────────────────────────
router.post('/bulk-upload/:classId', upload.single('file'), async (req: Request, res: Response) => {
  const folderPath = String(req.body.folderPath || '');
  if (!req.file && !folderPath) return res.status(400).json({ error: 'ZIP 파일 또는 폴더가 필요합니다.' });
  const { classId } = req.params;
  const domain = req.body.domain || '';

  try {
    const cls = await queryOne<{ year: number; semester: number; grade: number; subject: string; room: string }>(
      'SELECT * FROM classes WHERE id=?', [classId]
    );
    if (!cls) throw new Error('수업을 찾을 수 없습니다.');

    const students = await queryAll<{ id: number; student_num: number; name: string }>(
      'SELECT id, student_num, name FROM class_students WHERE class_id=?', [classId]
    );

    const importEntries = await entriesFromImportSource({ zipPath: req.file?.path, folderPath });
    const baseUploadDir = path.join(
      UPLOAD_DIR, String(cls.year), String(cls.semester), String(cls.grade), cls.subject, cls.room, domain
    );
    fs.mkdirSync(baseUploadDir, { recursive: true });

    const preflightMatches = preflightArtifactImports(importEntries, students, (_entry, filename) => !filename.startsWith('.'));
    const matchedStudentIds = new Set(preflightMatches.flatMap(item => item.matches.length === 1 ? [item.matches[0].id] : []));
    const existing = await existingBulkArtifacts(classId, domain, students, matchedStudentIds);
    const existingStudentIds = new Set(existing.map(item => item.studentId));
    const existingPolicy = parseBulkExistingPolicy(req.body.existingPolicy);
    if (existing.length && !existingPolicy) {
      if (req.file) fs.unlinkSync(req.file.path);
      const conflictStudents = students
        .filter(student => existingStudentIds.has(student.id))
        .map(student => ({
          studentId: student.id,
          studentNum: student.student_num,
          name: student.name,
          existingCount: existing.filter(item => item.studentId === student.id).length,
        }));
      const results = preflightMatches.map(item => {
        if (item.matches.length === 0) {
          return { path: item.path, filename: item.filename, status: 'unmatched', reason: '경로에서 학번·이름을 찾지 못했습니다.' };
        }
        if (item.matches.length > 1) {
          return {
            path: item.path,
            filename: item.filename,
            status: 'conflict',
            reason: `여러 학생과 일치: ${item.matches.map(student => `${student.student_num}${student.name}`).join(', ')}`,
          };
        }
        const student = item.matches[0];
        const hasExisting = existingStudentIds.has(student.id);
        return {
          path: item.path,
          filename: item.filename,
          status: hasExisting ? 'existing' : 'ready',
          studentId: student.id,
          student: `${student.student_num}${student.name}`,
          reason: hasExisting
            ? `기존 산출물 ${existing.filter(existingItem => existingItem.studentId === student.id).length}개가 있습니다.`
            : '등록할 수 있습니다.',
        };
      });
      return res.status(409).json({
        conflict: 'existing_artifacts',
        message: `기존 산출물이 있는 학생 ${conflictStudents.length}명이 발견되었습니다. 처리 방법을 선택하세요.`,
        total: preflightMatches.length,
        existingStudentCount: conflictStudents.length,
        existingArtifactCount: existing.length,
        readyCount: results.filter(item => item.status === 'ready').length,
        unmatchedCount: results.filter(item => item.status === 'unmatched').length,
        conflictCount: results.filter(item => item.status === 'conflict').length,
        results,
        students: conflictStudents,
      });
    }

    let count = 0;
    const newPaths: string[] = [];
    const sampleFilenames = importEntries.map(entryFilename).filter(filename => filename && !filename.startsWith('.')).slice(0, 5);
    const importer = new ArtifactImportService(students, {
      include: (_entry, filename) => !filename.startsWith('.'),
      studentResult: student => ({ studentId: student.id, student: `${student.student_num}${student.name}` }),
      resolve: async context => existingPolicy === 'skip' && existingStudentIds.has(context.student.id)
        ? {
            kind: 'result' as const,
            result: {
              path: context.path,
              status: 'unchanged' as const,
              studentId: context.student.id,
              student: `${context.student.student_num}${context.student.name}`,
              filename: context.filename,
              reason: '기존 산출물을 유지하고 새 파일을 건너뛰었습니다.',
            },
          }
        : { kind: 'read' as const, target: undefined },
      store: async context => {
        const decodedName = context.path.split(/[/\\]/).pop() || context.filename.normalize('NFC');
        const savePath = uniqueArtifactPath(baseUploadDir, context.student, decodedName);
        fs.writeFileSync(savePath, context.buffer);
        const ct = artifactContentType(decodedName);
        try {
          await assignmentExecute(
            `INSERT INTO assignment_artifacts(assessment_student_id, domain, filename, filepath,mime_type,size)
             VALUES(?,?,?,?,?,?)`,
            [context.student.id, domain, decodedName, toStoredPath(savePath), ct, context.buffer.length]
          );
        } catch (error) {
          try { fs.unlinkSync(savePath); } catch {}
          throw error;
        }
        newPaths.push(savePath);
        count += 1;
        return { path: context.path, status: 'uploaded' as const, studentId: context.student.id, student: `${context.student.student_num}${context.student.name}`, filename: decodedName };
      },
    });
    const movedFiles: Array<{ trashPath: string; originalFilepath: string }> = [];
    let imported;
    if (existingPolicy === 'replace' && existing.length) {
      try {
        imported = await assignmentTransaction(async () => {
          const result = await importer.run(importEntries);
          const failed = result.results.find(item => item.status === 'read_error');
          if (failed) throw new Error(failed.reason || '새 산출물 파일을 저장하지 못했습니다.');

          const movedPaths = new Set<string>();
          for (const item of existing) {
            if (!item.filepath || movedPaths.has(item.filepath)) continue;
            movedPaths.add(item.filepath);
            const trashPath = moveFileToTrash(item.filepath, 'bulk-replaced-artifacts');
            if (trashPath) movedFiles.push({ trashPath, originalFilepath: item.filepath });
          }
          const artifactIds = existing.filter(item => item.source === 'artifact').map(item => item.id);
          const submissionIds = existing.filter(item => item.source === 'assignment').map(item => item.id);
          if (artifactIds.length) {
            await assignmentExecute(
              `DELETE FROM assignment_artifacts WHERE id IN (${artifactIds.map(() => '?').join(',')})`,
              artifactIds
            );
          }
          if (submissionIds.length) {
            await assignmentExecute(
              `DELETE FROM assignment_submissions WHERE id IN (${submissionIds.map(() => '?').join(',')})`,
              submissionIds
            );
          }
          return result;
        });
      } catch (error) {
        for (const newPath of newPaths) {
          try { if (fs.existsSync(newPath)) fs.unlinkSync(newPath); } catch {}
        }
        for (const moved of movedFiles.reverse()) {
          try { restoreTrashedFile(moved.trashPath, moved.originalFilepath); } catch {}
        }
        throw error;
      }
    } else {
      imported = await importer.run(importEntries);
    }
    const results = imported.results;

    if (req.file) fs.unlinkSync(req.file.path);

    let message = `총 ${count}개의 산출물 파일이 성공적으로 연동되었습니다.`;
    if (count === 0 && imported.total > 0) {
      message += ` (선택 항목에서 ${imported.total}개 파일 발견, DB 학생 ${students.length}명과 매칭 없음. 파일 경로에 "학번(5자리)+이름" 패턴이 있어야 합니다. 파일명 예시: ${sampleFilenames.join(', ')})`;
    }

    res.json({
      message,
      count,
      total: imported.total,
      studentCount: new Set(results.filter(result => result.status === 'uploaded').map(result => result.studentId)).size,
      skippedCount: results.filter(result => result.status === 'unchanged').length,
      unmatchedCount: results.filter(result => result.status === 'unmatched').length,
      conflictCount: results.filter(result => result.status === 'conflict').length,
      errorCount: results.filter(result => result.status === 'read_error').length,
      results,
    });
  } catch (error: any) {
    try { if (req.file) fs.unlinkSync(req.file.path); } catch {}
    res.status(500).json({ error: error.message });
  }
});

// ── 파일 서빙 ──────────────────────────────────────────────────────────────────
router.get('/:id', async (req: Request, res: Response) => {
  const artifact = await assignmentQueryOne(
    'SELECT id, filename, filepath, mime_type, domain, uploaded_at FROM assignment_artifacts WHERE id=?',
    [req.params.id]
  );
  if (!artifact) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
  res.json(artifact);
});

router.get('/:id/file', async (req: Request, res: Response) => {
  const artifact = await assignmentQueryOne<{ filename: string; filepath: string; mime_type: string }>(
    'SELECT filename, filepath, mime_type FROM assignment_artifacts WHERE id=?', [req.params.id]
  );
  if (!artifact) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
  sendArtifactFile(res, artifact);
});

// ── 파일 삭제 ──────────────────────────────────────────────────────────────────
router.delete('/:id', async (req: Request, res: Response) => {
  const artifact = await assignmentQueryOne<{ filepath: string }>(
    'SELECT filepath FROM assignment_artifacts WHERE id=?', [req.params.id]
  );
  if (!artifact) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
  let trashPath = '';
  try {
    trashPath = moveFileToTrash(artifact.filepath, 'teacher-deleted-artifacts');
    await assignmentExecute('DELETE FROM assignment_artifacts WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch (e: unknown) {
    try { restoreTrashedFile(trashPath, artifact.filepath); } catch {}
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

export default router;
