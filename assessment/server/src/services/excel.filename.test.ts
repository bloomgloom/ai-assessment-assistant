import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { fitWrappedRowHeights, parseCommentsFilename } from './excel';

assert.equal(parseCommentsFilename('2026_1학기_2학년_2_정보_과목세특_1.xlsx')?.room, '1강의실');
assert.equal(parseCommentsFilename('2026_1학기_2학년_1_정보_과목세특_20251022132700.xlsx')?.room, '1강의실');

const workbook = new ExcelJS.Workbook();
const sheet = workbook.addWorksheet('내용');
sheet.getColumn(1).width = 12;
sheet.getColumn(2).width = 40;
sheet.addRow(['이름', '내용']);
sheet.addRow(['학생', '한글로 작성한 긴 기록입니다. '.repeat(20)]);
sheet.addRow(['학생', '짧은 기록']);
fitWrappedRowHeights(sheet, { startRow: 2 });
assert.ok((sheet.getRow(2).height || 0) > (sheet.getRow(3).height || 0));
assert.equal(sheet.getRow(3).height, 18);
