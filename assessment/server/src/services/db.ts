import { createClient, type Client, type InValue } from '@libsql/client';
import path from 'path';
import { DATA_DIR, LEGACY_UPLOADS_DIR, STORAGE_ROOT, UPLOADS_DIR, ensureDir, toStoredPath } from './storage';

ensureDir(DATA_DIR);

const DB_PATH = path.join(DATA_DIR, 'assessment.db');

let client: Client | null = null;
let initialized = false;

export function getClient(): Client {
  if (!client) {
    client = createClient({ url: `file:${DB_PATH}` });
  }
  return client;
}

export function closeDb(): void {
  client?.close();
  client = null;
  initialized = false;
}

// 동기 인터페이스를 흉내낸 헬퍼들을 위해 초기화는 서버 시작 시 한 번 수행
export async function initDb(): Promise<void> {
  if (initialized) return;
  const db = getClient();

  await db.execute('PRAGMA journal_mode = WAL');
  await db.execute('PRAGMA foreign_keys = ON');

  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- (기존 기준관리 테이블은 레거시로 남겨두거나 향후 삭제)
    CREATE TABLE IF NOT EXISTS criteria_sets (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      description TEXT    DEFAULT '',
      mode        TEXT    NOT NULL CHECK(mode IN ('세특', '평가')),
      created_at  TEXT    DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS comments_criteria (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      set_id     INTEGER NOT NULL REFERENCES criteria_sets(id) ON DELETE CASCADE,
      type       TEXT    NOT NULL DEFAULT '항목',
      title      TEXT    NOT NULL DEFAULT '',
      prompt     TEXT    NOT NULL DEFAULT '',
      extensions TEXT    NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS eval_domains (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      set_id        INTEGER NOT NULL REFERENCES criteria_sets(id) ON DELETE CASCADE,
      name          TEXT    NOT NULL,
      common_prompt TEXT    DEFAULT '',
      is_used       INTEGER NOT NULL DEFAULT 1,
      sort_order    INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS eval_items (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      domain_id  INTEGER NOT NULL REFERENCES eval_domains(id) ON DELETE CASCADE,
      name       TEXT    NOT NULL,
      excel_col  TEXT    NOT NULL DEFAULT '',
      item_type  TEXT    NOT NULL DEFAULT 'llm' CHECK(item_type IN ('llm', 'formula')),
      rubric     TEXT    NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    -- [신규] 커스텀 수행평가 영역 (세특용)
    CREATE TABLE IF NOT EXISTS custom_domains (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      year       INTEGER NOT NULL,
      semester   INTEGER NOT NULL,
      grade      INTEGER NOT NULL,
      subject    TEXT    NOT NULL,
      name       TEXT    NOT NULL,
      created_at TEXT    DEFAULT (datetime('now'))
    );

    -- [신규] 도메인별 세특 기준
    CREATE TABLE IF NOT EXISTS domain_comments (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      year        INTEGER NOT NULL,
      semester    INTEGER NOT NULL,
      grade       INTEGER NOT NULL,
      subject     TEXT    NOT NULL,
      domain_name TEXT    NOT NULL,
      type        TEXT    NOT NULL DEFAULT '항목',
      title       TEXT    NOT NULL DEFAULT '',
      prompt      TEXT    NOT NULL DEFAULT '',
      extensions  TEXT    NOT NULL DEFAULT '',
      sort_order  INTEGER NOT NULL DEFAULT 0
    );

    -- [신규] 도메인별 평가 기준
    CREATE TABLE IF NOT EXISTS domain_eval (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      year        INTEGER NOT NULL,
      semester    INTEGER NOT NULL,
      grade       INTEGER NOT NULL,
      subject     TEXT    NOT NULL,
      domain_name TEXT    NOT NULL,
      name        TEXT    NOT NULL,
      score       TEXT    NOT NULL DEFAULT '',
      item_type   TEXT    NOT NULL DEFAULT 'llm' CHECK(item_type IN ('llm', 'formula')),
      rubric      TEXT    NOT NULL DEFAULT '',
      sort_order  INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS domain_ai_prompts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      year        INTEGER NOT NULL,
      semester    INTEGER NOT NULL,
      grade       INTEGER NOT NULL,
      subject     TEXT    NOT NULL,
      domain_name TEXT    NOT NULL,
      prompt_key  TEXT    NOT NULL,
      prompt      TEXT    NOT NULL DEFAULT '',
      updated_at  TEXT    DEFAULT (datetime('now')),
      UNIQUE(year, semester, grade, subject, domain_name, prompt_key)
    );

    -- 수업 관리: 채점 파일 업로드 단위
    CREATE TABLE IF NOT EXISTS classes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      year       INTEGER NOT NULL,
      semester   INTEGER NOT NULL,
      grade      INTEGER NOT NULL,
      subject    TEXT    NOT NULL,
      room       TEXT    NOT NULL,
      filename   TEXT    NOT NULL DEFAULT '',
      scoring_filename TEXT NOT NULL DEFAULT '',
      scoring_filepath TEXT NOT NULL DEFAULT '',
      comments_filename TEXT NOT NULL DEFAULT '',
      comments_filepath TEXT NOT NULL DEFAULT '',
      created_at TEXT    DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS subject_domains (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      year        INTEGER NOT NULL,
      semester    INTEGER NOT NULL,
      grade       INTEGER NOT NULL,
      subject     TEXT    NOT NULL,
      credit      REAL    NOT NULL DEFAULT 0,
      eval_type   TEXT    NOT NULL DEFAULT '',
      name        TEXT    NOT NULL,
      reflected   TEXT    NOT NULL DEFAULT '',
      ratio       REAL    NOT NULL DEFAULT 0,
      max_score   REAL    NOT NULL DEFAULT 0,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      source_filename TEXT NOT NULL DEFAULT '',
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS achievement_standards (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      year        INTEGER NOT NULL,
      semester    INTEGER NOT NULL,
      grade       INTEGER NOT NULL,
      subject     TEXT    NOT NULL,
      credit      REAL    NOT NULL DEFAULT 0,
      domain_name TEXT    NOT NULL DEFAULT '',
      code        TEXT    NOT NULL DEFAULT '',
      content     TEXT    NOT NULL DEFAULT '',
      level       TEXT    NOT NULL DEFAULT '',
      description TEXT    NOT NULL DEFAULT '',
      sort_order  INTEGER NOT NULL DEFAULT 0,
      source_filename TEXT NOT NULL DEFAULT '',
      created_at  TEXT DEFAULT (datetime('now'))
    );

    -- 수행평가 영역 (클래스별)
    CREATE TABLE IF NOT EXISTS assessment_domains (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id   INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      name       TEXT    NOT NULL,
      max_score  INTEGER NOT NULL DEFAULT 0,
      excel_col  TEXT    NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    -- 학생 명단 (클래스별)
    CREATE TABLE IF NOT EXISTS class_students (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id    INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      student_num INTEGER NOT NULL DEFAULT 0,
      name        TEXT    NOT NULL,
      excel_row   INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS artifacts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id  INTEGER NOT NULL REFERENCES class_students(id) ON DELETE CASCADE,
      domain      TEXT    NOT NULL DEFAULT '',
      filename    TEXT    NOT NULL,
      filepath    TEXT    NOT NULL,
      mime_type   TEXT    NOT NULL DEFAULT '',
      uploaded_at TEXT    DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS generated_content (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id   INTEGER NOT NULL REFERENCES class_students(id) ON DELETE CASCADE,
      content_type TEXT    NOT NULL CHECK(content_type IN ('scoring', 'comments', 'spellcheck')),
      domain       TEXT    NOT NULL DEFAULT '',
      content      TEXT    NOT NULL DEFAULT '',
      updated_at   TEXT    DEFAULT (datetime('now')),
      UNIQUE(student_id, content_type, domain)
    );

    CREATE TABLE IF NOT EXISTS written_exam_files (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id    INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      domain_name TEXT    NOT NULL,
      exam_name   TEXT    NOT NULL DEFAULT '',
      filename    TEXT    NOT NULL,
      filepath    TEXT    NOT NULL,
      max_score   REAL    NOT NULL DEFAULT 0,
      uploaded_at TEXT    DEFAULT (datetime('now')),
      UNIQUE(class_id, domain_name)
    );

    CREATE TABLE IF NOT EXISTS written_exam_scores (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id       INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      student_id     INTEGER NOT NULL REFERENCES class_students(id) ON DELETE CASCADE,
      domain_name    TEXT    NOT NULL,
      score          TEXT    NOT NULL DEFAULT '',
      source_file_id INTEGER REFERENCES written_exam_files(id) ON DELETE SET NULL,
      updated_at     TEXT    DEFAULT (datetime('now')),
      UNIQUE(class_id, student_id, domain_name)
    );

    CREATE TABLE IF NOT EXISTS ai_batch_jobs (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_batch_id   TEXT    NOT NULL UNIQUE,
      class_id            INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      domain              TEXT    NOT NULL,
      content_type        TEXT    NOT NULL CHECK(content_type IN ('scoring', 'comments', 'combined', 'spellcheck')),
      status              TEXT    NOT NULL DEFAULT 'in_progress',
      request_count       INTEGER NOT NULL DEFAULT 0,
      metadata            TEXT    NOT NULL DEFAULT '{}',
      created_at          TEXT    DEFAULT (datetime('now')),
      updated_at          TEXT    DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS subject_plan_settings (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      year                  INTEGER NOT NULL,
      semester              INTEGER NOT NULL,
      grade                 INTEGER NOT NULL,
      subject               TEXT NOT NULL,
      record_mode           TEXT NOT NULL DEFAULT 'app' CHECK(record_mode IN ('app', 'excel')),
      excel_path            TEXT NOT NULL DEFAULT '',
      source_folder         TEXT NOT NULL DEFAULT '',
      source_filename       TEXT NOT NULL DEFAULT '',
      source_filepath       TEXT NOT NULL DEFAULT '',
      common_prompt         TEXT NOT NULL DEFAULT '제출물에 있는 사실만 쓴다. 칭찬, 평가, 점수는 쓰지 않는다. 학생 이름을 쓰지 않는다. 한국어로 쓴다.',
      practice_prompt       TEXT NOT NULL DEFAULT '원본과 비교해 진행도를 n/m으로 쓴다. 마지막으로 완료한 단계, 결과가 없거나 오류가 있는 단계, 원본에서 바꾼 부분을 쓴다.',
      inquiry_prompt        TEXT NOT NULL DEFAULT '질문, 사용한 데이터와 방법, 결과를 2~3문장으로 쓴다. 다시 제출한 경우 달라진 점을 먼저 쓴다.',
      concept_prompt        TEXT NOT NULL DEFAULT '1문장으로 쓴다. 제출물이 없으면 "제출물 없음"이라고 쓴다.',
      other_prompt          TEXT NOT NULL DEFAULT '1문장으로 쓴다.',
      comprehensive_prompt  TEXT NOT NULL DEFAULT '학기 전체의 활동 요약, 관찰, 성찰을 바탕으로 반복되는 관심, 시도, 변화와 구체적인 사실을 간결하게 종합한다. 학생 이름과 평가·점수는 쓰지 않는다.',
      record_chat           TEXT NOT NULL DEFAULT '[]',
      comprehensive_chat    TEXT NOT NULL DEFAULT '[]',
      updated_at            TEXT DEFAULT (datetime('now')),
      UNIQUE(year, semester, grade, subject)
    );

    CREATE TABLE IF NOT EXISTS lesson_plans (
      id          TEXT PRIMARY KEY,
      year        INTEGER NOT NULL,
      semester    INTEGER NOT NULL,
      grade       INTEGER NOT NULL,
      subject     TEXT NOT NULL,
      lesson_no   REAL NOT NULL,
      progress    TEXT NOT NULL DEFAULT '',
      content     TEXT NOT NULL DEFAULT '',
      memo        TEXT NOT NULL DEFAULT '',
      kind        TEXT NOT NULL DEFAULT '기타' CHECK(kind IN ('개념', '실습', '탐구', '기타')),
      source_files TEXT NOT NULL DEFAULT '',
      prompt      TEXT NOT NULL DEFAULT '',
      sort_order  INTEGER NOT NULL DEFAULT 0,
      updated_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS activity_dates (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id    INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      activity_date TEXT NOT NULL,
      lesson_no   REAL NOT NULL DEFAULT 0,
      progress    TEXT NOT NULL DEFAULT '',
      journal     TEXT NOT NULL DEFAULT '',
      source_mode TEXT NOT NULL DEFAULT 'app',
      updated_at  TEXT DEFAULT (datetime('now')),
      UNIQUE(class_id, activity_date)
    );

    CREATE TABLE IF NOT EXISTS activity_files (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id  INTEGER NOT NULL REFERENCES class_students(id) ON DELETE CASCADE,
      activity_date_id INTEGER NOT NULL REFERENCES activity_dates(id) ON DELETE CASCADE,
      filename    TEXT NOT NULL,
      original_filename TEXT NOT NULL DEFAULT '',
      filepath    TEXT NOT NULL,
      mime_type   TEXT NOT NULL DEFAULT '',
      size        INTEGER NOT NULL DEFAULT 0,
      uploaded_at TEXT DEFAULT (datetime('now')),
      summarized_at TEXT DEFAULT '',
      UNIQUE(student_id, activity_date_id, filename)
    );

    CREATE TABLE IF NOT EXISTS activity_summaries (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id  INTEGER NOT NULL REFERENCES class_students(id) ON DELETE CASCADE,
      activity_date_id INTEGER NOT NULL REFERENCES activity_dates(id) ON DELETE CASCADE,
      summary     TEXT NOT NULL DEFAULT '',
      manually_edited INTEGER NOT NULL DEFAULT 0,
      updated_at  TEXT DEFAULT (datetime('now')),
      UNIQUE(student_id, activity_date_id)
    );

    CREATE TABLE IF NOT EXISTS activity_observations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id  INTEGER NOT NULL REFERENCES class_students(id) ON DELETE CASCADE,
      activity_date_id INTEGER NOT NULL REFERENCES activity_dates(id) ON DELETE CASCADE,
      is_absent   INTEGER NOT NULL DEFAULT 0,
      note        TEXT NOT NULL DEFAULT '',
      updated_at  TEXT DEFAULT (datetime('now')),
      UNIQUE(student_id, activity_date_id)
    );

    CREATE TABLE IF NOT EXISTS activity_reflections (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id  INTEGER NOT NULL REFERENCES class_students(id) ON DELETE CASCADE,
      activity_date TEXT NOT NULL,
      topic       TEXT NOT NULL DEFAULT '',
      plus_text   TEXT NOT NULL DEFAULT '',
      minus_text  TEXT NOT NULL DEFAULT '',
      interesting_text TEXT NOT NULL DEFAULT '',
      updated_at  TEXT DEFAULT (datetime('now')),
      UNIQUE(student_id, activity_date)
    );

    CREATE TABLE IF NOT EXISTS activity_semester_summaries (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id  INTEGER NOT NULL UNIQUE REFERENCES class_students(id) ON DELETE CASCADE,
      summary     TEXT NOT NULL DEFAULT '',
      updated_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS activity_class_settings (
      class_id    INTEGER PRIMARY KEY REFERENCES classes(id) ON DELETE CASCADE,
      source_folder TEXT NOT NULL DEFAULT '',
      updated_at  TEXT DEFAULT (datetime('now'))
    );
  `);

  await ensureColumn('classes', 'scoring_filename', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn('classes', 'scoring_filepath', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn('classes', 'comments_filename', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn('classes', 'comments_filepath', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn('subject_domains', 'credit', "REAL NOT NULL DEFAULT 0");
  await ensureColumn('achievement_standards', 'credit', "REAL NOT NULL DEFAULT 0");
  await ensureColumn('class_students', 'personal_num', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn('subject_plan_settings', 'source_filename', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn('subject_plan_settings', 'source_filepath', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn('subject_plan_settings', 'comprehensive_prompt', "TEXT NOT NULL DEFAULT '학기 전체의 활동 요약, 관찰, 성찰을 바탕으로 반복되는 관심, 시도, 변화와 구체적인 사실을 간결하게 종합한다. 학생 이름과 평가·점수는 쓰지 않는다.'");
  await ensureColumn('subject_plan_settings', 'record_chat', "TEXT NOT NULL DEFAULT '[]'");
  await ensureColumn('subject_plan_settings', 'comprehensive_chat', "TEXT NOT NULL DEFAULT '[]'");
  await migrateGeneratedContentTypes();
  await migrateAiBatchJobsContentTypes();

  // domain_eval.excel_col → score 마이그레이션
  await ensureRenameColumn('domain_eval', 'excel_col', 'score');
  await db.execute(
    `DELETE FROM domain_comments
     WHERE domain_name='__SUBJECT_COMPREHENSIVE__' AND type='공통'`
  );
  await db.execute(
    `UPDATE domain_comments
     SET type='세특', title='세특', sort_order=0
     WHERE domain_name='__SUBJECT_COMPREHENSIVE__' AND type='종합'`
  );
  await db.execute(
    `UPDATE domain_comments
     SET title='세특', sort_order=0
     WHERE domain_name='__SUBJECT_COMPREHENSIVE__' AND type='세특'`
  );
  await db.execute(
    `DELETE FROM domain_comments
     WHERE domain_name='__SUBJECT_COMPREHENSIVE__'
       AND type!='세특'`
  );
  await db.execute(
    `DELETE FROM domain_comments
     WHERE domain_name='__SUBJECT_COMPREHENSIVE__'
       AND type='세특'
       AND id NOT IN (
         SELECT MAX(id)
         FROM domain_comments
         WHERE domain_name='__SUBJECT_COMPREHENSIVE__' AND type='세특'
         GROUP BY year, semester, grade, subject
       )`
  );
  await migrateStoredUploadPaths();

  initialized = true;
}

async function migrateStoredUploadPaths(): Promise<void> {
  const legacy = LEGACY_UPLOADS_DIR;
  const db = getClient();
  const pairs = [
    ['classes', 'scoring_filepath'],
    ['classes', 'comments_filepath'],
    ['artifacts', 'filepath'],
    ['activity_files', 'filepath'],
    ['written_exam_files', 'filepath'],
  ] as const;

  for (const [table, column] of pairs) {
    await db.execute({
      sql: `UPDATE ${table}
            SET ${column} = replace(${column}, ?, ?)
            WHERE ${column} LIKE ?`,
      args: [legacy, UPLOADS_DIR, `${legacy}%`],
    });

    const rows = await db.execute(`SELECT id, ${column} AS filepath FROM ${table} WHERE ${column} != ''`);
    for (const row of rows.rows as unknown as Array<{ id: number; filepath: string }>) {
      const current = String(row.filepath || '');
      if (!current || (!path.isAbsolute(current) && !current.startsWith(STORAGE_ROOT))) continue;
      const next = toStoredPath(current);
      if (next !== current) {
        await db.execute({
          sql: `UPDATE ${table} SET ${column}=? WHERE id=?`,
          args: [next, row.id],
        });
      }
    }
  }
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

async function ensureRenameColumn(table: string, oldName: string, newName: string): Promise<void> {
  const rows = await getClient().execute(`PRAGMA table_info(${table})`);
  const hasOld = rows.rows.some((row) => {
    const obj = row as unknown as Record<string, unknown>;
    return obj.name === oldName || (Array.isArray(row) && row[1] === oldName);
  });
  if (hasOld) {
    await getClient().execute(`ALTER TABLE ${table} RENAME COLUMN ${oldName} TO ${newName}`);
  }
}

async function migrateAiBatchJobsContentTypes(): Promise<void> {
  const row = await queryOne<{ sql: string }>(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='ai_batch_jobs'"
  );
  if (!row?.sql || (row.sql.includes("'combined'") && row.sql.includes("'spellcheck'") && row.sql.includes("'activity'"))) return;
  const db = getClient();
  await db.execute('ALTER TABLE ai_batch_jobs RENAME TO ai_batch_jobs_old');
  await db.execute(`
    CREATE TABLE ai_batch_jobs (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_batch_id   TEXT    NOT NULL UNIQUE,
      class_id            INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      domain              TEXT    NOT NULL,
      content_type        TEXT    NOT NULL CHECK(content_type IN ('scoring', 'comments', 'combined', 'spellcheck', 'activity')),
      status              TEXT    NOT NULL DEFAULT 'in_progress',
      request_count       INTEGER NOT NULL DEFAULT 0,
      metadata            TEXT    NOT NULL DEFAULT '{}',
      created_at          TEXT    DEFAULT (datetime('now')),
      updated_at          TEXT    DEFAULT (datetime('now'))
    )
  `);
  await db.execute(`
    INSERT INTO ai_batch_jobs(id, provider_batch_id, class_id, domain, content_type, status, request_count, metadata, created_at, updated_at)
    SELECT id, provider_batch_id, class_id, domain, content_type, status, request_count, metadata, created_at, updated_at
    FROM ai_batch_jobs_old
  `);
  await db.execute('DROP TABLE ai_batch_jobs_old');
}

async function migrateGeneratedContentTypes(): Promise<void> {
  const row = await queryOne<{ sql: string }>(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='generated_content'"
  );
  if (!row?.sql || row.sql.includes("'spellcheck'")) return;
  const db = getClient();
  await db.execute('ALTER TABLE generated_content RENAME TO generated_content_old');
  await db.execute(`
    CREATE TABLE generated_content (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id   INTEGER NOT NULL REFERENCES class_students(id) ON DELETE CASCADE,
      content_type TEXT    NOT NULL CHECK(content_type IN ('scoring', 'comments', 'spellcheck')),
      domain       TEXT    NOT NULL DEFAULT '',
      content      TEXT    NOT NULL DEFAULT '',
      updated_at   TEXT    DEFAULT (datetime('now')),
      UNIQUE(student_id, content_type, domain)
    )
  `);
  await db.execute(`
    INSERT INTO generated_content(id, student_id, content_type, domain, content, updated_at)
    SELECT id, student_id, content_type, domain, content, updated_at
    FROM generated_content_old
  `);
  await db.execute('DROP TABLE generated_content_old');
}

// 편의 함수: SELECT one
type QueryArgs = InValue[];

export async function queryOne<T>(sql: string, args: QueryArgs = []): Promise<T | null> {
  const rs = await getClient().execute({ sql, args });
  if (rs.rows.length === 0) return null;
  return rowToObject<T>(rs.rows[0], rs.columns);
}

// 편의 함수: SELECT many
export async function queryAll<T>(sql: string, args: QueryArgs = []): Promise<T[]> {
  const rs = await getClient().execute({ sql, args });
  return rs.rows.map((row) => rowToObject<T>(row, rs.columns));
}

// 편의 함수: INSERT / UPDATE / DELETE
export async function execute(sql: string, args: QueryArgs = []): Promise<{ lastInsertRowid: bigint | number; rowsAffected: number }> {
  const rs = await getClient().execute({ sql, args });
  return { lastInsertRowid: rs.lastInsertRowid ?? 0, rowsAffected: rs.rowsAffected };
}

// 트랜잭션
export async function transaction<T>(fn: () => Promise<T>): Promise<T> {
  const db = getClient();
  await db.execute('BEGIN');
  try {
    const result = await fn();
    await db.execute('COMMIT');
    return result;
  } catch (e) {
    await db.execute('ROLLBACK');
    throw e;
  }
}

function rowToObject<T>(row: Record<string, unknown>, columns: string[]): T {
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < columns.length; i++) {
    obj[columns[i]] = (row as unknown as unknown[])[i] ?? row[columns[i]];
  }
  return obj as T;
}
