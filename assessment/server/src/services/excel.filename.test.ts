import assert from 'node:assert/strict';
import { parseCommentsFilename } from './excel';

assert.equal(parseCommentsFilename('2026_1학기_2학년_2_정보_과목세특_1.xlsx')?.room, '1강의실');
assert.equal(parseCommentsFilename('2026_1학기_2학년_1_정보_과목세특_20251022132700.xlsx')?.room, '1강의실');
