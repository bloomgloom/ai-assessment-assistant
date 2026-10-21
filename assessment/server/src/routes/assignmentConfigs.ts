import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { assignmentExecute, assignmentQueryAll, assignmentQueryOne, assignmentTransaction } from '../services/assignmentDb';
import { queryAll, queryOne } from '../services/db';
import { UPLOADS_DIR, ensureDir, moveFileToTrash, resolveStoredPath, restoreTrashedFile, toStoredPath } from '../services/storage';
import { decodeUploadFilename } from '../services/filename';
import { fetchGithubSource, fetchGithubText, githubFetchUrl, remoteFilename } from '../services/remoteGithub';

const router = Router();
const RESOURCE_DIR = path.join(UPLOADS_DIR, 'assignment-resources');
ensureDir(RESOURCE_DIR);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, RESOURCE_DIR),
    filename: (_req, file, cb) => cb(null, `${Date.now()}_${decodeUploadFilename(file.originalname)}`),
  }),
  limits: { fileSize: 200 * 1024 * 1024 },
});

const PREVIEW_CONTENT_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ipynb': 'application/x-ipynb+json; charset=utf-8',
  '.py': 'text/x-python; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
};

function previewContentType(filename: string, mimeType = '') {
  if (mimeType && mimeType !== 'application/octet-stream') return mimeType;
  return PREVIEW_CONTENT_TYPES[path.extname(filename).toLowerCase()] || mimeType || 'application/octet-stream';
}

function code(): string {
  return crypto.randomBytes(8).toString('hex');
}

function scope(req: Request) {
  return {
    year: Number(req.query.year ?? req.body?.year),
    semester: Number(req.query.semester ?? req.body?.semester),
    grade: Number(req.query.grade ?? req.body?.grade),
    subject: String(req.query.subject ?? req.body?.subject ?? ''),
    domainName: String(req.query.domainName ?? req.body?.domainName ?? ''),
  };
}

function assertScope(s: ReturnType<typeof scope>, res: Response): boolean {
  if (!s.year || !s.semester || !s.grade || !s.subject || !s.domainName) {
    res.status(400).json({ error: '학년도, 학기, 학년, 과목, 영역이 필요합니다.' });
    return false;
  }
  return true;
}

function normalizeAllowedExtensions(value: string): string {
  try {
    const parsed = JSON.parse(value || '[]');
    if (Array.isArray(parsed)) {
      return JSON.stringify(
        parsed
          .map(item => ({
            extension: String(item.extension || item.ext || '').trim().replace(/^\./, '').toLowerCase(),
            max_file_size_mb: Math.max(1, Number(item.max_file_size_mb || item.maxFileSizeMb || 50)),
            max_files: Math.max(1, Number(item.max_files || item.maxFiles || 1)),
          }))
          .filter(item => item.extension)
          .filter((item, index, arr) => arr.findIndex(other => other.extension === item.extension) === index)
      );
    }
  } catch {
    // Legacy newline/comma separated extension list.
  }
  return String(value || '')
    .split(/[\s,]+/)
    .map(item => item.trim().replace(/^\./, '').toLowerCase())
    .filter(Boolean)
    .filter((item, index, arr) => arr.indexOf(item) === index)
    .join('\n');
}

async function ensureConfig(s: ReturnType<typeof scope>) {
  const existing = await assignmentQueryOne<{ id: number }>(
    `SELECT id FROM assignment_configs
     WHERE year=? AND semester=? AND grade=? AND subject=? AND domain_name=?`,
    [s.year, s.semester, s.grade, s.subject, s.domainName]
  );
  if (existing) return existing.id;

  const title = `${s.subject} ${s.domainName}`;
  const r = await assignmentExecute(
    `INSERT INTO assignment_configs(year, semester, grade, subject, domain_name, title, share_code, viewer_code)
     VALUES(?,?,?,?,?,?,?,?)`,
    [s.year, s.semester, s.grade, s.subject, s.domainName, title, code(), code()]
  );
  return Number(r.lastInsertRowid);
}

type AssessmentClassSnapshot = {
  id: number;
  year: number;
  semester: number;
  grade: number;
  subject: string;
  room: string;
};

type AssessmentStudentSnapshot = {
  id: number;
  student_num: number;
  name: string;
};

async function assessmentStudentsForClass(classId: number | string): Promise<AssessmentStudentSnapshot[]> {
  return queryAll<AssessmentStudentSnapshot>(
    'SELECT id, student_num, name FROM class_students WHERE class_id=? ORDER BY student_num, name',
    [classId]
  );
}

async function syncClassToAssignmentConfig(
  configId: number,
  cls: AssessmentClassSnapshot,
  students: AssessmentStudentSnapshot[]
): Promise<void> {
  if (!students.length) return;

  await assignmentTransaction(async () => {
    let assignmentClass = await assignmentQueryOne<{ id: number }>(
      'SELECT id FROM assignment_classes WHERE config_id=? AND assessment_class_id=?',
      [configId, cls.id]
    );
    if (!assignmentClass) {
      const r = await assignmentExecute(
        'INSERT INTO assignment_classes(config_id, assessment_class_id, room) VALUES(?,?,?)',
        [configId, cls.id, cls.room]
      );
      assignmentClass = { id: Number(r.lastInsertRowid) };
    } else {
      await assignmentExecute('UPDATE assignment_classes SET room=? WHERE id=?', [cls.room, assignmentClass.id]);
    }

    const existing = await assignmentQueryAll<{
      id: number;
      assessment_student_id: number;
      student_num: number;
      name: string;
    }>(
      `SELECT id, assessment_student_id, student_num, name
       FROM assignment_students WHERE assignment_class_id=?`,
      [assignmentClass.id]
    );
    const retainedIds = new Set<number>();

    for (const student of students) {
      const current = existing.find(row => Number(row.assessment_student_id) === Number(student.id))
        || existing.find(row => Number(row.student_num) === Number(student.student_num) && row.name === student.name);
      const classNum = Math.floor((Number(student.student_num) % 10000) / 100);
      const seatNum = Number(student.student_num) % 100;
      if (current) {
        await assignmentExecute(
          `UPDATE assignment_students
           SET assessment_student_id=?, student_num=?, class_num=?, seat_num=?, name=?
           WHERE id=?`,
          [student.id, student.student_num, classNum, seatNum, student.name, current.id]
        );
        retainedIds.add(Number(current.id));
      } else {
        const r = await assignmentExecute(
          `INSERT INTO assignment_students(assignment_class_id, assessment_student_id, student_num, class_num, seat_num, name)
           VALUES(?,?,?,?,?,?)`,
          [assignmentClass.id, student.id, student.student_num, classNum, seatNum, student.name]
        );
        retainedIds.add(Number(r.lastInsertRowid));
      }
    }

    for (const stale of existing.filter(row => !retainedIds.has(Number(row.id)))) {
      await assignmentExecute('DELETE FROM assignment_students WHERE id=?', [stale.id]);
    }
  });
}

export async function syncAssignmentSnapshotsForAssessmentClass(classId: number | string): Promise<void> {
  const cls = await queryOne<AssessmentClassSnapshot>(
    'SELECT id, year, semester, grade, subject, room FROM classes WHERE id=?',
    [classId]
  );
  if (!cls) return;

  const domains = await queryAll<{ name: string }>(
    `SELECT name
     FROM (
       SELECT name, sort_order
       FROM subject_domains
       WHERE year=? AND semester=? AND grade=? AND subject=? AND name!=''
         AND ((eval_type='수행' AND reflected='O') OR eval_type='기록')
       UNION ALL
       SELECT name, 100000 + id AS sort_order
       FROM custom_domains
       WHERE year=? AND semester=? AND grade=? AND subject=? AND name!=''
     )
     GROUP BY name
     ORDER BY MIN(sort_order), name`,
    [
      cls.year, cls.semester, cls.grade, cls.subject,
      cls.year, cls.semester, cls.grade, cls.subject,
    ]
  );
  const students = await assessmentStudentsForClass(cls.id);
  if (!students.length) return;

  for (const domain of domains) {
    const configId = await ensureConfig({
      year: cls.year,
      semester: cls.semester,
      grade: cls.grade,
      subject: cls.subject,
      domainName: domain.name,
    });
    await syncClassToAssignmentConfig(configId, cls, students);
  }
}

async function syncAssignmentSnapshotsForScope(s: ReturnType<typeof scope>, configId: number): Promise<void> {
  const classes = await queryAll<AssessmentClassSnapshot>(
    `SELECT c.id, c.year, c.semester, c.grade, c.subject, c.room
     FROM classes c
     WHERE c.year=? AND c.semester=? AND c.grade=? AND c.subject=?
       AND EXISTS (SELECT 1 FROM class_students student WHERE student.class_id=c.id)
     ORDER BY c.room, c.id`,
    [s.year, s.semester, s.grade, s.subject]
  );
  for (const cls of classes) {
    await syncClassToAssignmentConfig(configId, cls, await assessmentStudentsForClass(cls.id));
  }
}

export async function deleteAssignmentSnapshotForAssessmentClass(classId: number | string): Promise<void> {
  const rows = await assignmentQueryAll<{ id: number }>(
    'SELECT id FROM assignment_classes WHERE assessment_class_id=?',
    [classId]
  );
  for (const row of rows) {
    await assignmentExecute('DELETE FROM assignment_classes WHERE id=?', [row.id]);
  }
}

router.get('/config', async (req: Request, res: Response) => {
  const s = scope(req);
  if (!assertScope(s, res)) return;
  const configId = await ensureConfig(s);
  await syncAssignmentSnapshotsForScope(s, configId);

  const config = await assignmentQueryOne<Record<string, unknown>>('SELECT * FROM assignment_configs WHERE id=?', [configId]);
  if (config?.guide_url) {
    try {
      config.resolved_guide_md = await fetchGithubText(String(config.guide_url));
    } catch (error) {
      config.resolved_guide_md = String(config.guide_md || '');
      config.guide_fetch_error = error instanceof Error ? error.message : String(error);
    }
  } else if (config) {
    config.resolved_guide_md = String(config.guide_md || '');
  }
  const resources = await assignmentQueryAll(
    'SELECT id, filename, filepath, mime_type, size, source_url, uploaded_at FROM assignment_resources WHERE config_id=? ORDER BY uploaded_at DESC, id DESC',
    [configId]
  );
  const classes = await assignmentQueryAll(
    `SELECT ac.*, COUNT(ast.id) AS student_count
     FROM assignment_classes ac
     LEFT JOIN assignment_students ast ON ast.assignment_class_id=ac.id
     WHERE ac.config_id=?
     GROUP BY ac.id
     ORDER BY ac.room, ac.id`,
    [configId]
  );
  res.json({ config, resources, classes });
});

router.put('/config', async (req: Request, res: Response) => {
  const s = scope(req);
  if (!assertScope(s, res)) return;
  const configId = await ensureConfig(s);
  await syncAssignmentSnapshotsForScope(s, configId);
  const title = `${s.subject} ${s.domainName}`;
  const guideUrl = String(req.body?.guide_url ?? '').trim();
  let guideMd = String(req.body?.guide_md ?? '');
  if (guideUrl) {
    try {
      githubFetchUrl(guideUrl);
      guideMd = await fetchGithubText(guideUrl);
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  }
  const allowedExtensions = normalizeAllowedExtensions(String(req.body?.allowed_extensions ?? ''));
  const maxFileSizeMb = Math.max(1, Number(req.body?.max_file_size_mb || 50));
  const maxFiles = Math.max(1, Number(req.body?.max_files || 1));
  await assignmentExecute(
    `UPDATE assignment_configs
     SET title=?, guide_md=?, guide_url=?, allowed_extensions=?, max_file_size_mb=?, max_files=?, updated_at=datetime('now', 'localtime')
     WHERE id=?`,
    [title, guideMd, guideUrl, allowedExtensions, maxFileSizeMb, maxFiles, configId]
  );
  res.json({ ok: true, id: configId });
});

router.post('/guide-md', upload.single('file'), async (req: Request, res: Response) => {
  const s = scope(req);
  if (!assertScope(s, res)) return;
  if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });
  try {
    const guideMd = fs.readFileSync(req.file.path, 'utf8');
    fs.unlinkSync(req.file.path);
    const configId = await ensureConfig(s);
    await assignmentExecute(
      `UPDATE assignment_configs SET guide_md=?, guide_url='', updated_at=datetime('now', 'localtime') WHERE id=?`,
      [guideMd, configId]
    );
    res.json({ guide_md: guideMd });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.post('/resources', upload.array('files', 20), async (req: Request, res: Response) => {
  const s = scope(req);
  if (!assertScope(s, res)) return;
  const files = req.files as Express.Multer.File[];
  if (!files?.length) return res.status(400).json({ error: '파일이 없습니다.' });
  const configId = await ensureConfig(s);
  await assignmentTransaction(async () => {
    for (const file of files) {
      await assignmentExecute(
        'INSERT INTO assignment_resources(config_id, filename, filepath, mime_type, size) VALUES(?,?,?,?,?)',
        [configId, decodeUploadFilename(file.originalname), toStoredPath(file.path), file.mimetype || '', file.size || 0]
      );
    }
  });
  res.json({ uploaded: files.length });
});

router.post('/resource-links', async (req: Request, res: Response) => {
  const s = scope(req);
  if (!assertScope(s, res)) return;
  const sourceUrl = String(req.body?.url || '').trim();
  if (!sourceUrl) return res.status(400).json({ error: 'GitHub 링크를 입력하세요.' });
  try {
    githubFetchUrl(sourceUrl);
    const remote = await fetchGithubSource(sourceUrl);
    const filename = String(req.body?.title || '').trim() || remoteFilename(sourceUrl);
    const configId = await ensureConfig(s);
    const inserted = await assignmentExecute(
      `INSERT INTO assignment_resources(config_id, filename, filepath, mime_type, size, source_url)
       VALUES(?,?, '', ?, ?, ?)`,
      [configId, filename, remote.contentType, remote.buffer.length, sourceUrl]
    );
    res.json({ id: Number(inserted.lastInsertRowid), filename, source_url: sourceUrl });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.get('/resources/:id/file', async (req: Request, res: Response) => {
  const resource = await assignmentQueryOne<{ filename: string; filepath: string; mime_type: string; source_url: string }>(
    'SELECT filename, filepath, mime_type, source_url FROM assignment_resources WHERE id=?',
    [req.params.id]
  );
  if (resource?.source_url) {
    try {
      const remote = await fetchGithubSource(resource.source_url);
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      res.setHeader('Content-Type', previewContentType(resource.filename, remote.contentType));
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(resource.filename)}`);
      return res.send(remote.buffer);
    } catch (error) {
      return res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  }
  const filepath = resource ? resolveStoredPath(resource.filepath) : '';
  if (!resource || !fs.existsSync(filepath)) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
  res.setHeader('Content-Type', previewContentType(resource.filename, resource.mime_type));
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(resource.filename)}`);
  res.sendFile(path.resolve(filepath));
});

router.delete('/resources/:id', async (req: Request, res: Response) => {
  const resource = await assignmentQueryOne<{ filepath: string }>(
    'SELECT filepath FROM assignment_resources WHERE id=?',
    [req.params.id]
  );
  if (!resource) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
  try { if (resource.filepath) fs.unlinkSync(resolveStoredPath(resource.filepath)); } catch {}
  await assignmentExecute('DELETE FROM assignment_resources WHERE id=?', [req.params.id]);
  res.json({ ok: true });
});

router.get('/history', async (req: Request, res: Response) => {
  const s = scope(req);
  if (!assertScope(s, res)) return;
  const rows = await assignmentQueryAll(
    `SELECT run.id, run.is_open, run.started_at, run.ended_at, ac.room,
       (SELECT COUNT(*) FROM assignment_run_students rst WHERE rst.run_id=run.id) AS target_count,
       (SELECT COUNT(*) FROM assignment_run_students rst WHERE rst.run_id=run.id AND rst.is_absent=1) AS absent_count,
       (SELECT COUNT(*) FROM assignment_run_students rst
        WHERE rst.run_id=run.id AND EXISTS (
          SELECT 1 FROM assignment_submissions sub
          WHERE sub.run_id=run.id AND sub.status IN ('accepted', 'no_file')
            AND (sub.assignment_student_id=rst.assignment_student_id
              OR (sub.student_num=rst.student_num AND sub.name=rst.name))
        )) AS submitted_student_count,
       (SELECT COUNT(*) FROM assignment_submissions sub
        WHERE sub.run_id=run.id AND sub.status='accepted') AS accepted_file_count,
       (SELECT COUNT(*) FROM assignment_submissions sub WHERE sub.run_id=run.id) AS submission_event_count,
       (SELECT COUNT(*) FROM assignment_run_students rst
        WHERE rst.run_id=run.id AND EXISTS (
          SELECT 1 FROM assignment_submissions sub
          WHERE sub.run_id=run.id AND sub.status IN ('accepted', 'no_file') AND sub.teacher_checked=1
            AND (sub.assignment_student_id=rst.assignment_student_id
              OR (sub.student_num=rst.student_num AND sub.name=rst.name))
        )) AS checked_student_count
     FROM assignment_runs run
     JOIN assignment_configs cfg ON cfg.id=run.config_id
     JOIN assignment_classes ac ON ac.id=run.assignment_class_id
     WHERE cfg.year=? AND cfg.semester=? AND cfg.grade=? AND cfg.subject=? AND cfg.domain_name=?
     ORDER BY run.started_at DESC, run.id DESC`,
    [s.year, s.semester, s.grade, s.subject, s.domainName]
  );
  res.json(rows);
});

router.get('/history/:runId', async (req: Request, res: Response) => {
  const s = scope(req);
  if (!assertScope(s, res)) return;
  const run = await assignmentQueryOne(
    `SELECT run.id, run.is_open, run.started_at, run.ended_at, ac.room, cfg.title,
            cfg.year, cfg.semester, cfg.grade, cfg.subject, cfg.domain_name
     FROM assignment_runs run
     JOIN assignment_configs cfg ON cfg.id=run.config_id
     JOIN assignment_classes ac ON ac.id=run.assignment_class_id
     WHERE run.id=? AND cfg.year=? AND cfg.semester=? AND cfg.grade=?
       AND cfg.subject=? AND cfg.domain_name=?`,
    [req.params.runId, s.year, s.semester, s.grade, s.subject, s.domainName]
  );
  if (!run) return res.status(404).json({ error: '실시 기록을 찾을 수 없습니다.' });

  const students = await assignmentQueryAll(
    `SELECT id, assignment_student_id, assessment_student_id, student_num, class_num,
            seat_num, name, is_absent, absent_at, sort_order
     FROM assignment_run_students
     WHERE run_id=?
     ORDER BY sort_order, class_num, seat_num, student_num, name`,
    [req.params.runId]
  );
  const submissions = await assignmentQueryAll(
    `SELECT id, assignment_student_id, student_num, class_num, seat_num, name, ip_address,
            original_filename, size, status, reject_reason, teacher_checked,
            teacher_checked_at, submitted_at
     FROM assignment_submissions
     WHERE run_id=?
     ORDER BY submitted_at DESC, id DESC`,
    [req.params.runId]
  );
  res.json({ run, students, submissions });
});

router.get('/submissions', async (req: Request, res: Response) => {
  const s = scope(req);
  if (!assertScope(s, res)) return;
  const room = req.query.room ? String(req.query.room) : '';
  const rows = await assignmentQueryAll(
    `SELECT sub.*, ac.room, cfg.title, cfg.domain_name
     FROM assignment_submissions sub
     JOIN assignment_runs run ON run.id=sub.run_id
     JOIN assignment_classes ac ON ac.id=run.assignment_class_id
     JOIN assignment_configs cfg ON cfg.id=run.config_id
     WHERE cfg.year=? AND cfg.semester=? AND cfg.grade=? AND cfg.subject=? AND cfg.domain_name=?
       AND (?='' OR ac.room=?)
     ORDER BY sub.submitted_at DESC, sub.id DESC`,
    [s.year, s.semester, s.grade, s.subject, s.domainName, room, room]
  );
  res.json(rows);
});

router.get('/submissions/:id/file', async (req: Request, res: Response) => {
  const submission = await assignmentQueryOne<{ original_filename: string; filepath: string; mime_type: string }>(
    'SELECT original_filename, filepath, mime_type FROM assignment_submissions WHERE id=?',
    [req.params.id]
  );
  const filepath = submission ? resolveStoredPath(submission.filepath) : '';
  if (!submission || !fs.existsSync(filepath)) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
  res.setHeader('Content-Type', submission.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(submission.original_filename)}`);
  res.sendFile(path.resolve(filepath));
});

router.delete('/submissions/:id', async (req: Request, res: Response) => {
  const submission = await assignmentQueryOne<{ filepath: string }>(
    'SELECT filepath FROM assignment_submissions WHERE id=?',
    [req.params.id]
  );
  if (!submission) return res.status(404).json({ error: '제출 파일을 찾을 수 없습니다.' });

  let trashPath = '';
  try {
    trashPath = moveFileToTrash(submission.filepath, 'teacher-deleted-submissions');
    await assignmentExecute('DELETE FROM assignment_submissions WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch (error) {
    try { restoreTrashedFile(trashPath, submission.filepath); } catch {}
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

export default router;
