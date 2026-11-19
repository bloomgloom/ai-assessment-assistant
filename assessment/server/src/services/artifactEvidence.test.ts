import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function run(): Promise<void> {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-evidence-storage-test-'));
  process.env.APP_STORAGE_DIR = storageDir;
  process.env.ASSESSMENT_PYTHON = process.env.PYTHON_TEST_EXECUTABLE || 'python3';
  const runtime = require('./artifactEvidence') as typeof import('./artifactEvidence');
  const { notebookEvidenceCacheKey, notebookExecutionFailure } = runtime;
  assert.equal(notebookExecutionFailure({ ok: true, rerun: { error_count: 0, cells: [] } }), null);
  assert.equal(
    notebookExecutionFailure({ ok: false, error: 'A cell timed out after 30 seconds.' }),
    'A cell timed out after 30 seconds.',
  );
  assert.equal(
    notebookExecutionFailure({
      ok: true,
      rerun: {
        error_count: 1,
        cells: [{ outputs: [{ type: 'error', ename: 'FileNotFoundError', evalue: 'missing.csv' }] }],
      },
    }),
    null,
  );
  assert.equal(
    notebookExecutionFailure({ ok: true }),
    '현재 제출 파일 기준 재실행 결과가 없습니다.',
  );

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-evidence-cache-test-'));
  try {
    const notebookPath = path.join(dir, 'answer.ipynb');
    const dataPath = path.join(dir, 'data.csv');
    fs.writeFileSync(notebookPath, '{}');
    fs.writeFileSync(dataPath, 'a\n1\n');
    const notebook = { filename: 'answer.ipynb', filepath: notebookPath };
    const artifacts = [notebook, { filename: 'data.csv', filepath: dataPath }];
    const first = await notebookEvidenceCacheKey(notebook, artifacts, 'file_001.ipynb');
    const same = await notebookEvidenceCacheKey(notebook, artifacts, 'file_001.ipynb');
    assert.equal(first, same);
    fs.writeFileSync(dataPath, 'a\n2\n');
    const changed = await notebookEvidenceCacheKey(notebook, artifacts, 'file_001.ipynb');
    assert.notEqual(first, changed);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const pythonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'python-file-evidence-test-'));
  try {
    const errorPath = path.join(pythonDir, 'student_error.py');
    fs.writeFileSync(errorPath, 'import definitely_missing_student_package\n');
    const errorEvidence = await runtime.buildPythonFileExecutionEvidence(
      { filename: 'student_error.py', filepath: errorPath },
      [{ filename: 'student_error.py', filepath: errorPath }],
      'file_001.py',
    );
    assert.equal(errorEvidence.executionSucceeded, true);
    assert.match(errorEvidence.text, /ModuleNotFoundError/);

    const counterPath = path.join(pythonDir, 'counter.txt');
    process.env.CACHE_COUNTER_PATH = counterPath;
    const cachedPath = path.join(pythonDir, 'cached.py');
    fs.writeFileSync(cachedPath, 'import os\nopen(os.environ["CACHE_COUNTER_PATH"], "a").write("run\\n")\nprint("ok")\n');
    const cachedArtifact = { filename: 'cached.py', filepath: cachedPath };
    await runtime.buildPythonFileExecutionEvidence(cachedArtifact, [cachedArtifact], 'file_001.py');
    await runtime.buildPythonFileExecutionEvidence(cachedArtifact, [cachedArtifact], 'file_001.py');
    assert.equal(fs.readFileSync(counterPath, 'utf8'), 'run\n');

    process.env.PYTHON_EXECUTION_TIMEOUT_MS = '100';
    const timeoutPath = path.join(pythonDir, 'timeout.py');
    fs.writeFileSync(timeoutPath, 'import time\ntime.sleep(2)\n');
    const timeoutEvidence = await runtime.buildPythonFileExecutionEvidence(
      { filename: 'timeout.py', filepath: timeoutPath },
      [{ filename: 'timeout.py', filepath: timeoutPath }],
      'file_001.py',
    );
    assert.equal(timeoutEvidence.executionSucceeded, false);
    assert.match(timeoutEvidence.executionError || '', /제한을 초과|비정상 종료/);
  } finally {
    delete process.env.CACHE_COUNTER_PATH;
    delete process.env.PYTHON_EXECUTION_TIMEOUT_MS;
    fs.rmSync(pythonDir, { recursive: true, force: true });
    fs.rmSync(storageDir, { recursive: true, force: true });
  }
}

run().then(() => console.log('artifact evidence status tests passed')).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
