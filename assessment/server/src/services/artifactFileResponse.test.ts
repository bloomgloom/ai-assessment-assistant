import assert from 'node:assert/strict';
import { artifactContentType } from './artifactFileResponse';

assert.equal(artifactContentType('analysis.PY'), 'text/x-python; charset=utf-8');
assert.equal(artifactContentType('result.csv'), 'text/csv; charset=utf-8');
assert.equal(artifactContentType('unknown.bin', 'application/custom'), 'application/custom');
assert.equal(artifactContentType('unknown.bin'), 'application/octet-stream');

console.log('artifact file response tests passed');
