import assert from 'node:assert/strict';
import { parseBulkExistingPolicy, preflightArtifactImports } from './artifactImportService';
import type { ImportEntry } from './importEntries';

const entries: ImportEntry[] = [
  { relativePath: '제출/10101홍길동/result.csv', read: async () => Buffer.alloc(0) },
  { relativePath: '제출/_관리용.csv', read: async () => Buffer.alloc(0) },
];
const students = [
  { id: 1, student_num: 10101, name: '홍길동' },
  { id: 2, student_num: 10102, name: '김학생' },
];

assert.equal(parseBulkExistingPolicy('skip'), 'skip');
assert.equal(parseBulkExistingPolicy('replace'), 'replace');
assert.equal(parseBulkExistingPolicy('append'), 'append');
assert.equal(parseBulkExistingPolicy('invalid'), null);
assert.equal(parseBulkExistingPolicy(undefined), null);

const matches = preflightArtifactImports(entries, students, (_entry, filename) => !filename.startsWith('_'));
assert.equal(matches.length, 1);
assert.equal(matches[0].filename, 'result.csv');
assert.deepEqual(matches[0].matches.map(student => student.id), [1]);

console.log('artifact import service tests passed');
