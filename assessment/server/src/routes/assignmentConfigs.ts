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

function resourceCachePath(filename: string): string {
  const safeName = path.basename(filename).replace(/[^\p{L}\p{N}._-]+/gu, '_') || 'github-resource';
  return path.join(RESOURCE_DIR, `${Date.now()}_${crypto.randomBytes(6).toString('hex')}_${safeName}`);
}

function writeResourceCache(filename: string, buffer: Buffer, storedFilepath = ''): string {
  const filepath = storedFilepath ? resolveStoredPath(storedFilepath) : resourceCachePath(filename);
  ensureDir(path.dirname(filepath));
  fs.writeFileSync(filepath, buffer);
  return toStoredPath(filepath);
}

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
          .map((item, index) => {
            const extension = String(item.extension || item.ext || '').trim().replace(/^\./, '').toLowerCase();
            return {
              id: String(item.id || item.slot_id || `slot-${index + 1}-${extension}`).trim(),
              name: String(item.name || item.content || item.label || extension).trim(),
              extension,
              max_file_size_mb: Math.max(1, Number(item.max_file_size_mb || item.maxFileSizeMb || 50)),
              max_files: Math.max(1, Number(item.max_files || item.maxFiles || 1)),
            };
          })
          .filter(item => item.id && item.name && item.extension)
          .filter((item, index, arr) => arr.findIndex(other => other.id === item.id) === index)
      );
    }
  } catch {
    // Legacy newline/comma separated extension list.
  }
  const extensions = String(value || '')
    .split(/[\s,]+/)
    .map(item => item.trim().replace(/^\./, '').toLowerCase())
    .filter(Boolean)
    .filter((item, index, arr) => arr.indexOf(item) === index);
  return JSON.stringify(extensions.map((extension, index) => ({
    id: `slot-${index + 1}-${extension}`,
    name: extension,
    extension,
    max_file_size_mb: 50,
    max_files: 1,
  })));
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

type AssignmentConfigDeleteScope = {
  year?: number;
  semester?: number;
  grade?: number;
  subject?: string;
  domainName?: string;
};

async function deleteAssignmentConfigs(scope: AssignmentConfigDeleteScope): Promise<number> {
  const conditions: string[] = [];
  const args: Array<string | number> = [];
  if (scope.year !== undefined) { conditions.push('year=?'); args.push(scope.year); }
  if (scope.semester !== undefined) { conditions.push('semester=?'); args.push(scope.semester); }
  if (scope.grade !== undefined) { conditions.push('grade=?'); args.push(scope.grade); }
  if (scope.subject !== undefined) { conditions.push('subject=?'); args.push(scope.subject); }
  if (scope.domainName !== undefined) { conditions.push('domain_name=?'); args.push(scope.domainName); }
  const where = conditions.length ? conditions.join(' AND ') : '1=1';
  const configs = await assignmentQueryAll<{ id: number }>(
    `SELECT id FROM assignment_configs WHERE ${where}`,
    args
  );
  if (!configs.length) return 0;

  const configIds = configs.map(config => Number(config.id));
  const placeholders = configIds.map(() => '?').join(',');
  const files = await assignmentQueryAll<{ filepath: string }>(
    `SELECT filepath FROM assignment_resources WHERE config_id IN (${placeholders}) AND filepath!=''
     UNION
     SELECT resource.filepath
     FROM assignment_run_resources resource
     JOIN assignment_runs run ON run.id=resource.run_id
     WHERE run.config_id IN (${placeholders}) AND resource.filepath!=''
     UNION
     SELECT submission.filepath
     FROM assignment_submissions submission
     JOIN assignment_runs run ON run.id=submission.run_id
     WHERE run.config_id IN (${placeholders}) AND submission.filepath!=''`,
    [...configIds, ...configIds, ...configIds]
  );
  const moved: Array<{ trashPath: string; originalFilepath: string }> = [];
  try {
    for (const filepath of new Set(files.map(file => String(file.filepath || '')).filter(Boolean))) {
      const trashPath = moveFileToTrash(filepath, 'deleted-assignment-configs');
      if (trashPath) moved.push({ trashPath, originalFilepath: filepath });
    }
    await assignmentTransaction(async () => {
      await assignmentExecute(
        `DELETE FROM assignment_configs WHERE id IN (${placeholders})`,
        configIds
      );
    });
    return configIds.length;
  } catch (error) {
    for (const file of moved.reverse()) {
      try { restoreTrashedFile(file.trashPath, file.originalFilepath); } catch {}
    }
    throw error;
  }
}

export async function deleteAssignmentConfigsForScope(scope: AssignmentConfigDeleteScope): Promise<number> {
  if (scope.year === undefined) throw new Error('평가 실시 설정 삭제에는 학년도가 필요합니다.');
  return deleteAssignmentConfigs(scope);
}

export async function deleteAllAssignmentConfigs(): Promise<number> {
  return deleteAssignmentConfigs({});
}

export async function pruneAssignmentConfigsForAssessmentScope(
  year: number,
  semester: number,
  grade: number,
  subject: string
): Promise<number> {
  const activeDomains = await queryAll<{ name: string }>(
    `SELECT name
     FROM (
       SELECT name FROM subject_domains
       WHERE year=? AND semester=? AND grade=? AND subject=? AND name!=''
         AND ((eval_type='수행' AND reflected='O') OR eval_type='기록')
       UNION
       SELECT name FROM custom_domains
       WHERE year=? AND semester=? AND grade=? AND subject=? AND name!=''
     )`,
    [year, semester, grade, subject, year, semester, grade, subject]
  );
  const activeNames = new Set(activeDomains.map(domain => domain.name));
  const configs = await assignmentQueryAll<{ domain_name: string }>(
    `SELECT domain_name FROM assignment_configs
     WHERE year=? AND semester=? AND grade=? AND subject=?`,
    [year, semester, grade, subject]
  );
  let deleted = 0;
  for (const config of configs) {
    if (!activeNames.has(config.domain_name)) {
      deleted += await deleteAssignmentConfigsForScope({
        year, semester, grade, subject, domainName: config.domain_name,
      });
    }
  }
  return deleted;
}

router.get('/config', async (req: Request, res: Response) => {
  const s = scope(req);
  if (!assertScope(s, res)) return;
  const configId = await ensureConfig(s);
  await syncAssignmentSnapshotsForScope(s, configId);

  const config = await assignmentQueryOne<Record<string, unknown>>('SELECT * FROM assignment_configs WHERE id=?', [configId]);
  if (config?.guide_url && String(req.query.refreshGuide) !== 'false') {
    try {
      const latestGuide = await fetchGithubText(String(config.guide_url));
      await assignmentExecute(
        `UPDATE assignment_configs
         SET guide_md=?, guide_checked_at=datetime('now', 'localtime'), updated_at=datetime('now', 'localtime')
         WHERE id=?`,
        [latestGuide, configId]
      );
      config.guide_md = latestGuide;
      config.resolved_guide_md = latestGuide;
      config.guide_checked_at = new Date().toLocaleString('sv-SE');
    } catch (error) {
      config.resolved_guide_md = String(config.guide_md || '');
      config.guide_fetch_error = error instanceof Error ? error.message : String(error);
    }
  } else if (config) {
    config.resolved_guide_md = String(config.guide_md || '');
  }
  const resources = await assignmentQueryAll(
    'SELECT id, filename, filepath, mime_type, size, source_url, checked_at, uploaded_at FROM assignment_resources WHERE config_id=? ORDER BY uploaded_at DESC, id DESC',
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
  const existing = await assignmentQueryOne<{ guide_url: string; guide_md: string; guide_checked_at: string }>(
    'SELECT guide_url, guide_md, guide_checked_at FROM assignment_configs WHERE id=?',
    [configId]
  );
  const title = `${s.subject} ${s.domainName}`;
  const guideUrl = String(req.body?.guide_url ?? '').trim();
  let guideMd = String(req.body?.guide_md ?? '');
  let guideCheckedAt = String(existing?.guide_checked_at || '');
  let guideWarning = '';
  const shouldRefreshGuide = !!guideUrl && (
    guideUrl !== String(existing?.guide_url || '') || req.body?.refresh_guide === true
  );
  if (shouldRefreshGuide) {
    try {
      githubFetchUrl(guideUrl);
      guideMd = await fetchGithubText(guideUrl);
      guideCheckedAt = new Date().toLocaleString('sv-SE');
    } catch (error) {
      if (!existing?.guide_md || guideUrl !== String(existing.guide_url || '')) {
        return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
      guideMd = existing.guide_md;
      guideWarning = `GitHub 확인에 실패하여 마지막 저장본을 사용합니다. ${error instanceof Error ? error.message : String(error)}`;
    }
  } else if (guideUrl) {
    guideMd = String(existing?.guide_md || guideMd);
  }
  const allowedExtensions = normalizeAllowedExtensions(String(req.body?.allowed_extensions ?? ''));
  const maxFileSizeMb = Math.max(1, Number(req.body?.max_file_size_mb || 50));
  const maxFiles = Math.max(1, Number(req.body?.max_files || 1));
  await assignmentExecute(
    `UPDATE assignment_configs
     SET title=?, guide_md=?, guide_url=?, guide_checked_at=?, allowed_extensions=?, max_file_size_mb=?, max_files=?, updated_at=datetime('now', 'localtime')
     WHERE id=?`,
    [title, guideMd, guideUrl, guideCheckedAt, allowedExtensions, maxFileSizeMb, maxFiles, configId]
  );
  res.json({ ok: true, id: configId, warning: guideWarning });
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
      `UPDATE assignment_configs SET guide_md=?, guide_url='', guide_checked_at='', updated_at=datetime('now', 'localtime') WHERE id=?`,
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
    const filepath = writeResourceCache(filename, remote.buffer);
    const configId = await ensureConfig(s);
    try {
      const inserted = await assignmentExecute(
        `INSERT INTO assignment_resources(config_id, filename, filepath, mime_type, size, source_url, checked_at)
         VALUES(?,?,?,?,?,?,datetime('now', 'localtime'))`,
        [configId, filename, filepath, remote.contentType, remote.buffer.length, sourceUrl]
      );
      res.json({ id: Number(inserted.lastInsertRowid), filename, source_url: sourceUrl });
    } catch (error) {
      try { fs.unlinkSync(resolveStoredPath(filepath)); } catch {}
      throw error;
    }
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.post('/resources/:id/refresh', async (req: Request, res: Response) => {
  const resource = await assignmentQueryOne<{ id: number; filename: string; filepath: string; source_url: string }>(
    'SELECT id, filename, filepath, source_url FROM assignment_resources WHERE id=?',
    [req.params.id]
  );
  if (!resource?.source_url) return res.status(404).json({ error: '연결된 GitHub 자료를 찾을 수 없습니다.' });
  try {
    const remote = await fetchGithubSource(resource.source_url);
    const filepath = writeResourceCache(resource.filename, remote.buffer, resource.filepath);
    await assignmentExecute(
      `UPDATE assignment_resources
       SET filepath=?, mime_type=?, size=?, checked_at=datetime('now', 'localtime')
       WHERE id=?`,
      [filepath, remote.contentType, remote.buffer.length, resource.id]
    );
    res.json({ ok: true, size: remote.buffer.length, mime_type: remote.contentType });
  } catch (error) {
    const cached = resource.filepath && fs.existsSync(resolveStoredPath(resource.filepath));
    if (cached) {
      return res.json({
        ok: false,
        cached: true,
        warning: `GitHub 확인에 실패하여 마지막 저장본을 사용합니다. ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
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
      const filepath = writeResourceCache(resource.filename, remote.buffer, resource.filepath);
      await assignmentExecute(
        `UPDATE assignment_resources
         SET filepath=?, mime_type=?, size=?, checked_at=datetime('now', 'localtime')
         WHERE id=?`,
        [filepath, remote.contentType, remote.buffer.length, req.params.id]
      );
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      res.setHeader('Content-Type', previewContentType(resource.filename, remote.contentType));
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(resource.filename)}`);
      return res.send(remote.buffer);
    } catch (error) {
      const cachedPath = resolveStoredPath(resource.filepath);
      if (!resource.filepath || !fs.existsSync(cachedPath)) {
        return res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
      }
      res.setHeader('X-GitHub-Cache-Fallback', '1');
      res.setHeader('Content-Type', previewContentType(resource.filename, resource.mime_type));
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(resource.filename)}`);
      return res.sendFile(path.resolve(cachedPath));
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
        WHERE sub.run_id=run.id AND sub.status='accepted' AND sub.submission_slot_id!=''
          AND NOT EXISTS (
            SELECT 1 FROM assignment_submissions newer
            WHERE newer.run_id=sub.run_id AND newer.status='accepted'
              AND newer.submission_slot_id=sub.submission_slot_id
              AND (newer.assignment_student_id=sub.assignment_student_id
                OR (newer.student_num=sub.student_num AND newer.name=sub.name))
              AND newer.submission_batch_id!=sub.submission_batch_id
              AND (newer.submitted_at>sub.submitted_at
                OR (newer.submitted_at=sub.submitted_at AND newer.id>sub.id))
          )) AS accepted_file_count,
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
    `WITH ranked_accepted AS (
       SELECT sub.*,
              DENSE_RANK() OVER (
                PARTITION BY COALESCE(CAST(sub.assignment_student_id AS TEXT), 'identity:' || sub.student_num || ':' || sub.name), sub.submission_slot_id
                ORDER BY sub.submitted_at DESC, sub.submission_batch_id DESC
              ) AS current_rank
       FROM assignment_submissions sub
       WHERE sub.run_id=? AND sub.status='accepted' AND sub.submission_slot_id!=''
     ), ranked_other AS (
       SELECT sub.*,
              ROW_NUMBER() OVER (
                PARTITION BY COALESCE(CAST(sub.assignment_student_id AS TEXT), 'identity:' || sub.student_num || ':' || sub.name)
                ORDER BY sub.submitted_at DESC, sub.id DESC
              ) AS current_rank
       FROM assignment_submissions sub
       WHERE sub.run_id=? AND sub.status!='accepted'
         AND NOT EXISTS (
           SELECT 1 FROM assignment_submissions accepted
           WHERE accepted.run_id=sub.run_id AND accepted.status='accepted'
             AND (accepted.assignment_student_id=sub.assignment_student_id
               OR (accepted.student_num=sub.student_num AND accepted.name=sub.name))
         )
     ), current_submissions AS (
       SELECT * FROM ranked_accepted WHERE current_rank=1
       UNION ALL
       SELECT * FROM ranked_other WHERE current_rank=1
     )
     SELECT id, assignment_student_id, student_num, class_num, seat_num, name, ip_address,
            submission_slot_id, submission_slot_name, original_filename, size, status,
            reject_reason, teacher_checked, teacher_checked_at, submitted_at
     FROM current_submissions
     ORDER BY submitted_at DESC, id DESC`,
    [req.params.runId, req.params.runId]
  );
  res.json({ run, students, submissions });
});

router.get('/submissions', async (req: Request, res: Response) => {
  const s = scope(req);
  if (!assertScope(s, res)) return;
  const room = req.query.room ? String(req.query.room) : '';
  const rows = await assignmentQueryAll(
    `WITH ranked AS (
       SELECT sub.*, ac.room, cfg.title, cfg.domain_name,
              DENSE_RANK() OVER (
                PARTITION BY cfg.id, ac.id,
                  COALESCE(CAST(sub.assignment_student_id AS TEXT), 'identity:' || sub.student_num || ':' || sub.name),
                  sub.submission_slot_id
                ORDER BY sub.submitted_at DESC, sub.submission_batch_id DESC
              ) AS current_rank
       FROM assignment_submissions sub
       JOIN assignment_runs run ON run.id=sub.run_id
       JOIN assignment_classes ac ON ac.id=run.assignment_class_id
       JOIN assignment_configs cfg ON cfg.id=run.config_id
       WHERE cfg.year=? AND cfg.semester=? AND cfg.grade=? AND cfg.subject=? AND cfg.domain_name=?
         AND (?='' OR ac.room=?) AND sub.status='accepted' AND sub.submission_slot_id!=''
     )
     SELECT * FROM ranked WHERE current_rank=1
     ORDER BY submitted_at DESC, id DESC`,
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
