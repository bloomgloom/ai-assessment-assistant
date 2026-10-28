import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import AdmZip from 'adm-zip';
import multer from 'multer';
import { execute, closeDb, initDb } from '../services/db';
import { assignmentExecute, assignmentQueryOne } from '../services/assignmentDb';
import { getStorageSettings, STORAGE_ROOT, UPLOADS_DIR, ensureDir } from '../services/storage';
import {
  callLLM,
  getLLMSettings,
  fetchAnthropicModels,
  fetchGeminiModels,
  fetchOllamaModels,
  fetchOpenAICompatibleModels,
  fetchOpenAIModels,
} from '../services/llm';
import type { AnthropicEffort, AnthropicOutputOptions, AnthropicOutputTask } from '../services/llm';
import { deleteAllAssignmentConfigs } from './assignmentConfigs';

const UPLOADS_ROOT = UPLOADS_DIR;
const router = Router();
const restoreUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 * 1024 } });
const TEMPERATURE_KEYS = ['domainManagement', 'recordsScoring', 'recordsComments'] as const;
const ANTHROPIC_OUTPUT_TASKS: AnthropicOutputTask[] = ['domainManagement', 'recordsScoring', 'recordsComments', 'subjectComprehensive'];
const ANTHROPIC_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function providerTemperatureMax(provider: string) {
  return provider === 'anthropic' ? 1 : 2;
}

function sanitizeTemperature(provider: string, value: unknown) {
  const numeric = parseFloat(String(value));
  if (!Number.isFinite(numeric)) return undefined;
  return Math.max(0, Math.min(providerTemperatureMax(provider), numeric));
}

function sanitizeAnthropicEffort(value: unknown): AnthropicEffort {
  return ANTHROPIC_EFFORTS.has(String(value)) ? String(value) as AnthropicEffort : 'high';
}

function collectAnthropicOutputOptionPairs(provider: string, options: unknown): [string, string][] {
  if (!options || typeof options !== 'object') return [];
  const value = options as Partial<Record<AnthropicOutputTask, Partial<AnthropicOutputOptions[AnthropicOutputTask]>>>;
  const pairs: [string, string][] = [];
  for (const task of ANTHROPIC_OUTPUT_TASKS) {
    const item = value[task];
    if (!item || typeof item !== 'object') continue;
    pairs.push([`llm_model_${provider}_${task}`, String(item.model || '')]);
    pairs.push([`llm_anthropic_effort_${provider}_${task}`, item.effort ? sanitizeAnthropicEffort(item.effort) : '']);
    pairs.push([`llm_output_thinking_level_${provider}_${task}`, String(item.thinkingLevel || '')]);
    pairs.push([`llm_output_reasoning_effort_${provider}_${task}`, String(item.reasoningEffort || '')]);
    if (item.maxTokens !== undefined) {
      if (String(item.maxTokens) === '') {
        pairs.push([`llm_anthropic_max_tokens_${provider}_${task}`, '']);
        continue;
      }
      const maxTokens = parseInt(String(item.maxTokens), 10);
      if (!Number.isFinite(maxTokens) || maxTokens <= 0) throw new Error('Claude max token을 입력해주세요.');
      pairs.push([`llm_anthropic_max_tokens_${provider}_${task}`, String(maxTokens)]);
    }
  }
  return pairs;
}

function makeBackupFilename() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `assessment-backup-${stamp}.zip`;
}

function assertSafeZip(zip: AdmZip) {
  for (const entry of zip.getEntries()) {
    const name = entry.entryName;
    if (!name || path.isAbsolute(name) || name.includes('\\')) {
      throw new Error(`허용되지 않는 백업 항목입니다: ${name}`);
    }

    const normalized = path.posix.normalize(name);
    if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
      throw new Error(`백업 파일에 상위 경로 항목이 포함되어 있습니다: ${name}`);
    }
  }
}

function removeDirContents(dir: string) {
  ensureDir(dir);
  for (const entry of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
}

function copyDirContents(fromDir: string, toDir: string) {
  ensureDir(toDir);
  for (const entry of fs.readdirSync(fromDir)) {
    fs.cpSync(path.join(fromDir, entry), path.join(toDir, entry), { recursive: true });
  }
}

function hashPassword(password: string) {
  const salt = crypto.randomBytes(16).toString('hex');
  const iterations = 120000;
  const hash = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256').toString('hex');
  return `pbkdf2_sha256$${iterations}$${salt}$${hash}`;
}

router.get('/', async (_req: Request, res: Response) => {
  const settings = await getLLMSettings();
  const teacherPassword = await assignmentQueryOne<{ value: string }>(
    'SELECT value FROM assignment_settings WHERE key=?',
    ['teacher_password_hash']
  );
  res.json({ ...settings, storage: getStorageSettings(), assignmentTeacherPasswordSet: !!teacherPassword?.value });
});

router.put('/', async (req: Request, res: Response) => {
  const {
    provider,
    apiKeys,
    model,
    baseUrl,
    maxConcurrency,
    temperatureEnabled,
    temperatures,
    anthropicEffort,
    anthropicMaxTokens,
    outputThinkingLevel,
    outputReasoningEffort,
    anthropicOutputOptions,
    loggingEnabled,
    artifactStripIntroBlocks,
    artifactStripIntroBlocksDeprecated,
    pdfRedactionTopCm,
    aiEnabled,
    providerSettings,
    assignmentTeacherPassword,
    clearAssignmentTeacherPassword,
  } = req.body;
  const concurrency = maxConcurrency != null ? Math.max(1, parseInt(String(maxConcurrency), 10) || 1) : undefined;
  
  const pairs: [string, string][] = [
    ['llm_provider', provider],
    ['llm_model', model],
    ['llm_base_url', baseUrl],
  ];

  if (concurrency != null) {
    pairs.push(['llm_max_concurrency', String(concurrency)]);
    pairs.push(['llm_sequential_mode', String(concurrency <= 1)]);
  }

  if (provider && typeof provider === 'string') {
    if (model !== undefined) pairs.push([`llm_model_${provider}`, String(model)]);
    if (baseUrl !== undefined) pairs.push([`llm_base_url_${provider}`, String(baseUrl)]);
    if (concurrency != null) pairs.push([`llm_max_concurrency_${provider}`, String(concurrency)]);
    if (temperatureEnabled !== undefined) pairs.push([`llm_temperature_enabled_${provider}`, String(temperatureEnabled)]);
    if (anthropicEffort !== undefined) pairs.push([`llm_anthropic_effort_${provider}`, sanitizeAnthropicEffort(anthropicEffort)]);
    if (outputThinkingLevel !== undefined) pairs.push([`llm_output_thinking_level_${provider}`, String(outputThinkingLevel)]);
    if (outputReasoningEffort !== undefined) pairs.push([`llm_output_reasoning_effort_${provider}`, String(outputReasoningEffort)]);
    if (anthropicOutputOptions !== undefined) pairs.push([`llm_output_options_enabled_${provider}`, 'true']);
    pairs.push(...collectAnthropicOutputOptionPairs(provider, anthropicOutputOptions));
    if (anthropicMaxTokens !== undefined) {
      const maxTokens = parseInt(String(anthropicMaxTokens), 10);
      if (!Number.isFinite(maxTokens) || maxTokens <= 0) return res.status(400).json({ error: 'Claude max token을 입력해주세요.' });
      pairs.push([`llm_anthropic_max_tokens_${provider}`, String(maxTokens)]);
    }
    if (temperatures && typeof temperatures === 'object') {
      for (const key of TEMPERATURE_KEYS) {
        const value = sanitizeTemperature(provider, temperatures[key]);
        if (value !== undefined) pairs.push([`llm_temperature_${provider}_${key}`, String(value)]);
      }
    }
  }

  if (providerSettings && typeof providerSettings === 'object') {
    for (const [p, value] of Object.entries(providerSettings)) {
      if (!value || typeof value !== 'object') continue;
      const item = value as {
        model?: unknown;
        baseUrl?: unknown;
        maxConcurrency?: unknown;
        temperatureEnabled?: unknown;
        temperatures?: Record<string, unknown>;
        anthropicEffort?: unknown;
        anthropicMaxTokens?: unknown;
        outputThinkingLevel?: unknown;
        outputReasoningEffort?: unknown;
        anthropicOutputOptions?: unknown;
      };
      if (item.model !== undefined) pairs.push([`llm_model_${p}`, String(item.model)]);
      if (item.baseUrl !== undefined) pairs.push([`llm_base_url_${p}`, String(item.baseUrl)]);
      if (item.maxConcurrency !== undefined) {
        const providerConcurrency = Math.max(1, parseInt(String(item.maxConcurrency), 10) || 1);
        pairs.push([`llm_max_concurrency_${p}`, String(providerConcurrency)]);
      }
      if (item.temperatureEnabled !== undefined) {
        pairs.push([`llm_temperature_enabled_${p}`, String(item.temperatureEnabled)]);
      }
      if (item.anthropicEffort !== undefined) {
        pairs.push([`llm_anthropic_effort_${p}`, sanitizeAnthropicEffort(item.anthropicEffort)]);
      }
      if (item.outputThinkingLevel !== undefined) {
        pairs.push([`llm_output_thinking_level_${p}`, String(item.outputThinkingLevel)]);
      }
      if (item.outputReasoningEffort !== undefined) {
        pairs.push([`llm_output_reasoning_effort_${p}`, String(item.outputReasoningEffort)]);
      }
      if (item.anthropicOutputOptions !== undefined) {
        pairs.push([`llm_output_options_enabled_${p}`, 'true']);
      }
      pairs.push(...collectAnthropicOutputOptionPairs(p, item.anthropicOutputOptions));
      if (item.anthropicMaxTokens !== undefined) {
        const maxTokens = parseInt(String(item.anthropicMaxTokens), 10);
        if (!Number.isFinite(maxTokens) || maxTokens <= 0) return res.status(400).json({ error: 'Claude max token을 입력해주세요.' });
        pairs.push([`llm_anthropic_max_tokens_${p}`, String(maxTokens)]);
      }
      if (item.temperatures && typeof item.temperatures === 'object') {
        for (const key of TEMPERATURE_KEYS) {
          const temperature = sanitizeTemperature(p, item.temperatures[key]);
          if (temperature !== undefined) pairs.push([`llm_temperature_${p}_${key}`, String(temperature)]);
        }
      }
    }
  }
  
  if (loggingEnabled != null) {
    pairs.push(['llm_logging_enabled', String(loggingEnabled)]);
  }

  if (artifactStripIntroBlocks != null) {
    pairs.push(['artifact_strip_intro_blocks', String(artifactStripIntroBlocks)]);
  }

  if (artifactStripIntroBlocksDeprecated != null) {
    pairs.push(['artifact_strip_intro_blocks_deprecated', String(artifactStripIntroBlocksDeprecated)]);
  }

  if (pdfRedactionTopCm != null) {
    const heightCm = Math.max(0, Math.min(30, parseFloat(String(pdfRedactionTopCm)) || 0));
    pairs.push(['pdf_redaction_top_cm', String(heightCm)]);
  }

  if (aiEnabled != null) {
    pairs.push(['ai_enabled', String(aiEnabled)]);
  }

  if (apiKeys && typeof apiKeys === 'object') {
    for (const [p, key] of Object.entries(apiKeys)) {
      if (typeof key === 'string') {
        pairs.push([`llm_api_key_${p}`, key]);
      }
    }
  }

  const validPairs = pairs.filter((p): p is [string, string] => p[1] !== undefined);

  for (const [key, value] of validPairs) {
    await execute('INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)', [key, value]);
  }

  if (typeof assignmentTeacherPassword === 'string' && assignmentTeacherPassword.trim()) {
    await assignmentExecute(
      'INSERT OR REPLACE INTO assignment_settings(key, value) VALUES(?, ?)',
      ['teacher_password_hash', hashPassword(assignmentTeacherPassword.trim())]
    );
  } else if (clearAssignmentTeacherPassword === true) {
    await assignmentExecute('DELETE FROM assignment_settings WHERE key=?', ['teacher_password_hash']);
  }

  res.json({ ok: true, storage: getStorageSettings() });
});

router.get('/compatible-models', async (req: Request, res: Response) => {
  const baseUrl = (req.query.baseUrl as string) || 'http://localhost:8000/v1';
  const apiKey = (req.query.apiKey as string) || '';
  try {
    const models = await fetchOpenAICompatibleModels(baseUrl, apiKey);
    res.json({ models });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: msg });
  }
});

router.get('/models', async (req: Request, res: Response) => {
  const provider = String(req.query.provider || '');
  const baseUrl = String(req.query.baseUrl || '');
  const apiKey = String(req.query.apiKey || '');
  try {
    let models: string[];
    if (provider === 'openai') {
      models = await fetchOpenAIModels(apiKey, baseUrl || 'https://api.openai.com/v1');
    } else if (provider === 'anthropic') {
      models = await fetchAnthropicModels(apiKey);
    } else if (provider === 'gemini') {
      models = await fetchGeminiModels(apiKey);
    } else if (provider === 'ollama') {
      models = await fetchOllamaModels(baseUrl || 'http://localhost:11434');
    } else if (provider === 'openai-compatible') {
      models = await fetchOpenAICompatibleModels(baseUrl || 'http://localhost:8000/v1', apiKey);
    } else {
      return res.status(400).json({ error: '지원하지 않는 공급자입니다.' });
    }
    res.json({ models });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: msg });
  }
});

router.get('/backup', async (_req: Request, res: Response) => {
  try {
    await execute('PRAGMA wal_checkpoint(TRUNCATE)');
    ensureDir(STORAGE_ROOT);

    const zip = new AdmZip();
    zip.addLocalFolder(STORAGE_ROOT);
    const buffer = zip.toBuffer();
    const filename = makeBackupFilename();

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.send(buffer);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ ok: false, error: msg });
  }
});

router.post('/restore', restoreUpload.single('file'), async (req: Request, res: Response) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assessment-restore-'));
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({ ok: false, error: '복원할 ZIP 파일을 선택하세요.' });
    }

    const zip = new AdmZip(req.file.buffer);
    assertSafeZip(zip);
    zip.extractAllTo(tmpDir, true);

    closeDb();
    removeDirContents(STORAGE_ROOT);
    copyDirContents(tmpDir, STORAGE_ROOT);
    await initDb();

    res.json({ ok: true, storage: getStorageSettings() });
  } catch (e: unknown) {
    try { await initDb(); } catch { /* keep original error */ }
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ ok: false, error: msg });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── 전체 데이터 초기화 ─────────────────────────────────────────────────────
router.post('/reset', async (_req: Request, res: Response) => {
  try {
    // 1. 업로드 파일 전체 삭제 (uploads/ 하위 모든 파일, 디렉토리 구조는 유지)
    const deleteDirContents = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir)) {
        const full = path.join(dir, entry);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          deleteDirContents(full);
          try { fs.rmdirSync(full); } catch { /* ignore non-empty */ }
        } else {
          fs.unlinkSync(full);
        }
      }
    };
    deleteDirContents(UPLOADS_ROOT);

    // 2. 데이터 테이블 초기화 (settings 제외)
    // ON DELETE CASCADE 덕분에 classes 삭제 시 assessment_domains, class_students,
    // artifacts, generated_content 자동 삭제
    // criteria_sets 삭제 시 comments_criteria, eval_domains 자동 삭제
    await execute('DELETE FROM classes');
    await execute('DELETE FROM subject_domains');
    await execute('DELETE FROM achievement_standards');
    await execute('DELETE FROM domain_comments');
    await execute('DELETE FROM domain_eval');
    await execute('DELETE FROM custom_domains');
    await execute('DELETE FROM criteria_sets');
    await deleteAllAssignmentConfigs();
    await assignmentExecute('DELETE FROM assignment_artifacts');

    res.json({ ok: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ ok: false, error: msg });
  }
});

router.post('/test', async (req: Request, res: Response) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : undefined;
    const hasTestSettings = body && typeof body.provider === 'string';
    if (hasTestSettings && body.provider === 'anthropic') {
      const maxTokens = parseInt(String(body.anthropicMaxTokens), 10);
      if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
        return res.status(400).json({ error: 'Claude max token을 입력해주세요.' });
      }
    }
    const result = await callLLM(
      '안녕하세요! 테스트 메시지입니다. 한 문장으로 응답해주세요.',
      hasTestSettings ? {
        provider: body.provider,
        apiKey: body.apiKeys?.[body.provider] || body.apiKey || '',
        apiKeys: body.apiKeys || {},
        model: body.model || '',
        baseUrl: body.baseUrl || '',
        maxConcurrency: Math.max(1, parseInt(String(body.maxConcurrency), 10) || 1),
        temperatureEnabled: body.temperatureEnabled === true,
        temperatures: body.temperatures || {},
        anthropicEffort: sanitizeAnthropicEffort(body.anthropicEffort),
        anthropicMaxTokens: parseInt(String(body.anthropicMaxTokens), 10),
        outputThinkingLevel: body.outputThinkingLevel || 'medium',
        outputReasoningEffort: body.outputReasoningEffort || 'medium',
        anthropicOutputOptions: body.anthropicOutputOptions || {},
        providerSettings: body.providerSettings || {},
        sequentialMode: (parseInt(String(body.maxConcurrency), 10) || 1) <= 1,
        loggingEnabled: body.loggingEnabled !== false,
        artifactStripIntroBlocks: body.artifactStripIntroBlocks !== false,
        artifactStripIntroBlocksDeprecated: body.artifactStripIntroBlocksDeprecated === true,
        pdfRedactionTopCm: Math.max(0, Math.min(30, parseFloat(String(body.pdfRedactionTopCm ?? '0')) || 0)),
        aiEnabled: true,
      } : undefined,
      undefined,
      undefined,
      [],
      0
    );
    res.json({ ok: true, response: result });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ ok: false, error: msg });
  }
});

export default router;
