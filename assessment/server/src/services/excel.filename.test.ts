import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { fitWorksheetColumns, parseCommentsFilename } from './excel';
import { compactAreaName, roomNumber, treeBackupFilename } from './backupFilename';

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

assert.equal(roomNumber('2강의실'), '2');
assert.equal(compactAreaName('실생활 문제를 해결하는 인공지능 프로젝트 제작하기'), '실생활 문제를 해결하는-로젝트 제작하기');
assert.equal(treeBackupFilename({
  year: 2026,
  semester: 2,
  grade: 2,
  subject: '인공지능_기초',
  scope: roomNumber('2강의실'),
  kind: '채점기록',
}), '2026_2_2_인공지능-기초_2_채점기록.xlsx');
assert.equal(treeBackupFilename({
  year: 2026,
  semester: 2,
  grade: 2,
  subject: '인공지능 기초',
  scope: '실생활 문제를 해결하는 인공지능 프로젝트 제작하기',
  compactScope: true,
  kind: '평가기준',
}), '2026_2_2_인공지능 기초_실생활 문제를 해결하는-로젝트 제작하기_평가기준.xlsx');
