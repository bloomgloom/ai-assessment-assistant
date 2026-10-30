import { entryFilename, type ImportEntry } from './importEntries';
import { matchStudentsByPath, type MatchableStudent } from './studentMatcher';

export type ArtifactImportStatus = 'uploaded' | 'added' | 'updated' | 'unchanged' | 'reflection' | 'unmatched' | 'conflict' | 'date_missing' | 'read_error';

export interface ArtifactImportResult {
  path: string;
  status: ArtifactImportStatus;
  studentId?: number;
  student?: string;
  studentName?: string;
  classNum?: number;
  seatNum?: number;
  date?: string;
  filename?: string;
  reason?: string;
}

export interface ArtifactImportContext<TStudent extends MatchableStudent> {
  entry: ImportEntry;
  path: string;
  filename: string;
  student: TStudent;
}

export type ArtifactImportDecision<TTarget> =
  | { kind: 'result'; result: ArtifactImportResult }
  | { kind: 'read'; target: TTarget };

export interface ArtifactImportPolicy<TStudent extends MatchableStudent, TTarget> {
  include?: (entry: ImportEntry, filename: string) => boolean;
  studentResult?: (student: TStudent) => Partial<ArtifactImportResult>;
  resolve: (context: ArtifactImportContext<TStudent>) => Promise<ArtifactImportDecision<TTarget>>;
  store: (context: ArtifactImportContext<TStudent> & { target: TTarget; buffer: Buffer }) => Promise<ArtifactImportResult>;
}

export interface ArtifactImportSummary {
  total: number;
  matchedStudentIds: Set<number>;
  results: ArtifactImportResult[];
}

function normalizedPath(entry: ImportEntry): string {
  let value = entry.relativePath.normalize('NFC');
  if (value.includes('\uFFFD')) {
    try { value = Buffer.from(entry.relativePath, 'latin1').toString('utf8').normalize('NFC'); } catch {}
  }
  return value;
}

export class ArtifactImportService<TStudent extends MatchableStudent, TTarget> {
  constructor(
    private readonly students: TStudent[],
    private readonly policy: ArtifactImportPolicy<TStudent, TTarget>,
  ) {}

  async run(entries: ImportEntry[]): Promise<ArtifactImportSummary> {
    const results: ArtifactImportResult[] = [];
    const matchedStudentIds = new Set<number>();
    let total = 0;

    for (const entry of entries) {
      const filename = entryFilename(entry);
      if (!filename || this.policy.include?.(entry, filename) === false) continue;
      total += 1;
      const path = normalizedPath(entry);
      const matches = matchStudentsByPath(path, this.students);
      if (matches.length === 0) {
        results.push({ path, status: 'unmatched', reason: '경로에서 학번·이름을 찾지 못했습니다.' });
        continue;
      }
      if (matches.length > 1) {
        results.push({
          path,
          status: 'conflict',
          reason: `여러 학생과 일치: ${matches.map(student => `${student.student_num}${student.name}`).join(', ')}`,
        });
        continue;
      }

      const student = matches[0];
      matchedStudentIds.add(student.id);
      const context = { entry, path, filename, student };
      try {
        const decision = await this.policy.resolve(context);
        if (decision.kind === 'result') {
          results.push(decision.result);
          continue;
        }
        let buffer: Buffer;
        try {
          buffer = await entry.read();
        } catch (error) {
          results.push({
            path,
            status: 'read_error',
            ...this.policy.studentResult?.(student),
            reason: error instanceof Error ? error.message : '파일을 읽지 못했습니다.',
          });
          continue;
        }
        results.push(await this.policy.store({ ...context, target: decision.target, buffer }));
      } catch (error) {
        results.push({
          path,
          status: 'read_error',
          ...this.policy.studentResult?.(student),
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { total, matchedStudentIds, results };
  }
}
