import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { LLMImageAttachment } from './llm';
import { SerialTaskQueue } from './serialTaskQueue';
import { ensureDir, storagePath } from './storage';

const execFileAsync = promisify(execFile);
const artifactExecutionQueue = new SerialTaskQueue();
const NOTEBOOK_CACHE_VERSION = 5;
const notebookCacheDir = storagePath('cache', 'artifact-execution');

export interface EvidenceArtifact {
  filename: string;
  filepath: string;
}

interface PythonRunResult {
  stdout: string;
  stderr: string;
}

interface NotebookEvidenceResult {
  text: string;
  attachments: LLMImageAttachment[];
  executionSucceeded: boolean;
  executionError?: string;
}

interface NotebookEvidenceOptions {
  skipFirstMarkdownCell?: boolean;
  executionKind?: 'notebook' | 'python-script';
}

async function appendFileHash(hash: crypto.Hash, filepath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filepath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
}

function pythonEnvironmentFingerprint(): string {
  const manifestPath = process.env.PYTHON_RUNTIME_DIR
    ? path.join(process.env.PYTHON_RUNTIME_DIR, 'runtime-manifest.json')
    : '';
  let manifest = '';
  try { if (manifestPath) manifest = fs.readFileSync(manifestPath, 'utf8'); } catch {}
  return JSON.stringify({
    python: process.env.ASSESSMENT_PYTHON || '',
    baseRequirements: process.env.ASSESSMENT_BASE_REQUIREMENTS_JSON || '',
    manifest,
  });
}

export async function notebookEvidenceCacheKey(
  notebook: EvidenceArtifact,
  artifacts: EvidenceArtifact[],
  label: string,
  options: NotebookEvidenceOptions = {},
): Promise<string> {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify({
    version: NOTEBOOK_CACHE_VERSION,
    notebook: notebook.filename.normalize('NFC'),
    label,
    options,
    python: pythonEnvironmentFingerprint(),
  }));
  for (const artifact of artifacts) {
    hash.update('\0');
    hash.update(artifact.filename.normalize('NFC'));
    hash.update('\0');
    await appendFileHash(hash, artifact.filepath);
  }
  return hash.digest('hex');
}

function readNotebookCache(cacheKey: string): NotebookEvidenceResult | null {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(notebookCacheDir, `${cacheKey}.json`), 'utf8')) as NotebookEvidenceResult;
    return value?.executionSucceeded && typeof value.text === 'string' && Array.isArray(value.attachments) ? value : null;
  } catch {
    return null;
  }
}

function writeNotebookCache(cacheKey: string, value: NotebookEvidenceResult): void {
  ensureDir(notebookCacheDir);
  const target = path.join(notebookCacheDir, `${cacheKey}.json`);
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value), 'utf8');
  fs.renameSync(temp, target);

  // Changed submissions naturally create new keys. Keep the cache bounded.
  const entries = fs.readdirSync(notebookCacheDir)
    .filter(filename => filename.endsWith('.json'))
    .map(filename => ({ filename, mtimeMs: fs.statSync(path.join(notebookCacheDir, filename)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const entry of entries.slice(1000)) {
    try { fs.rmSync(path.join(notebookCacheDir, entry.filename), { force: true }); } catch {}
  }
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...(truncated ${value.length - maxChars} chars)`;
}

async function runPythonScript(script: string, args: string[], timeoutMs: number): Promise<PythonRunResult> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assessment-evidence-'));
  const mplConfigDir = path.join(dir, 'matplotlib');
  const scriptPath = path.join(dir, 'evidence.py');
  fs.mkdirSync(mplConfigDir, { recursive: true });
  fs.writeFileSync(scriptPath, script, 'utf8');
  try {
    const candidates = [
      process.env.ASSESSMENT_PYTHON,
      'python3',
      'python',
    ].filter(Boolean) as string[];

    let lastError: unknown = null;
    for (const pythonPath of candidates) {
      try {
        return await execFileAsync(pythonPath, [scriptPath, ...args], {
          timeout: timeoutMs,
          maxBuffer: 20 * 1024 * 1024,
          env: { ...process.env, MPLCONFIGDIR: mplConfigDir },
        });
      } catch (e) {
        lastError = e;
        const error = e as NodeJS.ErrnoException;
        if (error.code !== 'ENOENT') throw e;
      }
    }
    throw lastError || new Error('Python executable not found.');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function parsePythonJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error('Python evidence script produced no output.');
  return JSON.parse(trimmed);
}

const TABULAR_SUMMARY_SCRIPT = String.raw`
import json
import os
import sys

try:
    import pandas as pd
except Exception as exc:
    print(json.dumps({"ok": False, "error": "pandas import failed: " + str(exc)}, ensure_ascii=False))
    sys.exit(0)

def as_jsonable(value):
    try:
        if pd.isna(value):
            return None
    except Exception:
        pass
    if hasattr(value, "item"):
        try:
            return value.item()
        except Exception:
            pass
    return str(value) if not isinstance(value, (str, int, float, bool, type(None))) else value

def read_frame(file_path, ext):
    if ext in ("xlsx", "xls"):
        return pd.read_excel(file_path), "excel"
    sep = "\t" if ext == "tsv" else ","
    encodings = ["utf-8", "utf-8-sig", "cp949", "euc-kr"]
    last_error = None
    for encoding in encodings:
        try:
            return pd.read_csv(file_path, encoding=encoding, sep=sep), ext + ":" + encoding
        except Exception as exc:
            last_error = exc
    raise last_error

def text_quality(text):
    controls = sum(1 for ch in text if ord(ch) < 32 and ch not in "\t\r\n")
    hangul = sum(1 for ch in text if "\uac00" <= ch <= "\ud7a3")
    replacement = text.count("\ufffd")
    return {
        "replacement_chars": replacement,
        "control_chars": controls,
        "hangul_chars": hangul,
        "sample": text[:500],
    }

def encoding_probe(file_path, ext):
    if ext in ("xlsx", "xls"):
        return {
            "kind": "binary_spreadsheet",
            "note": "XLS/XLSX는 CSV 텍스트 인코딩 채점 대상이 아닙니다.",
        }

    raw = open(file_path, "rb").read()
    has_non_ascii = any(byte >= 0x80 for byte in raw)
    attempts = {}
    for encoding in ["utf-8-sig", "utf-8", "cp949", "euc-kr"]:
        try:
            decoded = raw.decode(encoding, errors="strict")
            attempts[encoding] = {
                "success": True,
                **text_quality(decoded),
            }
        except UnicodeDecodeError as exc:
            attempts[encoding] = {
                "success": False,
                "error": f"UnicodeDecodeError at byte {exc.start}",
            }

    if raw.startswith(b"\xef\xbb\xbf"):
        likely = "utf-8-sig"
        confidence_note = "UTF-8 BOM이 있습니다."
    elif attempts["utf-8"]["success"] and has_non_ascii:
        likely = "utf-8"
        confidence_note = "원본 바이트가 엄격한 UTF-8 디코딩에 성공했고 비 ASCII 바이트가 포함되어 있습니다."
    elif attempts["cp949"]["success"] and not attempts["utf-8"]["success"]:
        likely = "cp949"
        confidence_note = "엄격한 UTF-8 디코딩은 실패했고 CP949 디코딩은 성공했습니다."
    elif not has_non_ascii:
        likely = "ascii-compatible"
        confidence_note = "ASCII 범위 바이트만 있어 UTF-8/CP949/EUC-KR을 원본 인코딩으로 구분할 수 없습니다."
    else:
        likely = "ambiguous"
        confidence_note = "여러 인코딩으로 디코딩 가능하거나 확정하기 어렵습니다. 샘플과 실행 결과를 함께 봐야 합니다."

    return {
        "kind": "raw_csv_bytes",
        "bytes": len(raw),
        "has_utf8_bom": raw.startswith(b"\xef\xbb\xbf"),
        "has_non_ascii_bytes": has_non_ascii,
        "likely_encoding": likely,
        "confidence_note": confidence_note,
        "decode_attempts": attempts,
    }

def damage_report(file_path, df):
    report = {
        "replacement_char_bytes": 0,
        "replacement_char_text_count": 0,
        "mojibake_warning": "",
    }
    try:
        raw = open(file_path, "rb").read()
        report["replacement_char_bytes"] = raw.count(b"\xef\xbf\xbd")
    except Exception:
        pass

    sample_parts = [str(col) for col in df.columns]
    try:
        sample_parts.extend([str(value) for row in df.head(20).astype("string").fillna("").values.tolist() for value in row])
    except Exception:
        pass
    sample_text = "\n".join(sample_parts)
    report["replacement_char_text_count"] = sample_text.count("\ufffd")
    if report["replacement_char_bytes"] > 0 or report["replacement_char_text_count"] > 0:
        report["mojibake_warning"] = "파일 내용에 유니코드 대체 문자(�)가 포함되어 있어 제출/전달 과정에서 이미 문자 손상이 발생했을 가능성이 큽니다. 이 경우 다른 인코딩으로 다시 읽어도 원문 복구가 어려울 수 있습니다."
    return report

try:
    file_path = sys.argv[1]
    ext = os.path.splitext(file_path)[1].lower().lstrip(".")
    df, reader_used_for_summary = read_frame(file_path, ext)
    numeric = df.select_dtypes(include="number")
    categorical = df.select_dtypes(exclude="number")

    result = {
        "ok": True,
        "reader_used_for_summary": reader_used_for_summary,
        "encoding_probe": encoding_probe(file_path, ext),
        "encoding_damage": damage_report(file_path, df),
        "shape": [int(df.shape[0]), int(df.shape[1])],
        "columns": [str(col) for col in df.columns],
        "dtypes": {str(col): str(dtype) for col, dtype in df.dtypes.items()},
        "missing_values": {str(col): int(value) for col, value in df.isna().sum().items()},
        "duplicate_rows": int(df.duplicated().sum()),
        "head": df.head(5).applymap(as_jsonable).to_dict(orient="records"),
        "tail": df.tail(3).applymap(as_jsonable).to_dict(orient="records"),
        "numeric_summary": {},
        "categorical_summary": {},
    }

    if not numeric.empty:
        desc = numeric.describe().round(6)
        result["numeric_summary"] = {
            str(col): {str(idx): as_jsonable(desc.loc[idx, col]) for idx in desc.index}
            for col in desc.columns
        }

    for col in list(categorical.columns)[:20]:
        counts = df[col].astype("string").fillna("(missing)").value_counts(dropna=False).head(10)
        result["categorical_summary"][str(col)] = {
            str(key): int(value) for key, value in counts.items()
        }

    print(json.dumps(result, ensure_ascii=False, default=str))
except Exception as exc:
    print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
`;

const NOTEBOOK_EXECUTION_SCRIPT = String.raw`
import base64
import json
import os
import sys
import traceback

try:
    import nbformat
    from nbclient import NotebookClient
except Exception as exc:
    print(json.dumps({"ok": False, "error": "notebook execution dependencies import failed: " + str(exc)}, ensure_ascii=False))
    sys.exit(0)

def source_text(source):
    return "".join(source) if isinstance(source, list) else str(source or "")

def trim(text, limit=4000):
    text = str(text or "")
    return text if len(text) <= limit else text[:limit] + "\n...(truncated)"

def should_skip_cell(cell, index, skip_first_markdown):
    return bool(skip_first_markdown and index == 0 and cell.get("cell_type") == "markdown")

def collect_outputs(cell, index, image_dir, image_prefix):
    outputs = []
    image_count = 0
    error_count = 0
    for output in cell.get("outputs", []):
        output_type = output.get("output_type", "")
        if output_type == "stream":
            outputs.append({"type": "stream", "name": output.get("name", ""), "text": trim(output.get("text", ""), 3000)})
        elif output_type == "error":
            error_count += 1
            outputs.append({
                "type": "error",
                "ename": output.get("ename", ""),
                "evalue": output.get("evalue", ""),
                "traceback": trim("\n".join(output.get("traceback", [])), 3000),
            })
        elif output_type in ("display_data", "execute_result"):
            data = output.get("data", {})
            if "image/png" in data:
                image_count += 1
                image_name = f"{image_prefix}-cell-{index + 1}-image-{image_count}.png"
                image_path = os.path.join(image_dir, image_name)
                image_data = data["image/png"]
                if isinstance(image_data, list):
                    image_data = "".join(image_data)
                with open(image_path, "wb") as img:
                    img.write(base64.b64decode(image_data))
                outputs.append({"type": "image", "filename": image_name})
            elif "text/plain" in data:
                outputs.append({"type": "result", "text": trim(source_text(data.get("text/plain", "")), 3000)})
    return outputs, image_count, error_count

def collect_cells(nb, image_dir, image_prefix, skip_first_markdown):
    cells = []
    image_count = 0
    error_count = 0
    for index, cell in enumerate(nb.cells):
        if should_skip_cell(cell, index, skip_first_markdown):
            continue
        item = {
            "index": index + 1,
            "cell_type": cell.get("cell_type", ""),
            "source": trim(source_text(cell.get("source", "")), 3000),
            "outputs": [],
        }
        if cell.get("cell_type") == "code":
            outputs, cell_image_count, cell_error_count = collect_outputs(cell, index, image_dir, image_prefix)
            item["outputs"] = outputs
            image_count += cell_image_count
            error_count += cell_error_count
        cells.append(item)
    return {"cells": cells, "image_count": image_count, "error_count": error_count}

try:
    notebook_path = sys.argv[1]
    work_dir = sys.argv[2]
    image_dir = sys.argv[3]
    skip_first_markdown = sys.argv[4] == "1" if len(sys.argv) > 4 else False
    os.makedirs(image_dir, exist_ok=True)

    with open(notebook_path, "r", encoding="utf-8") as f:
        nb = nbformat.read(f, as_version=4)

    saved = collect_cells(nb, image_dir, "saved", skip_first_markdown)

    client = NotebookClient(
        nb,
        timeout=120,
        kernel_name="python3",
        allow_errors=True,
        resources={"metadata": {"path": work_dir}},
    )
    client.execute()

    rerun = collect_cells(nb, image_dir, "rerun", skip_first_markdown)
    print(json.dumps({"ok": True, "saved": saved, "rerun": rerun}, ensure_ascii=False))
except Exception as exc:
    print(json.dumps({"ok": False, "error": str(exc), "traceback": traceback.format_exc()}, ensure_ascii=False))
`;

export async function buildTabularDataEvidence(artifact: EvidenceArtifact): Promise<string> {
  try {
    const result = parsePythonJson((await runPythonScript(TABULAR_SUMMARY_SCRIPT, [artifact.filepath], 120000)).stdout) as {
      ok?: boolean;
      error?: string;
      [key: string]: unknown;
    };
    if (!result.ok) {
      return `[데이터 요약 evidence]\npandas 요약 생성 실패: ${result.error || 'unknown error'}`;
    }
    return `[데이터 요약 evidence: pandas]\n원본 CSV/XLSX 전체는 토큰 절약을 위해 전송하지 않고 아래 요약만 제공합니다.\nreader_used_for_summary는 서버가 요약 생성을 위해 성공적으로 사용한 읽기 방식이며, 원본 CSV의 확정 인코딩 판정이 아닙니다.\nCSV 인코딩 채점이 필요한 경우에는 encoding_probe를 우선 근거로 사용하세요. 다만 likely_encoding이 ascii-compatible 또는 ambiguous이면 인코딩만으로 감점하지 말고 코드 실행 가능성과 결과를 함께 판단하세요.\n\`\`\`json\n${truncate(JSON.stringify(result, null, 2), 22000)}\n\`\`\``;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return `[데이터 요약 evidence]\npandas 요약 생성 실패: ${message}`;
  }
}

function copyArtifactsToWorkDir(artifacts: EvidenceArtifact[], workDir: string): void {
  const usedNames = new Set<string>();
  for (const artifact of artifacts) {
    const baseName = path.basename(artifact.filename.normalize('NFC'));
    if (!baseName || usedNames.has(baseName)) continue;
    usedNames.add(baseName);
    fs.copyFileSync(artifact.filepath, path.join(workDir, baseName));
  }
}

function appendNotebookSection(lines: string[], title: string, section: any): void {
  lines.push(`\n[${title}]`);
  lines.push(`오류 출력 셀 ${section?.error_count ?? 0}개, 이미지 출력 ${section?.image_count ?? 0}개`);
  for (const cell of section?.cells || []) {
    const label = cell.cell_type === 'markdown' ? `Markdown Cell ${cell.index}` : `Code Cell ${cell.index}`;
    lines.push(`\n[${label}]`);
    if (cell.source) {
      lines.push(cell.cell_type === 'code' ? `\`\`\`python\n${cell.source}\n\`\`\`` : String(cell.source));
    }
    for (const output of cell.outputs || []) {
      if (output.type === 'stream') lines.push(`[stdout:${output.name || 'stream'}]\n${output.text}`);
      else if (output.type === 'result') lines.push(`[result]\n${output.text}`);
      else if (output.type === 'image') lines.push(`[image output] ${output.filename} 첨부`);
      else if (output.type === 'error') lines.push(`[error] ${output.ename}: ${output.evalue}\n${output.traceback || ''}`);
    }
  }
}

function formatNotebookEvidence(result: any): string {
  if (!result?.ok) {
    return `[노트북 실행 evidence]\n노트북 실행 실패 또는 생략: ${result?.error || 'unknown error'}${result?.traceback ? `\n${truncate(result.traceback, 3000)}` : ''}`;
  }

  const lines: string[] = [
    '[노트북 실행 evidence]',
    '제출된 ipynb 내부에 저장된 기존 출력과 현재 제출 파일 기준 재실행 출력을 구분해 제공합니다.',
  ];
  appendNotebookSection(lines, '저장된 기존 ipynb 출력', result.saved);
  appendNotebookSection(lines, '현재 제출 파일 기준 재실행 출력', result.rerun);
  return truncate(lines.join('\n'), 42000);
}

export function notebookExecutionFailure(result: any): string | null {
  if (!result?.ok) return String(result?.error || '노트북 실행 결과를 생성하지 못했습니다.');
  if (!result?.rerun) return '현재 제출 파일 기준 재실행 결과가 없습니다.';
  // allow_errors=True로 수집된 셀 오류는 학생 코드의 실행 결과다.
  // 커널/시간 초과처럼 결과 자체를 만들지 못한 경우만 위에서 실패한다.
  return null;
}

export async function buildNotebookExecutionEvidence(
  notebook: EvidenceArtifact,
  artifacts: EvidenceArtifact[],
  label: string,
  options: NotebookEvidenceOptions = {},
): Promise<NotebookEvidenceResult> {
  const cacheKey = await notebookEvidenceCacheKey(notebook, artifacts, label, options);
  const cached = readNotebookCache(cacheKey);
  if (cached) return cached;

  return artifactExecutionQueue.run(async () => {
    const queuedCache = readNotebookCache(cacheKey);
    if (queuedCache) return queuedCache;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assessment-notebook-work-'));
    const imageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assessment-notebook-images-'));
    try {
      copyArtifactsToWorkDir(artifacts, workDir);
      const notebookPath = path.join(workDir, path.basename(notebook.filename.normalize('NFC')));
      const stdout = (await runPythonScript(NOTEBOOK_EXECUTION_SCRIPT, [
        notebookPath,
        workDir,
        imageDir,
        options.skipFirstMarkdownCell ? '1' : '0',
      ], 600000)).stdout;
      const result = parsePythonJson(stdout);
      const executionError = notebookExecutionFailure(result);
      const attachments = fs.readdirSync(imageDir)
        .filter((filename) => filename.toLowerCase().endsWith('.png'))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        .slice(0, 12)
        .map((filename) => ({
          filename: `${label} ${filename}`,
          mimeType: 'image/png',
          data: fs.readFileSync(path.join(imageDir, filename)).toString('base64'),
        }));
      const evidence: NotebookEvidenceResult = {
        text: formatNotebookEvidence(result),
        attachments,
        executionSucceeded: executionError === null,
        ...(executionError ? { executionError } : {}),
      };
      if (evidence.executionSucceeded) {
        try { writeNotebookCache(cacheKey, evidence); } catch { /* cache failure must not invalidate execution evidence */ }
      }
      return evidence;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        text: `[노트북 실행 evidence]\n노트북 실행 실패 또는 생략: ${message}`,
        attachments: [],
        executionSucceeded: false,
        executionError: message,
      };
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
      fs.rmSync(imageDir, { recursive: true, force: true });
    }
  });
}

function pythonScriptEvidence(stdout: string, stderr: string, exitCode: number): string {
  const lines = [
    '[Python 파일 실행 결과]',
    `종료 코드: ${exitCode}`,
    `[stdout]\n${truncate(stdout.trim() || '(출력 없음)', 12000)}`,
  ];
  if (stderr.trim()) lines.push(`[stderr]\n${truncate(stderr.trim(), 12000)}`);
  return lines.join('\n');
}

async function executePythonFile(scriptPath: string, workDir: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const candidates = [process.env.ASSESSMENT_PYTHON, 'python3', 'python'].filter(Boolean) as string[];
  let lastError: unknown = null;
  for (const pythonPath of candidates) {
    try {
      const result = await execFileAsync(pythonPath, [scriptPath], {
        cwd: workDir,
        timeout: Math.max(100, Number(process.env.PYTHON_EXECUTION_TIMEOUT_MS) || 600000),
        maxBuffer: 20 * 1024 * 1024,
        env: { ...process.env, MPLCONFIGDIR: path.join(workDir, '.matplotlib') },
      });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
    } catch (error) {
      lastError = error;
      const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean; signal?: string | null };
      if (failure.code === 'ENOENT') continue;
      if (failure.killed || failure.signal) throw new Error('Python 파일 실행 시간이 제한을 초과했거나 프로세스가 비정상 종료되었습니다.');
      if (typeof failure.code === 'number') {
        return { stdout: String(failure.stdout || ''), stderr: String(failure.stderr || failure.message || ''), exitCode: failure.code };
      }
      throw error;
    }
  }
  throw lastError || new Error('Python 실행 파일을 찾을 수 없습니다.');
}

export async function buildPythonFileExecutionEvidence(
  script: EvidenceArtifact,
  artifacts: EvidenceArtifact[],
  label: string,
): Promise<NotebookEvidenceResult> {
  const options: NotebookEvidenceOptions = { executionKind: 'python-script' };
  const cacheKey = await notebookEvidenceCacheKey(script, artifacts, label, options);
  const cached = readNotebookCache(cacheKey);
  if (cached) return cached;

  return artifactExecutionQueue.run(async () => {
    const queuedCache = readNotebookCache(cacheKey);
    if (queuedCache) return queuedCache;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assessment-python-work-'));
    try {
      copyArtifactsToWorkDir(artifacts, workDir);
      const scriptPath = path.join(workDir, path.basename(script.filename.normalize('NFC')));
      const result = await executePythonFile(scriptPath, workDir);
      const evidence: NotebookEvidenceResult = {
        text: pythonScriptEvidence(result.stdout, result.stderr, result.exitCode),
        attachments: [],
        // A non-zero exit code and traceback are valid student-code evidence.
        executionSucceeded: true,
      };
      try { writeNotebookCache(cacheKey, evidence); } catch { /* cache failure must not invalidate execution evidence */ }
      return evidence;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        text: `[Python 파일 실행 결과]\n실행 결과 수집 실패: ${message}`,
        attachments: [],
        executionSucceeded: false,
        executionError: message,
      };
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
}
