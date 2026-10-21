import { Router, Request, Response } from 'express';
import fs from 'fs';
import { execute, queryAll, queryOne } from '../services/db';
import {
  buildAnthropicMessageParams,
  callLLM,
  createAnthropicMessageBatch,
  createLLMLogSession,
  extractAnthropicText,
  getLLMSettings,
  retrieveAnthropicMessageBatch,
  retrieveAnthropicMessageBatchResults,
  type AnthropicBatchRequest,
  type AnthropicJsonSchema,
  type AnthropicOutputTask,
  type LLMImageAttachment,
  type LLMLogSession,
  type LLMSettings,
} from '../services/llm';
import { extractHwpxText } from '../services/hwpx';
import { imageFileToAttachment, pdfToRedactedJpegAttachments } from '../services/visionArtifacts';
import { buildNotebookExecutionEvidence, buildTabularDataEvidence } from '../services/artifactEvidence';
import { resolveStoredPath } from '../services/storage';
import { assignmentArtifactsForStudent } from '../services/assignmentArtifacts';
import { parseFirstJson } from '../services/json';

const router = Router();
const SUBJECT_COMPREHENSIVE_DOMAIN = '__SUBJECT_COMPREHENSIVE__';

function batchCreateErrorStatus(error: unknown): number {
  return error instanceof Error && error.name === 'ClaudeBatchCreateTimeoutError' ? 504 : 500;
}

interface ArtifactRow {
  id: number;
  filename: string;
  filepath: string;
  mime_type: string;
}

interface GenerateRequest {
  studentId: number;
  domain: string;
  contentType: 'scoring' | 'comments';
  criteriaSetId: number;
}

interface BatchGenerateRequest {
  classId?: number;
  sessionId?: number;
  domain: string;
  contentType: 'scoring' | 'comments' | 'combined';
  criteriaSetId?: number;
  studentIds?: number[];
}

interface ClaudeBatchJobRow {
  id: number;
  provider_batch_id: string;
  class_id: number;
  domain: string;
  content_type: 'scoring' | 'comments' | 'combined' | 'spellcheck';
  status: string;
  request_count: number;
  metadata: string;
}

type GenerationContentType = 'scoring' | 'comments' | 'combined';

interface GenerationTargets {
  scoring?: boolean;
  comments?: boolean;
  comprehensive?: boolean;
}

function targetsForContentType(contentType: GenerationContentType, domain: string): GenerationTargets {
  if (contentType === 'combined') return { scoring: true, comments: true };
  if (contentType === 'scoring') return { scoring: true };
  if (domain === '__SUBJECT_COMPREHENSIVE__') return { comprehensive: true };
  return { comments: true };
}

function customIdSegment(value: string | number): string {
  const segment = String(value)
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
  if (!segment) return 'item';
  return /^[A-Za-z_]/.test(segment) ? segment : `id_${segment}`;
}

function claudeBatchCustomId(studentId: number, domain: string, index: number): string {
  return `student_${customIdSegment(studentId)}__domain_${customIdSegment(domain)}__row_${customIdSegment(index)}`;
}

function schemaKeySegment(value: string): string {
  const segment = value
    .trim()
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return segment || 'item';
}

function scoringSchemaKeys(criteria: EvalCriterion[]): Array<{ criterion: EvalCriterion; key: string }> {
  const used = new Map<string, number>();
  return criteria
    .filter((item) => item.item_type === 'llm')
    .map((criterion) => {
      const base = schemaKeySegment(criterion.name);
      const count = used.get(base) || 0;
      used.set(base, count + 1);
      return { criterion, key: count === 0 ? base : `${base}_${count + 1}` };
    });
}

function commentsSchemaKeys(criteria: CommentsCriterion[]): Array<{ criterion: CommentsCriterion; key: string }> {
  const used = new Map<string, number>();
  return criteria
    .filter((item) =>
      item.type !== '성취기준' &&
      item.type !== '공통' &&
      item.type !== '종합' &&
      item.type !== '세특'
    )
    .map((criterion) => {
      const base = schemaKeySegment(criterion.title || criterion.type);
      const count = used.get(base) || 0;
      used.set(base, count + 1);
      return { criterion, key: count === 0 ? base : `${base}_${count + 1}` };
    });
}

function formatStandardReference(code: unknown, content: unknown): string {
  const text = String(content ?? '').trim();
  if (!text) return '';
  const standardCode = String(code ?? '').trim();
  if (!standardCode) return text;
  const normalizedCode = standardCode.replace(/^\[+|\]+$/g, '');
  if (text.includes(`[${normalizedCode}]`) || text.includes(`[[${normalizedCode}]]`)) return text;
  return `[${normalizedCode}] ${text}`;
}

interface ClassContext {
  year: number;
  semester: number;
  grade: number;
  subject: string;
}

interface EvalCriterion {
  name: string;
  score: string;
  item_type: 'llm' | 'formula';
  rubric: string;
}

interface CommentsCriterion {
  type: string;
  title: string;
  prompt: string;
  extensions: string;
}

const SPELLCHECK_OUTPUT_SCHEMA: AnthropicJsonSchema = {
  type: 'object',
  properties: {
    correctedText: { type: 'string' },
  },
  required: ['correctedText'],
  additionalProperties: false,
};

function parseSpellcheckResult(output: string): { correctedText: string } {
  const parsed = parseFirstJson<{ correctedText?: unknown }>(output, 'object');
  const correctedText = String(parsed.correctedText ?? '').trim();
  if (!correctedText) throw new Error('맞춤법 검사 결과가 비어 있습니다.');
  return { correctedText };
}

function spellcheckPrompt(text: string) {
  return `
다음 텍스트의 맞춤법, 띄어쓰기, 문맥 오류를 교정해줘.
원래 문장의 의미나 말투를 최대한 유지하면서, 어색한 부분만 자연스럽게 다듬어줘.

[중요]
수정 건수나 변경 위치를 판단하거나 반환하지 마.
교정된 전체 본문은 출력 형식의 correctedText 필드에 담아줘.

[원본 텍스트]
${text}
`;
}

function requestAbortSignal(req: Request, res: Response): AbortSignal {
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.on('aborted', abort);
  res.on('close', () => {
    if (!res.writableEnded) abort();
  });
  return controller.signal;
}

router.post('/spellcheck', async (req: Request, res: Response) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: '검사할 텍스트가 없습니다.' });
  const signal = requestAbortSignal(req, res);

  try {
    const settings = await getLLMSettings();
    const output = (await callLLM(
      spellcheckPrompt(text),
      settings,
      signal,
      undefined,
      [],
      0,
      undefined,
      SPELLCHECK_OUTPUT_SCHEMA,
      'subjectComprehensive'
    )).trim();
    res.json(parseSpellcheckResult(output));
  } catch (e) {
    if (signal.aborted) return;
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

router.post('/generate-prompt', async (req: Request, res: Response) => {
  const { prompt, systemPrompt, outputSchema } = req.body as {
    prompt?: string;
    systemPrompt?: string;
    outputSchema?: AnthropicJsonSchema;
  };
  if (!prompt) return res.status(400).json({ error: '프롬프트가 없습니다.' });
  const signal = requestAbortSignal(req, res);

  try {
    const settings = await getLLMSettings();
    const fullPrompt = systemPrompt ? `[System]\n${systemPrompt}\n\n[User]\n${prompt}` : prompt;
    const result = await callLLM(
      fullPrompt,
      settings,
      signal,
      undefined,
      [],
      settings.temperatures.domainManagement,
      undefined,
      outputSchema,
      'domainManagement'
    );
    res.json({ result });
  } catch (e) {
    if (signal.aborted) return;
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

async function getClassContextByStudent(studentId: number): Promise<ClassContext | null> {
  return queryOne<ClassContext>(`
    SELECT c.year, c.semester, c.grade, c.subject
    FROM classes c
    JOIN class_students cs ON cs.class_id = c.id
    WHERE cs.id=?
  `, [studentId]);
}

async function getClassContextByClass(classId?: number): Promise<ClassContext | null> {
  if (classId === undefined) return null;
  return queryOne<ClassContext>(
    'SELECT year, semester, grade, subject FROM classes WHERE id=?',
    [classId]
  );
}

async function getDomainEvalCriteria(classContext: ClassContext | null, domain: string): Promise<EvalCriterion[]> {
  if (!classContext) return [];
  return queryAll<EvalCriterion>(
    `SELECT name, score, item_type, rubric
     FROM domain_eval
     WHERE year=? AND semester=? AND grade=? AND subject=? AND domain_name=?
     ORDER BY sort_order, id`,
    [classContext.year, classContext.semester, classContext.grade, classContext.subject, domain]
  );
}

async function getDomainCommentsCriteria(classContext: ClassContext | null, domain: string): Promise<CommentsCriterion[]> {
  if (!classContext) return [];
  return queryAll<CommentsCriterion>(
    `SELECT type, title, prompt, extensions
     FROM domain_comments
     WHERE year=? AND semester=? AND grade=? AND subject=? AND domain_name=?
     ORDER BY sort_order, id`,
    [classContext.year, classContext.semester, classContext.grade, classContext.subject, domain]
  );
}

async function getDomainEvaluationType(classContext: ClassContext | null, domain: string): Promise<string> {
  if (!classContext || domain === SUBJECT_COMPREHENSIVE_DOMAIN) return '수행';
  const row = await queryOne<{ eval_type: string }>(
    `SELECT eval_type
     FROM subject_domains
     WHERE year=? AND semester=? AND grade=? AND subject=? AND name=?
     ORDER BY CASE eval_type WHEN '수행' THEN 0 WHEN '지필' THEN 1 ELSE 2 END, id
     LIMIT 1`,
    [classContext.year, classContext.semester, classContext.grade, classContext.subject, domain]
  );
  return row?.eval_type === '지필' ? '지필' : '수행';
}

function generationRolePrompt(
  type: 'scoring' | 'comments' | 'comprehensive',
  classContext: ClassContext | null,
  domain: string,
  evaluationType = '수행',
) {
  const year = classContext?.year ?? '미지정';
  const semester = classContext?.semester ?? '미지정';
  const grade = classContext?.grade ?? '미지정';
  const subject = classContext?.subject || '미지정';

  if (type === 'scoring') {
    return `너는 고등학교 ${year}학년도 ${semester}학기 ${grade}학년 ${subject} 교과의 ${evaluationType}평가 "${domain}"영역을 채점하는 교사이다. 제시된 채점 기준(성취기준·루브릭·배점)에 따라 학생의 산출물을 일관성 있고 객관적으로 채점한다. 결과물은 수행평가 점수로 그대로 입력할 수 있는 상태여야 한다.`;
  }
  if (type === 'comments') {
    return `너는 고등학교 ${year}학년도 ${semester}학기 ${grade}학년 ${subject} 교과의 ${evaluationType}평가 '${domain}' 영역을 추후 학교생활기록부의 과목별 세부능력 및 특기사항(이하 세특)에 반영하기 위해, 사실에 근거하여 일관성 있고 객관적으로 정리하여 기록하는 교사이다.

너의 결과물은 세특의 완성본이 아니라, 추후 세특을 작성하기 위한 관찰 기록(근거자료)이다. 따라서 이 단계의 임무는 학생을 평가하는 것이 아니라 평가의 재료를 남기는 것이다. 역량에 대한 판단과 그 서술은 세특 작성 단계에서 이루어지므로, 여기서는 학생이 무엇을 어떻게 했는지를 구체적 사실로 남기고 판단은 세특 단계에 넘긴다.

학생의 산출물 원본을 직접 볼 수 있는 단계는 이 단계뿐이며, 세특 작성 단계는 이 기록만을 근거로 삼는다. 원본에 있던 구체적 사실이 이 기록에서 사라지면 이후에 복구할 수 없으므로, 사실을 요약해 없애지 말고 판단을 붙일 수 있는 재료가 남도록 기록한다.`;
  }
  return `너는 고등학교 ${year}학년도 ${semester}학기 ${grade}학년 ${subject} 교과의 과목별 세부능력 및 특기사항(이하 세특)을 작성하는 교사이다. 학생의 산출물에 기초하여 학생의 능력을 객관적으로 파악하고 잠재력을 발굴하되, 따뜻하고 통찰력 있는 시선으로 학생의 세부능력과 특기가 구체적으로 드러나도록 세특을 작성한다. 결과물은 학교생활기록부에 그대로 입력할 수 있는 상태여야 한다.`;
}

interface ScoringResultItem {
  score?: unknown;
  reason?: unknown;
}

function findJsonArrays(value: string): unknown[][] {
  const arrays: unknown[][] = [];
  for (let start = 0; start < value.length; start += 1) {
    if (value[start] !== '[') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let end = start; end < value.length; end += 1) {
      const char = value[end];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '[') depth += 1;
      else if (char === ']') {
        depth -= 1;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(value.slice(start, end + 1));
            if (Array.isArray(parsed)) arrays.push(parsed);
          } catch { /* ignore invalid candidate */ }
          break;
        }
      }
    }
  }
  return arrays;
}

function isScoringResultArray(value: unknown[]) {
  return value.every((item) => {
    if (Array.isArray(item)) return item.length >= 1;
    return !!item && typeof item === 'object' && 'score' in item;
  });
}

function normalizeScoringResultItems(parsed: unknown[]): ScoringResultItem[] {
  return parsed.map((item) => {
    if (Array.isArray(item)) return { score: item[0], reason: item[1] };
    if (item && typeof item === 'object') return item as ScoringResultItem;
    return { score: undefined, reason: undefined };
  });
}

function normalizeScoringResultObject(parsed: Record<string, unknown>, criteria: EvalCriterion[]): ScoringResultItem[] {
  return scoringSchemaKeys(criteria).map(({ criterion, key }) => {
    const value = parsed[key] ?? parsed[criterion.name];
    if (value && typeof value === 'object') return value as ScoringResultItem;
    return { score: undefined, reason: undefined };
  });
}

function buildScoringContent(result: string, criteria: EvalCriterion[]): string {
  const llmItems = criteria.filter((item) => item.item_type === 'llm');
  const integerPattern = /^-?\d+$/;
  let items: ScoringResultItem[] = [];
  const content: Record<string, string | number | Record<string, string>> = {};
  const reasons: Record<string, string> = {};

  let parsedScoring = false;
  try {
    const parsedObject = parseFirstJson<unknown>(result, 'object');
    if (parsedObject && typeof parsedObject === 'object' && !Array.isArray(parsedObject)) {
      items = normalizeScoringResultObject(parsedObject as Record<string, unknown>, llmItems);
      parsedScoring = true;
    }
  } catch {
    parsedScoring = false;
  }
  if (!parsedScoring) {
    try {
      const arrays = findJsonArrays(result);
      const expected = llmItems.length;
      const parsed = arrays.find((array) => array.length === expected && isScoringResultArray(array))
        ?? arrays.find(isScoringResultArray);
      if (!parsed) throw new Error('JSON 배열이 아닙니다.');
      items = normalizeScoringResultItems(parsed);
    } catch {
      const preview = result.replace(/\s+/g, ' ').trim().slice(0, 160);
      throw new Error(`채점 결과가 JSON 객체 형식으로 제시되지 않아 작성하지 않았습니다. 출력: ${preview || '(빈 응답)'}`);
    }
  }

  if (llmItems.length > 0) {
    const invalid = items.length !== llmItems.length || items.some((item, index) => {
      const value = String(item.score ?? '').trim();
      if (!integerPattern.test(value)) return true;
      const score = Number(value);
      return score !== 0 && score !== criterionFullScore(llmItems[index]);
    });
    if (invalid) {
      const preview = result.replace(/\s+/g, ' ').trim().slice(0, 160);
      throw new Error(`채점 결과가 항목 수(${llmItems.length})에 맞고 점수가 0 또는 배점인 JSON 객체 형식으로 제시되지 않아 작성하지 않았습니다. 출력: ${preview || '(빈 응답)'}`);
    }
  }

  llmItems.forEach((item, index) => {
    const resultItem = items[index] || {};
    content[item.name] = String(resultItem.score ?? '').trim();
    reasons[item.name] = String(resultItem.reason ?? '').trim();
  });
  if (Object.values(reasons).some(Boolean)) content.__reasons = reasons;

  const base = criteria
    .filter((item) => item.item_type === 'formula')
    .reduce((sum, item) => sum + (Number(item.score) || 0), 0);
  const scoreTotal = llmItems.reduce((sum, item) => sum + (Number(content[item.name]) || 0), 0);
  content.total = base + scoreTotal;

  return JSON.stringify(content);
}

function buildCommentsContent(result: string, criteria: CommentsCriterion[]): string {
  const items = criteria.filter(item =>
    item.type !== '성취기준' &&
    item.type !== '공통' &&
    item.type !== '종합' &&
    item.type !== '세특'
  );
  if (items.length === 0) return JSON.stringify({ text: result.trim() });

  let parsed: unknown;
  try {
    parsed = parseFirstJson<unknown>(result, 'object');
  } catch {
    const preview = result.replace(/\s+/g, ' ').trim().slice(0, 160);
    throw new Error(`기록 결과가 JSON 객체 형식으로 제시되지 않아 작성하지 않았습니다. 출력: ${preview || '(빈 응답)'}`);
  }

  const content: Record<string, string> = {};
  const byTitle = new Map<string, unknown>();
  if (Array.isArray(parsed)) {
    parsed.forEach((value, index) => {
      if (!value || typeof value !== 'object') return;
      const obj = value as { title?: unknown; type?: unknown };
      const title = String(obj.title ?? obj.type ?? '').trim();
      if (title) byTitle.set(title, value);
      if (items[index]?.title && !byTitle.has(items[index].title)) byTitle.set(items[index].title, value);
    });
  } else if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    commentsSchemaKeys(criteria).forEach(({ criterion, key }) => {
      const value = obj[key] ?? obj[criterion.title] ?? obj[criterion.type];
      if (value !== undefined) byTitle.set(criterion.title, value);
    });
  }

  const missing: string[] = [];
  items.forEach((criterion) => {
    const value = byTitle.get(criterion.title) ?? byTitle.get(criterion.type);
    const text = value && typeof value === 'object'
      ? String((value as { text?: unknown; content?: unknown }).text ?? (value as { content?: unknown }).content ?? '').trim()
      : String(value ?? '').trim();
    content[criterion.title] = text;
    if (!text) missing.push(criterion.title);
  });
  if (missing.length) {
    content.__llmError = `기록 결과에서 다음 항목이 누락되어 빈칸으로 두었습니다: ${missing.join(', ')}`;
    content.__llmErrorResult = result;
  }
  return JSON.stringify(content);
}

function hasStructuredCommentsCriteria(criteria: CommentsCriterion[]): boolean {
  return criteria.some(item =>
    item.type !== '성취기준' &&
    item.type !== '공통' &&
    item.type !== '종합' &&
    item.type !== '세특'
  );
}

function buildEnvelopeContents(
  result: string,
  targets: GenerationTargets,
  evalCriteria: EvalCriterion[],
  commentsCriteria: CommentsCriterion[],
) {
  let parsed: unknown;
  try {
    parsed = parseFirstJson<unknown>(result, 'object');
  } catch {
    const preview = result.replace(/\s+/g, ' ').trim().slice(0, 160);
    throw new Error(`생성 결과가 JSON 객체 형식이 아니어서 작성하지 않았습니다. 출력: ${preview || '(빈 응답)'}`);
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('생성 결과가 JSON 객체 형식이 아닙니다.');
  const obj = parsed as Record<string, unknown>;

  const contents: { scoringContent?: string; commentsContent?: string; comprehensiveContent?: string } = {};
  if (targets.scoring) {
    contents.scoringContent = buildScoringContent(JSON.stringify(obj.scoring ?? {}), evalCriteria);
  }
  if (targets.comments) {
    const commentsValue = obj.comments;
    if (hasStructuredCommentsCriteria(commentsCriteria)) {
      contents.commentsContent = buildCommentsContent(JSON.stringify(commentsValue ?? {}), commentsCriteria);
    } else {
      contents.commentsContent = JSON.stringify({
        text: String(typeof commentsValue === 'string' ? commentsValue : ((commentsValue as { text?: unknown } | undefined)?.text ?? '')).trim(),
      });
    }
  }
  if (targets.comprehensive) {
    const value = obj.comprehensive ?? obj.comments;
    contents.comprehensiveContent = JSON.stringify({
      text: String(typeof value === 'string' ? value : ((value as { text?: unknown } | undefined)?.text ?? '')).trim(),
    });
  }
  return contents;
}

function criterionFullScore(item: EvalCriterion): number {
  const score = Number(item.score);
  return Number.isFinite(score) ? Math.round(score) : 0;
}

function scoringOutputSchema(criteria: EvalCriterion[]): AnthropicJsonSchema {
  const items = scoringSchemaKeys(criteria);
  return {
    type: 'object',
    properties: Object.fromEntries(items.map(({ criterion, key }) => [key, {
      type: 'object',
      properties: {
        score: { type: 'integer', enum: [0, criterionFullScore(criterion)] },
        reason: { type: 'string' },
      },
      required: ['score', 'reason'],
      additionalProperties: false,
    }])),
    required: items.map((item) => item.key),
    additionalProperties: false,
  };
}

function commentsOutputSchema(criteria: CommentsCriterion[]): AnthropicJsonSchema {
  if (hasStructuredCommentsCriteria(criteria)) {
    const items = commentsSchemaKeys(criteria);
    return {
      type: 'object',
      properties: Object.fromEntries(items.map(({ key }) => [key, { type: 'string' }])),
      required: items.map((item) => item.key),
      additionalProperties: false,
    };
  }
  return {
    type: 'object',
    properties: {
      text: { type: 'string' },
    },
    required: ['text'],
    additionalProperties: false,
  };
}

function schemaForGeneration(contentType: GenerationContentType, domain: string, evalCriteria: EvalCriterion[], commentsCriteria: CommentsCriterion[]): AnthropicJsonSchema | undefined {
  const targets = targetsForContentType(contentType, domain);
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  if (targets.scoring) {
    properties.scoring = scoringOutputSchema(evalCriteria);
    required.push('scoring');
  }
  if (targets.comments) {
    properties.comments = hasStructuredCommentsCriteria(commentsCriteria)
      ? commentsOutputSchema(commentsCriteria)
      : { type: 'string' };
    required.push('comments');
  }
  if (targets.comprehensive) {
    properties.comprehensive = {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    };
    required.push('comprehensive');
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

function anthropicTaskForGeneration(contentType: GenerationContentType, domain: string): AnthropicOutputTask {
  if (domain === SUBJECT_COMPREHENSIVE_DOMAIN) return 'subjectComprehensive';
  if (contentType === 'scoring') return 'recordsScoring';
  return 'recordsComments';
}

function appendTaskInstruction(
  parts: string[],
  taskInstruction: string,
) {
  parts.push(taskInstruction);
}

function buildDefaultScoringContent(criteria: EvalCriterion[]): string {
  const content: Record<string, string | number> = {};
  let base = 0;
  for (const item of criteria) {
    if (item.item_type === 'formula') {
      base += Number(item.score) || 0;
    } else {
      content[item.name] = 0;
    }
  }
  content.total = base;
  return JSON.stringify(content);
}

const FILE_REFERENCE_EXTENSIONS = [
  'csv', 'tsv', 'xlsx', 'xls', 'json', 'txt', 'md', 'ipynb', 'py', 'js', 'ts', 'html', 'css',
  'xml', 'sql', 'pkl', 'pickle', 'parquet', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'hwpx',
];
const FILE_REFERENCE_EXT_PATTERN = FILE_REFERENCE_EXTENSIONS.join('|');
const UNQUOTED_FILE_REFERENCE_PATTERN = new RegExp(
  `(?<![\\p{L}\\p{N}_./\\\\'"\`"-])((?:\\.{1,2}[/\\\\])?(?:[^\\s'"\`<>(){}\\[\\],;:]+[/\\\\])*[^\\s'"\`<>(){}\\[\\],;:]+\\s*\\.(${FILE_REFERENCE_EXT_PATTERN}))(?![\\p{L}\\p{N}_./\\\\'"\`"-])`,
  'giu'
);
const QUOTED_TEXT_PATTERN = /(['"`])([^'"`\r\n]{0,300})\1/g;

interface ArtifactPrivacyMapper {
  artifactName(artifact: ArtifactRow): string;
  sanitizeText(text: string): string;
}

function createArtifactPrivacyMapper(artifacts: ArtifactRow[]): ArtifactPrivacyMapper {
  const mapping = new Map<string, string>();
  let nextFileIndex = 1;

  const anonymize = (rawReference: string): string => {
    const key = rawReference.normalize('NFC');
    const existing = mapping.get(key);
    if (existing) return existing;

    const ext = key.match(/\.([A-Za-z0-9]+)\s*$/)?.[1]?.toLowerCase();
    const anonymized = `file_${String(nextFileIndex).padStart(3, '0')}${ext ? `.${ext}` : ''}`;
    nextFileIndex += 1;
    mapping.set(key, anonymized);
    return anonymized;
  };

  for (const artifact of artifacts) anonymize(artifact.filename);

  return {
    artifactName(artifact: ArtifactRow): string {
      return anonymize(artifact.filename);
    },
    sanitizeText(text: string): string {
      return text
        .replace(QUOTED_TEXT_PATTERN, (_match, quote: string, content: string) => {
          const sanitizedContent = content.replace(UNQUOTED_FILE_REFERENCE_PATTERN, (_contentMatch, reference: string) => {
            return anonymize(reference);
          });
          return `${quote}${sanitizedContent}${quote}`;
        })
        .replace(UNQUOTED_FILE_REFERENCE_PATTERN, (_match, reference: string) => {
          return anonymize(reference);
        });
    },
  };
}

interface DecodedTextBuffer {
  text: string;
  encoding: string;
}

function decodeTextBufferWithEncoding(buffer: Buffer): DecodedTextBuffer {
  const encodings = ['utf-8', 'euc-kr', 'utf-16le'];
  for (const encoding of encodings) {
    try {
      const decoded = new TextDecoder(encoding, { fatal: encoding === 'utf-8' }).decode(buffer);
      if (!decoded.includes('\uFFFD')) return { text: decoded, encoding };
    } catch { /* try next encoding */ }
  }
  return { text: buffer.toString('utf8'), encoding: 'utf-8-fallback' };
}

function decodeTextBuffer(buffer: Buffer): string {
  return decodeTextBufferWithEncoding(buffer).text;
}

function normalizeNotebookSource(source: unknown): string {
  if (Array.isArray(source)) return source.join('');
  return typeof source === 'string' ? source : '';
}

function extractIpynbInputText(buffer: Buffer, options: { skipFirstMarkdownCell?: boolean } = {}): string {
  const notebook = JSON.parse(decodeTextBuffer(buffer)) as {
    cells?: { cell_type?: string; source?: unknown }[];
  };
  if (!Array.isArray(notebook.cells)) return '';

  const chunks: string[] = [];
  notebook.cells.forEach((cell, index) => {
    if (options.skipFirstMarkdownCell && index === 0 && cell.cell_type === 'markdown') {
      return;
    }
    const source = normalizeNotebookSource(cell.source).trim();
    if (!source) return;
    if (cell.cell_type === 'markdown') {
      chunks.push(`[Markdown Cell ${index + 1}]\n${source}`);
    } else if (cell.cell_type === 'code') {
      chunks.push(`[Code Cell ${index + 1}]\n\`\`\`python\n${source}\n\`\`\``);
    }
  });
  return chunks.join('\n\n');
}

function extractCsvInputText(buffer: Buffer): DecodedTextBuffer {
  const decoded = decodeTextBufferWithEncoding(buffer);
  return { ...decoded, text: decoded.text.trim() };
}

function stripLeadingCStyleBlockComment(code: string): string {
  return code.replace(/^(\uFEFF?\s*)\/\*[\s\S]*?\*\/[ \t]*(?:\r?\n)?/, '$1');
}

function stripLeadingPythonDocstring(code: string): string {
  return code.replace(/^(\uFEFF?\s*)("""|''')[\s\S]*?\2[ \t]*(?:\r?\n)?/, '$1');
}

function stripLeadingCodeIntroBlock(code: string, ext: string): string {
  if (ext === 'py') return stripLeadingPythonDocstring(code);

  const cStyleBlockCommentExts = new Set([
    'c', 'cpp', 'h', 'java', 'js', 'jsx', 'ts', 'tsx', 'css', 'sql',
  ]);
  if (cStyleBlockCommentExts.has(ext)) return stripLeadingCStyleBlockComment(code);

  return code;
}

async function appendArtifactContents(
  parts: string[],
  artifacts: ArtifactRow[],
  settings: Pick<LLMSettings, 'artifactStripIntroBlocks' | 'artifactStripIntroBlocksDeprecated' | 'pdfRedactionTopCm'>,
  attachments: LLMImageAttachment[] = [],
): Promise<boolean> {
  let hasContent = false;
  const privacyMapper = createArtifactPrivacyMapper(artifacts);
  const codeExts: Record<string, string> = {
    py: 'python', js: 'javascript', ts: 'typescript', jsx: 'javascript', tsx: 'typescript',
    c: 'c', cpp: 'cpp', h: 'c', java: 'java', html: 'html', css: 'css', sql: 'sql', json: 'json',
  };

  for (const [index, artifact] of artifacts.entries()) {
    const ext = artifact.filename.split('.').pop()?.toLowerCase() || '';
    const filepath = resolveStoredPath(artifact.filepath);
    const resolvedArtifact = { ...artifact, filepath };
    const promptLabel = `산출물 ${index + 1}: ${privacyMapper.artifactName(artifact)}`;
    if (ext === 'hwpx') {
      try {
        const text = privacyMapper.sanitizeText(
          await extractHwpxText(fs.readFileSync(filepath), {
            skipFirstTableRow: settings.artifactStripIntroBlocksDeprecated,
          })
        );
        if (text) {
          const note = settings.artifactStripIntroBlocksDeprecated
            ? 'HWPX XML 텍스트 추출: 첫 표 행 제외'
            : 'HWPX XML 텍스트 추출';
          parts.push(`[${promptLabel}]\n[${note}]\n${text}\n---`);
          hasContent = true;
        }
      } catch { /* skip */ }
    } else if (ext === 'ipynb') {
      try {
        const text = privacyMapper.sanitizeText(
          extractIpynbInputText(fs.readFileSync(filepath), {
            skipFirstMarkdownCell: settings.artifactStripIntroBlocksDeprecated,
          })
        );
        if (text) {
          const note = settings.artifactStripIntroBlocksDeprecated
            ? 'Jupyter Notebook 입력 추출: 첫 마크다운 셀 및 실행 결과 제외'
            : 'Jupyter Notebook 입력 추출: 실행 결과 제외';
          parts.push(`[${promptLabel}]\n[${note}]\n${text}\n---`);
          hasContent = true;
        }
      } catch { /* skip */ }
      try {
        const evidence = await buildNotebookExecutionEvidence(
          resolvedArtifact,
          artifacts.map((item) => ({ ...item, filepath: resolveStoredPath(item.filepath) })),
          privacyMapper.artifactName(artifact),
          { skipFirstMarkdownCell: settings.artifactStripIntroBlocksDeprecated },
        );
        const text = privacyMapper.sanitizeText(evidence.text);
        if (text) {
          parts.push(`[${promptLabel}]\n${text}\n---`);
          hasContent = true;
        }
        attachments.push(...evidence.attachments);
      } catch { /* skip */ }
    } else if (['csv', 'tsv', 'xlsx', 'xls'].includes(ext)) {
      try {
        const text = privacyMapper.sanitizeText(await buildTabularDataEvidence(resolvedArtifact));
        if (text) {
          parts.push(`[${promptLabel}]\n${text}\n---`);
          hasContent = true;
        }
      } catch { /* skip */ }
    } else if (codeExts[ext]) {
      try {
        const rawCode = fs.readFileSync(filepath, 'utf-8');
        const code = privacyMapper.sanitizeText(
          settings.artifactStripIntroBlocks ? stripLeadingCodeIntroBlock(rawCode, ext) : rawCode
        );
        parts.push(`[${promptLabel}]\n\`\`\`${codeExts[ext]}\n${code}\n\`\`\`\n---`);
        hasContent = true;
      } catch { /* skip */ }
    } else if (artifact.mime_type === 'text/plain' || ext === 'txt') {
      try {
        let text: string;
        try {
          text = fs.readFileSync(filepath, 'utf-8');
        } catch {
          text = fs.readFileSync(filepath, 'utf16le');
        }
        text = privacyMapper.sanitizeText(text);
        parts.push(`[${promptLabel}]\n${text}\n---`);
        hasContent = true;
      } catch { /* skip */ }
    } else if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) {
      try {
        attachments.push(imageFileToAttachment(filepath, privacyMapper.artifactName(artifact), ext));
        parts.push(`[${promptLabel}] (이미지 파일 첨부)\n---`);
        hasContent = true;
      } catch { /* skip */ }
    } else if (artifact.mime_type === 'application/pdf' || ext === 'pdf') {
      try {
        const topHeightCm = settings.artifactStripIntroBlocks ? settings.pdfRedactionTopCm : 0;
        const pdfAttachments = await pdfToRedactedJpegAttachments(
          filepath,
          privacyMapper.artifactName(artifact),
          topHeightCm,
        );
        attachments.push(...pdfAttachments);
        parts.push(`[${promptLabel}] (원본 PDF를 LLM 입력용 이미지 ${pdfAttachments.length}쪽으로 변환해 첨부${topHeightCm > 0 ? `, 첫 페이지 상단 ${topHeightCm}cm 제거` : ''})\n---`);
        if (pdfAttachments.length > 0) hasContent = true;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        throw new Error(`${promptLabel}의 PDF 이미지 변환에 실패했습니다. 채점을 중단했습니다. ${message}`);
      }
    }
  }

  return hasContent;
}

interface PreparedGeneration {
  studentId: number;
  prompt: string;
  cachePrefix?: string;
  attachments: LLMImageAttachment[];
  evalCriteria: EvalCriterion[];
  commentsCriteria: CommentsCriterion[];
  defaultContent?: string;
  error?: string;
}

function appendScoringCriteriaBlocks(parts: string[], evalCriteria: EvalCriterion[]) {
  parts.push('[채점 기준]');
  const commonRubric = evalCriteria.find((i) => i.item_type === 'formula')?.rubric?.trim();
  if (commonRubric) parts.push(`[채점 공통 기준]\n${commonRubric}`);
  for (const item of evalCriteria.filter((i) => i.item_type === 'llm')) {
    parts.push(`- ${item.name} (${item.score}): ${item.rubric}`);
  }
  parts.push('---');
}

function appendStandardReferenceBlock(parts: string[], commentsCriteria: CommentsCriterion[]) {
  const standardRefs = commentsCriteria.filter((c) => c.type === '성취기준');
  if (!standardRefs.length) return;
  const stdParts: string[] = [];
  for (const ref of standardRefs) {
    try {
      const ext = JSON.parse(ref.extensions || '{}');
      const formatted = formatStandardReference(ext.code, ext.content);
      if (formatted) stdParts.push(formatted);
    } catch { /* skip */ }
  }
  if (stdParts.length) parts.push(`[성취 기준]\n${stdParts.join('\n')}\n---`);
}

function structuredRecordCriteria(commentsCriteria: CommentsCriterion[]) {
  const commonCriterion = commentsCriteria.find((c) => c.type === '공통');
  const regularCriteria = commentsCriteria.filter((c) => !['성취기준', '공통', '종합', '세특'].includes(c.type));
  const hasRecordCriterion = regularCriteria.some((item) => item.prompt?.trim());
  return { commonCriterion, regularCriteria, hasRecordCriterion };
}

function appendRecordCriteriaBlocks(parts: string[], commentsCriteria: CommentsCriterion[]) {
  appendStandardReferenceBlock(parts, commentsCriteria);
  const { commonCriterion, regularCriteria, hasRecordCriterion } = structuredRecordCriteria(commentsCriteria);
  if (commonCriterion?.prompt) parts.push(`[기록 공통 기준]\n${commonCriterion.prompt}\n---`);
  for (const item of regularCriteria) {
    if (item.prompt) parts.push(`[기록 항목: ${item.title || item.type}]\n${item.prompt}\n---`);
  }
  return hasRecordCriterion;
}

async function appendComprehensiveCommentsBlocks(parts: string[], studentSpecificParts: string[], studentId: number, classContext: ClassContext | null) {
  const comprehensiveCriteria = await getDomainCommentsCriteria(classContext, '__SUBJECT_COMPREHENSIVE__');
  const comprehensiveCriterion =
    comprehensiveCriteria.find((c) => c.type === '세특') ??
    comprehensiveCriteria.find((c) => c.type === '종합');
  const comprehensivePrompt = comprehensiveCriterion?.prompt?.trim();
  if (!comprehensivePrompt) return { ok: false as const, error: '세특 기준 없음' };
  parts.push(`[세특 기준]\n${comprehensivePrompt}\n---`);

  const domainSummaries = await queryAll<{ domain: string; content: string }>(
    `SELECT domain, content FROM generated_content WHERE student_id=? AND content_type='comments' AND domain != '__SUBJECT_COMPREHENSIVE__' ORDER BY rowid`,
    [studentId]
  );
  if (domainSummaries.length) {
    studentSpecificParts.push('[학생별 영역별 수행 요약]');
    for (const ds of domainSummaries) {
      let text = ds.content;
      try {
        const parsed = JSON.parse(ds.content) as Record<string, unknown>;
        text = parsed.text
          ? String(parsed.text)
          : Object.entries(parsed)
              .filter(([key]) => !key.startsWith('__'))
              .map(([key, value]) => `[${key}]\n${String(value ?? '')}`)
              .join('\n\n');
      } catch { /* use raw */ }
      studentSpecificParts.push(`[${ds.domain}]\n${text}\n---`);
    }
  }
  return { ok: true as const };
}

async function prepareGenerationForStudent(params: {
  student: { id: number; name: string };
  domain: string;
  contentType: 'scoring' | 'comments';
  criteriaSetId?: number;
  classContext: ClassContext | null;
  settings: Pick<LLMSettings, 'artifactStripIntroBlocks' | 'artifactStripIntroBlocksDeprecated' | 'pdfRedactionTopCm'>;
}): Promise<PreparedGeneration> {
  const { student, domain, contentType, criteriaSetId, classContext, settings } = params;
  let evalCriteria: EvalCriterion[] = [];
  let commentsCriteria: CommentsCriterion[] = [];
  const artifacts = await assignmentArtifactsForStudent(student.id, domain) as ArtifactRow[];
  const criteriaSet = criteriaSetId
    ? await queryOne<{ mode: string }>('SELECT * FROM criteria_sets WHERE id=?', [criteriaSetId])
    : { mode: contentType === 'comments' ? '세특' : '평가' };
  if (!criteriaSet) return { studentId: student.id, prompt: '', attachments: [], evalCriteria, commentsCriteria, error: '기준 없음' };

  const evaluationType = await getDomainEvaluationType(classContext, domain);
  const roleType = contentType === 'scoring'
    ? 'scoring'
    : domain === SUBJECT_COMPREHENSIVE_DOMAIN
      ? 'comprehensive'
      : 'comments';
  const parts: string[] = [generationRolePrompt(roleType, classContext, domain, evaluationType), '---'];
  const studentSpecificParts: string[] = [];
  let cachePrefix: string | undefined;

  if (criteriaSet.mode === '세특') {
    if (domain === '__SUBJECT_COMPREHENSIVE__') {
      const comprehensive = await appendComprehensiveCommentsBlocks(parts, studentSpecificParts, student.id, classContext);
      if (!comprehensive.ok) return { studentId: student.id, prompt: '', attachments: [], evalCriteria, commentsCriteria, error: comprehensive.error };
      cachePrefix = parts.length > 0 ? parts.join('\n\n') : undefined;
    } else {
      commentsCriteria = await getDomainCommentsCriteria(classContext, domain);
      const hasRecordCriterion = appendRecordCriteriaBlocks(parts, commentsCriteria);

      evalCriteria = await getDomainEvalCriteria(classContext, domain);
      if (evalCriteria.length) {
        const scoring = await queryOne<{ content: string }>(
          `SELECT content FROM generated_content WHERE student_id=? AND content_type='scoring' AND domain=?`,
          [student.id, domain]
        );
        let scoringData: Record<string, unknown> = {};
        if (scoring) { try { scoringData = JSON.parse(scoring.content); } catch { /* skip */ } }
        const llmItems = evalCriteria.filter((i) => i.item_type === 'llm');
        if (llmItems.length) {
          studentSpecificParts.push(`[학생별 채점 영역 및 획득 점수]\n${llmItems.map((item) => `- ${item.name}: 배점 ${item.score}점 / 획득 ${scoringData[item.name] ?? '미채점'}점`).join('\n')}\n---`);
        }
      }
      if (!hasRecordCriterion) return { studentId: student.id, prompt: '', attachments: [], evalCriteria, commentsCriteria, error: '기록 기준 없음' };
    }
  } else {
    evalCriteria = await getDomainEvalCriteria(classContext, domain);
    if (!evalCriteria.length) return { studentId: student.id, prompt: '', attachments: [], evalCriteria, commentsCriteria, error: '채점 기준 없음' };
    appendScoringCriteriaBlocks(parts, evalCriteria);
  }

  if (!cachePrefix) cachePrefix = parts.length > 0 ? parts.join('\n\n') : undefined;
  parts.push(...studentSpecificParts);
  const attachments: LLMImageAttachment[] = [];
  const hasContent = await appendArtifactContents(parts, artifacts, settings, attachments);

  if (!hasContent && artifacts.length === 0 && contentType === 'scoring') {
    return { studentId: student.id, prompt: '', attachments, evalCriteria, commentsCriteria, defaultContent: buildDefaultScoringContent(evalCriteria) };
  }
  if (!hasContent && artifacts.length === 0 && contentType === 'comments' && domain !== '__SUBJECT_COMPREHENSIVE__') {
    return { studentId: student.id, prompt: '', attachments, evalCriteria, commentsCriteria, error: '산출물 없음' };
  }

  const taskInstruction = criteriaSet.mode === '세특'
    ? domain === '__SUBJECT_COMPREHENSIVE__'
      ? '위 내용을 종합하여 학생의 역량이 잘 드러나도록 과목별 세부능력 및 특기사항을 작성해주세요.'
      : '위 기준과 학생 산출물을 분석하여 각 항목에 대응하는 활동 기록을 작성해주세요.'
    : '채점 기준에 따라 학생 산출물을 채점해주세요.';
  appendTaskInstruction(parts, taskInstruction);

  return { studentId: student.id, prompt: parts.join('\n\n'), cachePrefix, attachments, evalCriteria, commentsCriteria };
}

async function prepareCombinedGenerationForStudent(params: {
  student: { id: number; name: string };
  domain: string;
  classContext: ClassContext | null;
  settings: Pick<LLMSettings, 'artifactStripIntroBlocks' | 'artifactStripIntroBlocksDeprecated' | 'pdfRedactionTopCm'>;
}): Promise<PreparedGeneration> {
  const { student, domain, classContext, settings } = params;
  const evalCriteria = await getDomainEvalCriteria(classContext, domain);
  const commentsCriteria = await getDomainCommentsCriteria(classContext, domain);
  const evaluationType = await getDomainEvaluationType(classContext, domain);
  const parts: string[] = [
    generationRolePrompt('scoring', classContext, domain, evaluationType),
    generationRolePrompt('comments', classContext, domain, evaluationType),
    '---',
  ];

  if (!evalCriteria.length) return { studentId: student.id, prompt: '', attachments: [], evalCriteria, commentsCriteria, error: '채점 기준 없음' };
  const hasRecordCriterion = structuredRecordCriteria(commentsCriteria).hasRecordCriterion;
  if (!hasRecordCriterion) return { studentId: student.id, prompt: '', attachments: [], evalCriteria, commentsCriteria, error: '기록 기준 없음' };

  appendScoringCriteriaBlocks(parts, evalCriteria);
  appendRecordCriteriaBlocks(parts, commentsCriteria);

  const cachePrefix = parts.join('\n\n');

  const artifacts = await assignmentArtifactsForStudent(student.id, domain) as ArtifactRow[];
  const attachments: LLMImageAttachment[] = [];
  const hasContent = await appendArtifactContents(parts, artifacts, settings, attachments);
  if (!hasContent && artifacts.length === 0) {
    return { studentId: student.id, prompt: '', attachments, evalCriteria, commentsCriteria, defaultContent: buildDefaultScoringContent(evalCriteria), error: '산출물 없음' };
  }

  appendTaskInstruction(
    parts,
    '위 기준과 학생 산출물을 분석하여 먼저 채점 결과를 작성하고, 그 결과를 근거로 각 항목의 활동 기록을 작성해주세요.',
  );
  return { studentId: student.id, prompt: parts.join('\n\n'), cachePrefix, attachments, evalCriteria, commentsCriteria };
}

router.post('/generate', async (req: Request, res: Response) => {
  const { studentId, domain, contentType, criteriaSetId } = req.body as GenerateRequest;

  const student = await queryOne<{ name: string; student_num: number }>(
    'SELECT * FROM class_students WHERE id=?', [studentId]
  );
  if (!student) return res.status(404).json({ error: '학생을 찾을 수 없습니다.' });

  try {
    const settings = await getLLMSettings();
    const classContext = await getClassContextByStudent(studentId);
    const prepared = await prepareGenerationForStudent({
      student: { id: studentId, name: student.name },
      domain,
      contentType,
      criteriaSetId,
      classContext,
      settings,
    });
    if (prepared.error && !prepared.defaultContent) return res.status(400).json({ error: prepared.error });
    if (prepared.defaultContent) return res.json({ ok: true, result: '산출물 없음: 기본점수 적용', content: prepared.defaultContent });

    const temperature = contentType === 'scoring'
      ? settings.temperatures.recordsScoring
      : settings.temperatures.recordsComments;
    const result = await callLLM(prepared.prompt, settings, undefined, undefined, prepared.attachments, temperature, prepared.cachePrefix, schemaForGeneration(contentType, domain, prepared.evalCriteria, prepared.commentsCriteria), anthropicTaskForGeneration(contentType, domain));
    const envelope = buildEnvelopeContents(result, targetsForContentType(contentType, domain), prepared.evalCriteria, prepared.commentsCriteria);
    const storedContent = contentType === 'scoring'
      ? envelope.scoringContent
      : domain === '__SUBJECT_COMPREHENSIVE__'
        ? envelope.comprehensiveContent
        : envelope.commentsContent;

    res.json({ ok: true, result, content: storedContent });
  } catch (e: unknown) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

router.post('/generate-claude-batch', async (req: Request, res: Response) => {
  const { classId, domain, contentType, criteriaSetId, studentIds } = req.body as BatchGenerateRequest;
  if (classId === undefined) return res.status(400).json({ error: 'classId가 필요합니다.' });

  try {
    const settings = await getLLMSettings();
    if (settings.provider !== 'anthropic') return res.status(400).json({ error: 'Claude 공급자에서만 배치 요청을 사용할 수 있습니다.' });

    const students = studentIds?.length
      ? await queryAll<{ id: number; name: string }>(
          `SELECT * FROM class_students WHERE id IN (${studentIds.map(() => '?').join(',')}) AND class_id=? ORDER BY student_num`,
          [...studentIds, classId]
        )
      : await queryAll<{ id: number; name: string }>('SELECT * FROM class_students WHERE class_id=? ORDER BY student_num', [classId]);
    const classContext = await getClassContextByClass(classId);
    const requests: AnthropicBatchRequest[] = [];
    const requestMeta: Array<{ customId: string; studentId: number; studentName: string }> = [];
    const immediateUpdates: Array<{ studentId: number; contentType: string; domain: string; content?: string; error?: string }> = [];

    for (const [index, student] of students.entries()) {
      const prepared = contentType === 'combined'
        ? await prepareCombinedGenerationForStudent({ student, domain, classContext, settings })
        : await prepareGenerationForStudent({ student, domain, contentType, criteriaSetId, classContext, settings });
      if (prepared.defaultContent || prepared.error) {
        if (contentType === 'combined') {
          if (prepared.defaultContent) immediateUpdates.push({ studentId: student.id, contentType: 'scoring', domain, content: prepared.defaultContent });
          if (prepared.error) immediateUpdates.push({ studentId: student.id, contentType: 'comments', domain, error: prepared.error });
        } else {
          immediateUpdates.push({
            studentId: student.id,
            contentType,
            domain,
            content: prepared.defaultContent,
            error: prepared.error,
          });
        }
        continue;
      }

      const customId = claudeBatchCustomId(student.id, domain, index);
      const temperature = contentType === 'scoring'
        ? settings.temperatures.recordsScoring
        : settings.temperatures.recordsComments;
      requests.push({
        custom_id: customId,
        params: buildAnthropicMessageParams(
          prepared.prompt,
          settings,
          prepared.attachments,
          temperature,
          prepared.cachePrefix,
          schemaForGeneration(contentType, domain, prepared.evalCriteria, prepared.commentsCriteria),
          anthropicTaskForGeneration(contentType, domain)
        ),
      });
      requestMeta.push({ customId, studentId: student.id, studentName: student.name });
    }

    let providerBatchId = `local_${Date.now()}`;
    let status = 'ended';
    if (requests.length > 0) {
      const batch = await createAnthropicMessageBatch(settings, requests);
      providerBatchId = batch.id;
      status = batch.processing_status || 'in_progress';
    }

    await execute(
      `INSERT INTO ai_batch_jobs(provider_batch_id, class_id, domain, content_type, status, request_count, metadata, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [providerBatchId, classId, domain, contentType, status, requests.length, JSON.stringify({ requests: requestMeta, immediateUpdates })]
    );

    res.json({
      ok: true,
      batchId: providerBatchId,
      status,
      requestCount: requests.length,
      immediateUpdates,
    });
  } catch (e: unknown) {
    res.status(batchCreateErrorStatus(e)).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

router.post('/spellcheck-claude-batch', async (req: Request, res: Response) => {
  const classId = Number(req.body?.classId || 0);
  const items: Array<{ studentId: number; text: string }> = Array.isArray(req.body?.items)
    ? req.body.items
        .map((item: unknown) => {
          const value = item as { studentId?: unknown; text?: unknown };
          return { studentId: Number(value.studentId || 0), text: String(value.text || '').trim() };
        })
        .filter((item: { studentId: number; text: string }) => item.studentId > 0 && item.text)
    : [];
  if (!classId) return res.status(400).json({ error: 'classId가 필요합니다.' });
  if (!items.length) return res.status(400).json({ error: '교정할 세특 내용이 없습니다.' });

  try {
    const settings = await getLLMSettings();
    if (settings.provider !== 'anthropic') return res.status(400).json({ error: 'Claude 공급자에서만 배치 요청을 사용할 수 있습니다.' });

    const itemByStudentId = new Map<number, string>(items.map(item => [item.studentId, item.text]));
    const studentIds = Array.from(itemByStudentId.keys());
    const students = await queryAll<{ id: number; name: string }>(
      `SELECT id, name FROM class_students
       WHERE id IN (${studentIds.map(() => '?').join(',')}) AND class_id=?
       ORDER BY student_num`,
      [...studentIds, classId]
    );
    const requests: AnthropicBatchRequest[] = [];
    const requestMeta: Array<{ customId: string; studentId: number; studentName: string }> = [];

    for (const [index, student] of students.entries()) {
      const text = itemByStudentId.get(student.id);
      if (!text) continue;
      const customId = claudeBatchCustomId(student.id, 'spellcheck', index);
      requests.push({
        custom_id: customId,
        params: buildAnthropicMessageParams(
          spellcheckPrompt(text),
          settings,
          [],
          settings.temperatures.recordsComments,
          undefined,
          SPELLCHECK_OUTPUT_SCHEMA,
          'subjectComprehensive'
        ),
      });
      requestMeta.push({ customId, studentId: student.id, studentName: student.name });
    }
    if (!requests.length) return res.status(400).json({ error: '교정할 학생을 찾을 수 없습니다.' });

    const batch = await createAnthropicMessageBatch(settings, requests);
    const batchId = batch.id;
    await execute(
      `INSERT INTO ai_batch_jobs(provider_batch_id, class_id, domain, content_type, status, request_count, metadata, updated_at)
       VALUES(?, ?, ?, 'spellcheck', ?, ?, ?, datetime('now'))`,
      [
        batchId,
        classId,
        SUBJECT_COMPREHENSIVE_DOMAIN,
        batch.processing_status || 'in_progress',
        requests.length,
        JSON.stringify({ requests: requestMeta }),
      ]
    );

    res.json({ ok: true, batchId, status: batch.processing_status || 'in_progress', requestCount: requests.length });
  } catch (e: unknown) {
    res.status(batchCreateErrorStatus(e)).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

router.get('/claude-batch-jobs', async (req: Request, res: Response) => {
  const classId = Number(req.query.classId || 0);
  if (!classId) return res.status(400).json({ error: 'classId가 필요합니다.' });

  try {
    const rows = await queryAll<ClaudeBatchJobRow & {
      created_at: string;
      year: number;
      semester: string;
      grade: number;
      subject: string;
      room: string;
    }>(
      `SELECT j.*, c.year, c.semester, c.grade, c.subject, c.room
       FROM ai_batch_jobs j
       JOIN classes c ON c.id = j.class_id
       WHERE j.class_id=? AND j.status != 'ended'
       ORDER BY j.created_at ASC, j.id ASC`,
      [classId]
    );
    const jobs = rows.map((row) => {
      const metadata = JSON.parse(row.metadata || '{}') as {
        requests?: Array<{ studentId: number }>;
        immediateUpdates?: Array<{ studentId: number }>;
      };
      const studentIds = Array.from(new Set([
        ...(metadata.requests || []).map((item) => item.studentId),
        ...(metadata.immediateUpdates || []).map((item) => item.studentId),
      ].filter((id): id is number => Number.isFinite(id))));
      return {
        id: row.provider_batch_id,
        classId: row.class_id,
        classLabel: `${row.year}학년도 ${row.semester}학기 ${row.grade}학년 ${row.subject} ${row.room}`,
        domains: [row.domain],
        contentType: row.content_type,
        studentIds,
        completed: 0,
        total: row.request_count || studentIds.length,
        errorCount: 0,
        message: 'Claude 배치 결과 대기 중',
        status: 'running',
        startedAt: row.created_at ? new Date(`${row.created_at}Z`).getTime() : Date.now(),
        mode: 'claude-batch',
        providerBatchIds: [row.provider_batch_id],
        lockedCells: [{ contentType: row.content_type, domain: row.domain, studentIds }],
      };
    });
    res.json({ jobs });
  } catch (e: unknown) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

router.post('/claude-batch-results', async (req: Request, res: Response) => {
  const batchIds = Array.isArray(req.body?.batchIds) ? req.body.batchIds.map(String) : [];
  if (!batchIds.length) return res.status(400).json({ error: '확인할 batchId가 없습니다.' });

  try {
    const settings = await getLLMSettings();
    if (settings.provider !== 'anthropic') return res.status(400).json({ error: 'Claude 공급자에서만 결과 확인을 사용할 수 있습니다.' });

    const updates: Array<{ studentId: number; contentType: 'scoring' | 'comments' | 'spellcheck'; domain: string; content?: string; error?: string; llmResult?: string }> = [];
    let inProgress = false;
    let checked = 0;

    for (const batchId of batchIds) {
      const job = await queryOne<ClaudeBatchJobRow>('SELECT * FROM ai_batch_jobs WHERE provider_batch_id=?', [batchId]);
      if (!job) continue;
      checked++;
      const metadata = JSON.parse(job.metadata || '{}') as {
        requests?: Array<{ customId: string; studentId: number; studentName: string }>;
        immediateUpdates?: Array<{ studentId: number; contentType: 'scoring' | 'comments'; domain: string; content?: string; error?: string }>;
      };

      for (const item of metadata.immediateUpdates || []) updates.push(item);

      if (job.provider_batch_id.startsWith('local_')) {
        await execute('UPDATE ai_batch_jobs SET status=?, updated_at=datetime(\'now\') WHERE provider_batch_id=?', ['ended', batchId]);
        continue;
      }

      const info = await retrieveAnthropicMessageBatch(settings, batchId);
      await execute('UPDATE ai_batch_jobs SET status=?, updated_at=datetime(\'now\') WHERE provider_batch_id=?', [info.processing_status, batchId]);
      if (info.processing_status !== 'ended') {
        inProgress = true;
        continue;
      }

      const metaById = new Map((metadata.requests || []).map((item) => [item.customId, item]));
      const classContext = await getClassContextByClass(job.class_id);
      const results = await retrieveAnthropicMessageBatchResults(settings, batchId);
      for (const line of results) {
        const meta = metaById.get(line.custom_id);
        if (!meta) continue;
        if (line.result.type === 'succeeded') {
          const resultText = extractAnthropicText(line.result.message);
          try {
            if (job.content_type === 'spellcheck') {
              const parsed = parseSpellcheckResult(resultText);
              updates.push({
                studentId: meta.studentId,
                contentType: 'spellcheck',
                domain: SUBJECT_COMPREHENSIVE_DOMAIN,
                content: JSON.stringify(parsed),
              });
              continue;
            }
            const evalCriteria = await getDomainEvalCriteria(classContext, job.domain);
            const commentsCriteria = await getDomainCommentsCriteria(classContext, job.domain);
            const envelope = buildEnvelopeContents(resultText, targetsForContentType(job.content_type, job.domain), evalCriteria, commentsCriteria);
            if (envelope.scoringContent) updates.push({ studentId: meta.studentId, contentType: 'scoring', domain: job.domain, content: envelope.scoringContent });
            if (envelope.commentsContent) updates.push({ studentId: meta.studentId, contentType: 'comments', domain: job.domain, content: envelope.commentsContent });
            if (envelope.comprehensiveContent) updates.push({ studentId: meta.studentId, contentType: 'comments', domain: job.domain, content: envelope.comprehensiveContent });
          } catch (e: unknown) {
            if (job.content_type === 'combined') {
              const message = e instanceof Error ? e.message : String(e);
              updates.push({ studentId: meta.studentId, contentType: 'scoring', domain: job.domain, error: message, llmResult: resultText });
              updates.push({ studentId: meta.studentId, contentType: 'comments', domain: job.domain, error: message, llmResult: resultText });
            } else {
              updates.push({ studentId: meta.studentId, contentType: job.content_type, domain: job.domain, error: e instanceof Error ? e.message : String(e), llmResult: resultText });
            }
          }
        } else {
          const error = JSON.stringify(line.result.error || { type: line.result.type });
          if (job.content_type === 'combined') {
            updates.push({ studentId: meta.studentId, contentType: 'scoring', domain: job.domain, error });
            updates.push({ studentId: meta.studentId, contentType: 'comments', domain: job.domain, error });
          } else {
            updates.push({
              studentId: meta.studentId,
              contentType: job.content_type,
              domain: job.domain,
              error,
            });
          }
        }
      }
    }

    res.json({ ok: true, inProgress, checked, updates });
  } catch (e: unknown) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// 일괄 생성 (SSE)
router.post('/generate-batch', async (req: Request, res: Response) => {
  const { classId, sessionId, domain, contentType, criteriaSetId, studentIds } = req.body as BatchGenerateRequest;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.on('error', (e) => console.error('SSE response error:', e));

  const sendEvent = (data: object) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  let students: { id: number; name: string }[] = [];
  let completed = 0;
  let settings: Awaited<ReturnType<typeof getLLMSettings>> | null = null;
  let logSession: LLMLogSession | null = null;
  let classContext: ClassContext | null = null;
  let cancelled = false;
  const abortController = new AbortController();

  res.on('close', () => {
    cancelled = true;
    abortController.abort();
  });

  const processStudent = async (student: { id: number; name: string }, index: number) => {
    if (cancelled) return;

    try {
      let result: string | null = null;
      let storedContent: string | null = null;
      let error: string | null = null;
      let evalCriteria: EvalCriterion[] = [];
      let commentsCriteria: CommentsCriterion[] = [];

      if (contentType === 'combined') {
        if (!settings) throw new Error('LLM 설정이 로드되지 않았습니다.');
        const prepared = await prepareCombinedGenerationForStudent({ student, domain, classContext, settings });
        if (prepared.defaultContent) {
          completed++;
          sendEvent({ type: 'progress', studentId: student.id, name: student.name, contentType: 'scoring', domain, content: prepared.defaultContent, completed, total: students.length });
          if (prepared.error) sendEvent({ type: 'error', studentId: student.id, name: student.name, contentType: 'comments', domain, error: prepared.error, completed, total: students.length });
          return;
        }
        if (prepared.error) {
          completed++;
          sendEvent({ type: 'error', studentId: student.id, name: student.name, contentType: 'scoring', domain, error: prepared.error, completed, total: students.length });
          sendEvent({ type: 'error', studentId: student.id, name: student.name, contentType: 'comments', domain, error: prepared.error, completed, total: students.length });
          return;
        }
        try {
          const resultText = await callLLM(prepared.prompt, settings, abortController.signal, {
            session: logSession || undefined,
            label: `학생 ${index + 1}/${students.length}`,
          }, prepared.attachments, settings.temperatures.recordsComments, prepared.cachePrefix, schemaForGeneration('combined', domain, prepared.evalCriteria, prepared.commentsCriteria), anthropicTaskForGeneration('combined', domain));
          const combined = buildEnvelopeContents(resultText, { scoring: true, comments: true }, prepared.evalCriteria, prepared.commentsCriteria);
          completed++;
          sendEvent({ type: 'progress', studentId: student.id, name: student.name, contentType: 'scoring', domain, content: combined.scoringContent, completed, total: students.length });
          sendEvent({ type: 'progress', studentId: student.id, name: student.name, contentType: 'comments', domain, content: combined.commentsContent, completed, total: students.length });
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          completed++;
          sendEvent({ type: 'error', studentId: student.id, name: student.name, contentType: 'scoring', domain, error: message, completed, total: students.length });
          sendEvent({ type: 'error', studentId: student.id, name: student.name, contentType: 'comments', domain, error: message, completed, total: students.length });
        }
        return;
      }

      if (!settings) throw new Error('LLM 설정이 로드되지 않았습니다.');
      const prepared = await prepareGenerationForStudent({ student, domain, contentType, criteriaSetId, classContext, settings });
      evalCriteria = prepared.evalCriteria;
      commentsCriteria = prepared.commentsCriteria;

      if (prepared.defaultContent) {
        storedContent = prepared.defaultContent;
        error = prepared.error ?? null;
      } else if (prepared.error) {
        error = prepared.error;
      } else {
        try {
          if (cancelled) return;
          const temperature = contentType === 'scoring'
            ? settings.temperatures.recordsScoring
            : settings.temperatures.recordsComments;
          result = await callLLM(prepared.prompt, settings, abortController.signal, {
            session: logSession || undefined,
            label: `학생 ${index + 1}/${students.length}`,
          }, prepared.attachments, temperature, prepared.cachePrefix, schemaForGeneration(contentType, domain, evalCriteria, commentsCriteria), anthropicTaskForGeneration(contentType, domain));
          if (cancelled) return;
          const envelope = buildEnvelopeContents(result, targetsForContentType(contentType, domain), evalCriteria, commentsCriteria);
          storedContent = contentType === 'scoring'
            ? envelope.scoringContent || null
            : domain === '__SUBJECT_COMPREHENSIVE__'
              ? envelope.comprehensiveContent || null
              : envelope.commentsContent || null;
        } catch (e: unknown) {
          error = e instanceof Error ? e.message : String(e);
        }
      }

      if (cancelled) return;
      completed++;
      sendEvent({
        type: error ? 'error' : 'progress',
        studentId: student.id,
        name: student.name,
        contentType,
        domain,
        content: storedContent,
        error,
        llmResult: error && result ? result : undefined,
        completed,
        total: students.length,
      });
    } catch (e: unknown) {
      if (cancelled) return;
      completed++;
      sendEvent({
        type: 'error',
        studentId: student.id,
        name: student.name,
        error: e instanceof Error ? e.message : String(e),
        completed,
        total: students.length,
      });
    }
  };

  try {
    if (studentIds?.length) {
      students = await queryAll<{ id: number; name: string }>(
        `SELECT * FROM class_students WHERE id IN (${studentIds.map(() => '?').join(',')}) ${classId !== undefined ? 'AND class_id=?' : ''} ORDER BY student_num`,
        classId !== undefined ? [...studentIds, classId] : studentIds
      );
    } else if (classId !== undefined) {
      students = await queryAll<{ id: number; name: string }>(
        'SELECT * FROM class_students WHERE class_id=? ORDER BY student_num',
        [classId]
      );
    } else if (sessionId !== undefined) {
      students = await queryAll<{ id: number; name: string }>(
        'SELECT * FROM class_students WHERE class_id=? ORDER BY student_num',
        [sessionId]
      );
    }

    classContext = await getClassContextByClass(classId ?? sessionId);
    sendEvent({ type: 'start', total: students.length });

    settings = await getLLMSettings();
    if (settings.loggingEnabled) {
      logSession = await createLLMLogSession('live-generate', {
        content_type: contentType,
        domain,
        target_count: students.length,
        provider: settings.provider,
        model: settings.model || '(default)',
      });
    }
    const MAX_CONCURRENCY = Math.max(1, settings.maxConcurrency || 1);

    for (let i = 0; i < students.length; i += MAX_CONCURRENCY) {
      if (cancelled) break;
      await Promise.all(students.slice(i, i + MAX_CONCURRENCY).map((student, offset) => processStudent(student, i + offset)));
    }

    if (!cancelled) sendEvent({ type: 'done', completed });
  } catch (e: unknown) {
    console.error('generate-batch failed:', e);
    sendEvent({ type: 'fatal', error: e instanceof Error ? e.message : String(e), completed: 0, total: 0 });
  } finally {
    res.end();
  }
});

export default router;
