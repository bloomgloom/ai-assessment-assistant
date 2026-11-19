import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

export interface PythonRuntimeState {
  ready: boolean;
  installing: boolean;
  pythonPath: string;
  runtimeDir: string;
  requirements: string[];
  baseRequirements: string[];
  interrupted: boolean;
}
export interface PythonRuntimeProgress {
  type: 'progress' | 'committed' | 'done';
  message: string;
  current?: number;
  total?: number;
  requirement?: string;
  requirements?: string[];
  state?: PythonRuntimeState;
}

const runtimeRoot = path.resolve(
  process.env.PYTHON_RUNTIME_DIR
    || path.join(path.dirname(process.env.APP_STORAGE_DIR || path.join(process.cwd(), 'storage')), 'python-runtime')
);
const currentEnvDir = path.join(runtimeRoot, 'current');
const requirementsPath = path.join(runtimeRoot, 'requirements.txt');
const manifestPath = path.join(runtimeRoot, 'runtime-manifest.json');
const installingPath = path.join(runtimeRoot, 'installing.json');
let installing = false;
export const BASE_REQUIREMENTS: string[] = process.env.ASSESSMENT_BASE_REQUIREMENTS_JSON
  ? JSON.parse(process.env.ASSESSMENT_BASE_REQUIREMENTS_JSON)
  : [
      'pandas==2.2.3',
      'openpyxl==3.1.5',
      'nbformat==5.10.4',
      'nbclient==0.10.2',
      'ipykernel==6.29.5',
    ];

function envPython(envDir: string): string {
  return process.platform === 'win32'
    ? path.join(envDir, 'Scripts', 'python.exe')
    : path.join(envDir, 'bin', 'python3');
}

function bootstrapPython(): string {
  return process.env.ASSESSMENT_BOOTSTRAP_PYTHON || process.env.ASSESSMENT_PYTHON || 'python3';
}

export function normalizeRequirements(value: unknown, baseRequirements: string[] = BASE_REQUIREMENTS): string[] {
  const lines = Array.isArray(value) ? value : String(value || '').split(/\r?\n/);
  const seen = new Set<string>();
  const baseNames = new Set(baseRequirements.map(requirement => requirement.split(/[\s<>=!~@\[]/, 1)[0].toLowerCase().replace(/[_.]+/g, '-')));
  const result: string[] = [];
  for (const item of lines) {
    const line = String(item).trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('-')) throw new Error(`requirements 옵션은 사용할 수 없습니다: ${line}`);
    if (/[\r\n\0]/.test(line)) throw new Error('requirements 항목에 허용되지 않는 문자가 있습니다.');
    const packageName = line.split(/[\s<>=!~@\[]/, 1)[0].toLowerCase().replace(/[_.]+/g, '-');
    if (baseNames.has(packageName)) continue;
    if (!seen.has(line)) {
      seen.add(line);
      result.push(line);
    }
  }
  return result;
}

export function planRequirementStages(committed: string[], desired: string[]): Array<{ requirement: string; requirements: string[] }> {
  const stages: Array<{ requirement: string; requirements: string[] }> = [];
  const removed = committed.some(item => !desired.includes(item));
  const cumulative = removed
    ? desired.filter(item => committed.includes(item))
    : [...committed];
  const additions = desired.filter(item => !cumulative.includes(item));

  if (removed && additions.length === 0) {
    stages.push({ requirement: 'requirements 정리', requirements: [...cumulative] });
    return stages;
  }

  for (const item of additions) {
    cumulative.push(item);
    stages.push({ requirement: item, requirements: [...cumulative] });
  }
  return stages;
}

function readRequirements(): string[] {
  if (!fs.existsSync(requirementsPath)) return [];
  return normalizeRequirements(fs.readFileSync(requirementsPath, 'utf8'));
}

function writeJsonAtomic(filepath: string, value: unknown): void {
  const tmp = `${filepath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filepath);
}

function writeRequirementsAtomic(requirements: string[]): void {
  const tmp = `${requirementsPath}.tmp`;
  fs.writeFileSync(tmp, requirements.length ? `${requirements.join('\n')}\n` : '', 'utf8');
  fs.renameSync(tmp, requirementsPath);
}

function run(command: string, args: string[], onOutput?: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, PYTHONNOUSERSITE: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    const consume = (chunk: Buffer) => {
      const text = chunk.toString();
      stderr = `${stderr}${text}`.slice(-12000);
      for (const line of text.split(/\r?\n/).map(value => value.trim()).filter(Boolean)) onOutput?.(line);
    };
    child.stdout.on('data', consume);
    child.stderr.on('data', consume);
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${path.basename(command)} 종료 코드 ${code}`));
    });
  });
}

async function buildEnvironment(targetDir: string, requirements: string[], onOutput?: (line: string) => void): Promise<void> {
  fs.rmSync(targetDir, { recursive: true, force: true });
  await run(bootstrapPython(), ['-m', 'venv', targetDir], onOutput);
  const python = envPython(targetDir);
  for (const requirement of [...BASE_REQUIREMENTS, ...requirements]) {
    await run(python, ['-m', 'pip', 'install', requirement], onOutput);
  }
  await run(python, ['-m', 'pip', 'check'], onOutput);
}

function activateEnvironment(candidateDir: string, requirements: string[]): void {
  const previousDir = path.join(runtimeRoot, 'previous');
  const previousRequirements = fs.existsSync(requirementsPath) ? fs.readFileSync(requirementsPath) : null;
  const previousManifest = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath) : null;
  fs.rmSync(previousDir, { recursive: true, force: true });
  if (fs.existsSync(currentEnvDir)) fs.renameSync(currentEnvDir, previousDir);
  try {
    fs.renameSync(candidateDir, currentEnvDir);
    writeRequirementsAtomic(requirements);
    writeJsonAtomic(manifestPath, {
      ready: true,
      pythonPath: envPython(currentEnvDir),
      baseRequirements: BASE_REQUIREMENTS,
      requirements,
      updatedAt: new Date().toISOString(),
    });
    process.env.ASSESSMENT_PYTHON = envPython(currentEnvDir);
    fs.rmSync(previousDir, { recursive: true, force: true });
  } catch (error) {
    fs.rmSync(currentEnvDir, { recursive: true, force: true });
    if (fs.existsSync(previousDir)) fs.renameSync(previousDir, currentEnvDir);
    if (previousRequirements) fs.writeFileSync(requirementsPath, previousRequirements);
    else fs.rmSync(requirementsPath, { force: true });
    if (previousManifest) fs.writeFileSync(manifestPath, previousManifest);
    else fs.rmSync(manifestPath, { force: true });
    fs.rmSync(`${requirementsPath}.tmp`, { force: true });
    fs.rmSync(`${manifestPath}.tmp`, { force: true });
    if (fs.existsSync(envPython(currentEnvDir))) process.env.ASSESSMENT_PYTHON = envPython(currentEnvDir);
    throw error;
  }
}

export function getPythonRuntimeState(): PythonRuntimeState {
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const pythonPath = envPython(currentEnvDir);
  let persistentReady = false;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    persistentReady = fs.existsSync(pythonPath)
      && JSON.stringify(manifest.baseRequirements) === JSON.stringify(BASE_REQUIREMENTS);
  } catch {
    persistentReady = false;
  }
  const fallbackPython = bootstrapPython();
  const fallbackReady = Boolean(fallbackPython) && fs.existsSync(fallbackPython);
  return {
    ready: persistentReady || fallbackReady,
    installing,
    pythonPath: persistentReady ? pythonPath : (fallbackReady ? fallbackPython : ''),
    runtimeDir: runtimeRoot,
    requirements: readRequirements(),
    baseRequirements: [...BASE_REQUIREMENTS],
    interrupted: fs.existsSync(installingPath),
  };
}

export async function applyPythonRequirements(
  desiredValue: unknown,
  onProgress: (event: PythonRuntimeProgress) => void,
): Promise<PythonRuntimeState> {
  if (installing) throw new Error('다른 Python 환경 작업이 진행 중입니다.');
  installing = true;
  fs.mkdirSync(runtimeRoot, { recursive: true });
  for (const entry of fs.readdirSync(runtimeRoot)) {
    if (entry.startsWith('candidate-')) fs.rmSync(path.join(runtimeRoot, entry), { recursive: true, force: true });
  }

  try {
    const desired = normalizeRequirements(desiredValue);
    let committed = readRequirements();
    const stages = planRequirementStages(committed, desired);

    if (!stages.length && !getPythonRuntimeState().ready) {
      stages.push({ requirement: '빈 Python 환경', requirements: committed });
    }

    for (let index = 0; index < stages.length; index += 1) {
      const stage = stages[index];
      const candidateDir = path.join(runtimeRoot, `candidate-${Date.now()}-${index}`);
      writeJsonAtomic(installingPath, {
        requirement: stage.requirement,
        committed,
        requested: desired,
        startedAt: new Date().toISOString(),
      });
      onProgress({
        type: 'progress',
        message: `${stage.requirement} 설치 환경을 준비하고 있습니다.`,
        current: index + 1,
        total: stages.length,
        requirement: stage.requirement,
      });
      try {
        await buildEnvironment(candidateDir, stage.requirements, line => onProgress({
          type: 'progress',
          message: line,
          current: index + 1,
          total: stages.length,
          requirement: stage.requirement,
        }));
        activateEnvironment(candidateDir, stage.requirements);
        committed = [...stage.requirements];
        onProgress({
          type: 'committed',
          message: `${stage.requirement} 적용 완료`,
          current: index + 1,
          total: stages.length,
          requirement: stage.requirement,
          requirements: committed,
        });
        fs.rmSync(installingPath, { force: true });
      } catch (error) {
        fs.rmSync(candidateDir, { recursive: true, force: true });
        throw error;
      }
    }

    fs.rmSync(installingPath, { force: true });
    const state = { ...getPythonRuntimeState(), installing: false };
    onProgress({ type: 'done', message: 'Python 환경 적용이 완료되었습니다.', state });
    return state;
  } finally {
    installing = false;
  }
}
