import assert from 'node:assert/strict';
import { studentDownloadFilename } from './filename';
import { storedArtifactFilename } from './artifactStorageFilename';

assert.equal(studentDownloadFilename(3, 9, 35, '홍길동', '코드.cpp'), '30935홍길동_코드.cpp');
assert.equal(studentDownloadFilename(2, 1, 7, '김 민수', '과제/답.txt'), '20107김민수_과제_답.txt');
assert.equal(
  storedArtifactFilename(20101, '홍길동', 'b.csv', { now: 1795000000000, randomHex: 'a8f31c92d5e7401b' }),
  '1795000000000_20101_홍길동_a8f31c92d5e7401b_b.csv',
);
