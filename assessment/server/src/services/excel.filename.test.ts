import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { fitWorksheetColumns, parseCommentsFilename } from './excel';

assert.equal(parseCommentsFilename('2026_1학기_2학년_2_정보_과목세특_1.xlsx')?.room, '1강의실');
assert.equal(parseCommentsFilename('2026_1학기_2학년_1_정보_과목세특_20251022132700.xlsx')?.room, '1강의실');

const workbook = new ExcelJS.Workbook();
const sheet = workbook.addWorksheet('내용');
sheet.addRow(['student_num', 'value']);
sheet.addRow([20201, '긴 내용이 들어가는 백업 열의 너비']);
fitWorksheetColumns(sheet);
assert.equal(sheet.getColumn(1).width, 15);
assert.equal(sheet.getColumn(2).width, 23);
assert.ok(Number.isFinite(sheet.getColumn(1).width));
assert.ok(Number.isFinite(sheet.getColumn(2).width));
