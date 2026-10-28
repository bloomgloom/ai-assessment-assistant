import { createClient, type Client, type InValue } from '@libsql/client';
import path from 'path';
import { DATA_DIR } from './storage';

const DB_PATH = path.join(DATA_DIR, 'assignment.db');
let client: Client | null = null;

export function getClient(): Client {
  if (!client) client = createClient({ url: `file:${DB_PATH}` });
  return client;
}

export async function initDb() {
  const db = getClient();
  await db.execute('PRAGMA journal_mode = WAL');
  await db.execute('PRAGMA foreign_keys = ON');
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS assignment_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assignment_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      year INTEGER NOT NULL,
      semester INTEGER NOT NULL,
      grade INTEGER NOT NULL,
      subject TEXT NOT NULL,
      domain_name TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      guide_md TEXT NOT NULL DEFAULT '',
      guide_url TEXT NOT NULL DEFAULT '',
      guide_checked_at TEXT NOT NULL DEFAULT '',
      allowed_extensions TEXT NOT NULL DEFAULT '',
      max_file_size_mb INTEGER NOT NULL DEFAULT 50,
      max_files INTEGER NOT NULL DEFAULT 1,
      is_open INTEGER NOT NULL DEFAULT 0,
      share_code TEXT NOT NULL DEFAULT '',
      viewer_code TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      UNIQUE(year, semester, grade, subject, domain_name)
    );
    CREATE TABLE IF NOT EXISTS assignment_resources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      config_id INTEGER NOT NULL REFERENCES assignment_configs(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      filepath TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT '',
      size INTEGER NOT NULL DEFAULT 0,
      source_url TEXT NOT NULL DEFAULT '',
      checked_at TEXT NOT NULL DEFAULT '',
      uploaded_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
    CREATE TABLE IF NOT EXISTS assignment_classes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      config_id INTEGER NOT NULL REFERENCES assignment_configs(id) ON DELETE CASCADE,
      assessment_class_id INTEGER NOT NULL DEFAULT 0,
      room TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      UNIQUE(config_id, assessment_class_id)
    );
    CREATE TABLE IF NOT EXISTS assignment_students (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      assignment_class_id INTEGER NOT NULL REFERENCES assignment_classes(id) ON DELETE CASCADE,
      assessment_student_id INTEGER NOT NULL DEFAULT 0,
      student_num INTEGER NOT NULL,
      class_num INTEGER NOT NULL DEFAULT 0,
      seat_num INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL,
      is_absent INTEGER NOT NULL DEFAULT 0,
      absent_at TEXT DEFAULT '',
      UNIQUE(assignment_class_id, student_num, name)
    );
    CREATE TABLE IF NOT EXISTS assignment_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      config_id INTEGER NOT NULL REFERENCES assignment_configs(id) ON DELETE CASCADE,
      assignment_class_id INTEGER NOT NULL REFERENCES assignment_classes(id) ON DELETE CASCADE,
      share_code TEXT NOT NULL UNIQUE,
      viewer_code TEXT NOT NULL UNIQUE,
      is_open INTEGER NOT NULL DEFAULT 1,
      submission_rules_snapshot TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      ended_at TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS assignment_run_resources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES assignment_runs(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      filepath TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT '',
      size INTEGER NOT NULL DEFAULT 0,
      source_url TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS assignment_run_students (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES assignment_runs(id) ON DELETE CASCADE,
      assignment_student_id INTEGER REFERENCES assignment_students(id) ON DELETE SET NULL,
      assessment_student_id INTEGER NOT NULL DEFAULT 0,
      student_num INTEGER NOT NULL,
      class_num INTEGER NOT NULL DEFAULT 0,
      seat_num INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL,
      is_absent INTEGER NOT NULL DEFAULT 0,
      absent_at TEXT DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      UNIQUE(run_id, student_num, name)
    );
    CREATE TABLE IF NOT EXISTS assignment_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES assignment_runs(id) ON DELETE CASCADE,
      assignment_student_id INTEGER REFERENCES assignment_students(id) ON DELETE SET NULL,
      student_num INTEGER NOT NULL,
      class_num INTEGER NOT NULL DEFAULT 0,
      seat_num INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL,
      submission_slot_id TEXT NOT NULL DEFAULT '',
      submission_slot_name TEXT NOT NULL DEFAULT '',
      submission_batch_id TEXT NOT NULL DEFAULT '',
      ip_address TEXT NOT NULL DEFAULT '',
      original_filename TEXT NOT NULL,
      stored_filename TEXT NOT NULL,
      filepath TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT '',
      size INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'accepted',
      reject_reason TEXT NOT NULL DEFAULT '',
      user_agent TEXT NOT NULL DEFAULT '',
      teacher_checked INTEGER NOT NULL DEFAULT 0,
      teacher_checked_at TEXT DEFAULT '',
      submitted_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
    CREATE TABLE IF NOT EXISTS assignment_artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      assessment_student_id INTEGER NOT NULL,
      domain TEXT NOT NULL DEFAULT '',
      filename TEXT NOT NULL,
      filepath TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT '',
      size INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'assessment_upload',
      legacy_assessment_artifact_id INTEGER UNIQUE,
      uploaded_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
  `);
  await ensureColumn('assignment_configs', 'title', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn('assignment_configs', 'guide_md', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn('assignment_configs', 'guide_url', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn('assignment_configs', 'guide_checked_at', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn('assignment_configs', 'allowed_extensions', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn('assignment_configs', 'max_file_size_mb', "INTEGER NOT NULL DEFAULT 50");
  await ensureColumn('assignment_configs', 'max_files', "INTEGER NOT NULL DEFAULT 1");
  await ensureColumn('assignment_configs', 'is_open', "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn('assignment_configs', 'share_code', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn('assignment_configs', 'viewer_code', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn('assignment_configs', 'updated_at', "TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))");
  await ensureColumn('assignment_resources', 'mime_type', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn('assignment_resources', 'size', "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn('assignment_resources', 'source_url', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn('assignment_resources', 'checked_at', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn('assignment_resources', 'uploaded_at', "TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))");
  await ensureColumn('assignment_classes', 'assessment_class_id', "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn('assignment_classes', 'created_at', "TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))");
  await ensureColumn('assignment_students', 'assessment_student_id', "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn('assignment_students', 'class_num', "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn('assignment_students', 'seat_num', "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn('assignment_students', 'is_absent', "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn('assignment_students', 'absent_at', "TEXT DEFAULT ''");
  await ensureColumn('assignment_runs', 'share_code', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn('assignment_runs', 'viewer_code', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn('assignment_runs', 'is_open', "INTEGER NOT NULL DEFAULT 1");
  await ensureColumn('assignment_runs', 'started_at', "TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))");
  await ensureColumn('assignment_runs', 'ended_at', "TEXT DEFAULT ''");
  await ensureColumn('assignment_runs', 'guide_md_snapshot', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn('assignment_run_students', 'assignment_student_id', "INTEGER");
  await ensureColumn('assignment_run_students', 'assessment_student_id', "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn('assignment_run_students', 'student_num', "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn('assignment_run_students', 'class_num', "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn('assignment_run_students', 'seat_num', "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn('assignment_run_students', 'name', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn('assignment_run_students', 'is_absent', "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn('assignment_run_students', 'absent_at', "TEXT DEFAULT ''");
  await ensureColumn('assignment_run_students', 'sort_order', "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn('assignment_submissions', 'assignment_student_id', "INTEGER");
  await ensureColumn('assignment_submissions', 'class_num', "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn('assignment_submissions', 'seat_num', "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn('assignment_submissions', 'ip_address', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn('assignment_submissions', 'stored_filename', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn('assignment_submissions', 'filepath', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn('assignment_submissions', 'mime_type', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn('assignment_submissions', 'size', "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn('assignment_submissions', 'status', "TEXT NOT NULL DEFAULT 'accepted'");
  await ensureColumn('assignment_submissions', 'reject_reason', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn('assignment_submissions', 'user_agent', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn('assignment_submissions', 'teacher_checked', "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn('assignment_submissions', 'teacher_checked_at', "TEXT DEFAULT ''");
  await ensureColumn('assignment_submissions', 'submitted_at', "TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))");
  await ensureColumn('assignment_artifacts', 'assessment_student_id', "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn('assignment_artifacts', 'domain', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn('assignment_artifacts', 'filename', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn('assignment_artifacts', 'filepath', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn('assignment_artifacts', 'mime_type', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn('assignment_artifacts', 'size', "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn('assignment_artifacts', 'source', "TEXT NOT NULL DEFAULT 'assessment_upload'");
  await ensureColumn('assignment_artifacts', 'legacy_assessment_artifact_id', "INTEGER");
  await ensureColumn('assignment_artifacts', 'uploaded_at', "TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))");
  await db.execute(`
    INSERT OR IGNORE INTO assignment_run_students(
      run_id, assignment_student_id, assessment_student_id, student_num, class_num, seat_num,
      name, is_absent, absent_at, sort_order
    )
    SELECT run.id, ast.id, ast.assessment_student_id, ast.student_num, ast.class_num, ast.seat_num,
           ast.name, ast.is_absent, ast.absent_at, ast.id
    FROM assignment_runs run
    JOIN assignment_students ast ON ast.assignment_class_id=run.assignment_class_id
    WHERE NOT EXISTS (SELECT 1 FROM assignment_run_students rst WHERE rst.run_id=run.id)
  `);
}

async function ensureColumn(table: string, column: string, definition: string): Promise<void> {
  if (!(await columnExists(table, column))) {
    await getClient().execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await getClient().execute(`PRAGMA table_info(${table})`);
  return rows.rows.some((row) => {
    const obj = row as unknown as Record<string, unknown>;
    return obj.name === column || (Array.isArray(row) && row[1] === column);
  });
}

type Args = InValue[];

function rowToObject<T>(row: unknown, columns: string[]): T {
  if (Array.isArray(row)) return Object.fromEntries(row.map((value, index) => [columns[index], value])) as T;
  return row as T;
}

export async function queryOne<T>(sql: string, args: Args = []): Promise<T | null> {
  const rs = await getClient().execute({ sql, args });
  return rs.rows[0] ? rowToObject<T>(rs.rows[0], rs.columns) : null;
}

export async function queryAll<T>(sql: string, args: Args = []): Promise<T[]> {
  const rs = await getClient().execute({ sql, args });
  return rs.rows.map((row) => rowToObject<T>(row, rs.columns));
}

export async function execute(sql: string, args: Args = []) {
  const rs = await getClient().execute({ sql, args });
  return { lastInsertRowid: rs.lastInsertRowid ?? 0, rowsAffected: rs.rowsAffected };
}

export async function transaction<T>(fn: () => Promise<T>): Promise<T> {
  const db = getClient();
  await db.execute('BEGIN');
  try {
    const result = await fn();
    await db.execute('COMMIT');
    return result;
  } catch (error) {
    await db.execute('ROLLBACK');
    throw error;
  }
}
