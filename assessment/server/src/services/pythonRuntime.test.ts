import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'python-runtime-test-'));
  process.env.PYTHON_RUNTIME_DIR = tempDir;
  process.env.ASSESSMENT_BOOTSTRAP_PYTHON = process.env.PYTHON_TEST_EXECUTABLE || 'python3';
  process.env.ASSESSMENT_BASE_REQUIREMENTS_JSON = '[]';

  try {
    // The runtime path is captured when the module loads, so require it only
    // after the isolated temporary directory has been configured.
    const runtime = require('./pythonRuntime') as typeof import('./pythonRuntime');
    assert.deepStrictEqual(
      runtime.normalizeRequirements(['pandas', 'scikit-learn', 'pandas==2.2.3'], ['pandas==2.2.3']),
      ['scikit-learn'],
    );
    assert.deepStrictEqual(runtime.planRequirementStages(['a'], ['a', 'b', 'c']), [
      { requirement: 'b', requirements: ['a', 'b'] },
      { requirement: 'c', requirements: ['a', 'b', 'c'] },
    ]);
    assert.deepStrictEqual(runtime.planRequirementStages(['a', 'b'], ['a']), [
      { requirement: 'requirements 정리', requirements: ['a'] },
    ]);
    assert.deepStrictEqual(runtime.planRequirementStages(['a', 'b'], ['a', 'c', 'd']), [
      { requirement: 'c', requirements: ['a', 'c'] },
      { requirement: 'd', requirements: ['a', 'c', 'd'] },
    ]);
    assert.deepStrictEqual(runtime.getPythonRuntimeState().requirements, []);

    const events: import('./pythonRuntime').PythonRuntimeProgress[] = [];
    const state = await runtime.applyPythonRequirements([], event => events.push(event));
    assert.equal(state.ready, true);
    assert.equal(state.installing, false);
    assert.deepStrictEqual(state.requirements, []);
    assert.deepStrictEqual(state.baseRequirements, []);
    assert.equal(fs.existsSync(state.pythonPath), true);
    assert.equal(events.some(event => event.type === 'done'), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log('pythonRuntime tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
