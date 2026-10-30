import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import AdmZip from 'adm-zip';
import ExcelJS from 'exceljs';
import { entriesFromFolder, entriesFromImportSource, entriesFromZip } from './importEntries';
import { WorkbookGateway } from './lessonPlanExcel';
import { matchStudentsByPath } from './studentMatcher';
import { ArtifactImportService } from './artifactImportService';
import { parseActivityReflectionCsv } from './activityReflectionCsv';
import { activityDateFromPath, importDateFolders, isReflectionImportPath } from './activityImportPaths';
import { activityFilenameDecision, activityProgressForLesson, appendActivityFilename, nextActivityLessonNo } from './activityRules';

async function createAnonymousJournalFixture(filepath: string) {
  const workbook = new ExcelJS.Workbook();
  const plans = workbook.addWorksheet('진도');
  plans.addRow(['차시', '진도', '내용', '메모', '종류', '산출물', '프롬프트']);
  plans.addRow([1, '도입', '익명 예제 시작', '', '개념', 'reference-01.txt', '사실만 기록한다.']);
  plans.addRow([2, '실습', '익명 예제 수행', '', '실습', 'reference-02.ipynb', '완료 단계를 쓴다.']);
  plans.addRow([2, '보충 실습', '진도가 늦은 경우의 중복 차시', '', '실습', 'reference-02.ipynb', '변경 사항을 쓴다.']);

  const room = workbook.addWorksheet('1');
  room.getCell('A6').value = 1; room.getCell('B6').value = 1; room.getCell('C6').value = 1;
  room.getCell('A7').value = 2; room.getCell('B7').value = 1; room.getCell('C7').value = 2;
  room.getCell('E1').value = new Date(Date.UTC(2099, 7, 11));
  room.getCell('E3').value = 1;
  room.getCell('E4').value = { formula: 'XLOOKUP(E3,진도!A:A,진도!B:B)', result: '도입' };
  room.getCell('E5').value = '첫 수업 일지';
  room.getCell('E6').value = '/';
  room.getCell('E7').value = '질문하고 다시 시도함';
  room.getCell('F1').value = new Date(Date.UTC(2099, 7, 12));
  room.getCell('F3').value = 1;
  room.getCell('F4').value = { formula: 'XLOOKUP(F3,진도!A:A,진도!B:B)', result: '도입' };
  room.getCell('F5').value = '중복 차시 일지';
  room.getCell('G1').value = new Date(Date.UTC(2099, 0, 1));
  room.getCell('G3').value = { formula: 'F3+1', result: 2 };
  room.getCell('G4').value = { formula: 'XLOOKUP(G3,진도!A:A,진도!B:B)', result: '실습' };
  await workbook.xlsx.writeFile(filepath);
}

async function main() {
  assert.equal(nextActivityLessonNo(undefined), 1);
  assert.equal(nextActivityLessonNo(1), 2);
  assert.equal(nextActivityLessonNo(2), 3);
  const delayedLessonSequence = [1, nextActivityLessonNo(1), 2, nextActivityLessonNo(2)];
  assert.deepEqual(delayedLessonSequence, [1, 2, 2, 3]);
  assert.equal(activityProgressForLesson([{ lessonNo: 2, progress: '보충 실습' }], 2), '보충 실습');
  assert.equal(activityProgressForLesson([{ lessonNo: 2, progress: '보충 실습' }], 3), '');
  assert.equal(activityFilenameDecision(['산출물.txt'], '산출물.txt'), 'unchanged');
  assert.equal(activityFilenameDecision(['산출물.txt'], '추가제출.txt'), 'add');
  assert.deepEqual(appendActivityFilename(['산출물.txt'], '추가제출.txt'), ['산출물.txt', '추가제출.txt']);
  assert.deepEqual(appendActivityFilename(['산출물.txt'], '산출물.txt'), ['산출물.txt']);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-feature-test-'));
  try {
    const xlsxPath = path.join(root, 'journal.xlsx');
    await createAnonymousJournalFixture(xlsxPath);

    const reader = await WorkbookGateway.open(xlsxPath);
    const planRows = reader.readPlans();
    assert.equal(planRows[0].sourceFiles, 'reference-01.txt');
    assert.deepEqual(planRows.map(row => row.lessonNo), [1, 2, 2]);
    const dates = reader.readClassroom('1강의실');
    assert.equal(dates[0].date, '2099-08-11');
    assert.equal(dates[0].progress, '도입');
    assert.equal(dates[0].observations[0].absent, true);
    assert.equal(dates[0].observations[1].note, '질문하고 다시 시도함');
    assert.equal(dates[1].lessonNo, 1);
    assert.equal(dates.length, 2);

    const exportedJournalPath = path.join(root, 'exported-journal.xlsx');
    const exportedGateway = WorkbookGateway.createJournal(planRows, [{
      room: '1강의실',
      students: [{ id: 1, classNum: 2, seatNum: 1, name: '익명학생' }],
      dates: [
        { date: '2099-08-11', lessonNo: 1, progress: '도입', journal: '수업 일지', observations: new Map([[1, { isAbsent: false, note: '관찰 내용' }]]) },
        { date: '2099-08-12', lessonNo: 1, progress: '도입', journal: '진도 지연', observations: new Map([[1, { isAbsent: true, note: '' }]]) },
      ],
    }]);
    fs.writeFileSync(exportedJournalPath, Buffer.from(await exportedGateway.writeBuffer()));
    const exportedWorkbook = new ExcelJS.Workbook();
    await exportedWorkbook.xlsx.readFile(exportedJournalPath);
    const exportedRoom = exportedWorkbook.getWorksheet('1')!;
    assert.equal(exportedRoom.getCell('A1').value, '날짜');
    assert.equal(exportedRoom.getCell('A6').value, 1);
    assert.equal(exportedRoom.getCell('B6').value, 2);
    assert.equal(exportedRoom.getCell('C6').value, 1);
    assert.equal(exportedRoom.getCell('D6').value, '익명학생');
    assert.equal((exportedRoom.getCell('E2').value as ExcelJS.CellFormulaValue).formula.startsWith('COUNTA('), true);
    assert.equal((exportedRoom.getCell('E4').value as ExcelJS.CellFormulaValue).formula.startsWith('_xlfn.XLOOKUP('), true);
    assert.equal(exportedRoom.views[0].state, 'frozen');
    assert.equal((exportedRoom.views[0] as any).xSplit, 4);
    assert.equal((exportedRoom.views[0] as any).ySplit, 5);
    assert.equal(exportedRoom.getColumn(5).width, 30.7109375);
    assert.equal(exportedRoom.getRow(4).height, 50);
    assert.equal(exportedRoom.getCell('D6').font.name, '맑은 고딕');
    assert.equal(exportedRoom.getCell('E6').value, '관찰 내용');
    assert.equal(exportedRoom.getCell('F6').value, '/');
    const templateDate = exportedRoom.getCell('G1').value;
    assert.equal(templateDate instanceof Date, true);
    assert.equal((templateDate as Date).getUTCFullYear(), new Date().getFullYear());
    assert.equal((templateDate as Date).getUTCMonth(), 0);
    assert.equal((templateDate as Date).getUTCDate(), 1);
    assert.equal(exportedRoom.getCell('G1').numFmt, 'm"월" d"일"');
    assert.equal((exportedRoom.getCell('G3').value as ExcelJS.CellFormulaValue).formula, 'F3+1');
    assert.equal((exportedRoom.getCell('G3').value as ExcelJS.CellFormulaValue).result, 2);
    assert.equal((exportedRoom.getCell('G4').value as ExcelJS.CellFormulaValue).result, '실습');
    assert.equal((await WorkbookGateway.open(exportedJournalPath)).readClassroom('1').length, 2);

    const planOnlyPath = path.join(root, 'progress.xlsx');
    fs.writeFileSync(planOnlyPath, Buffer.from(await WorkbookGateway.createPlan(planRows).writeBuffer()));
    const planOnlyWorkbook = new ExcelJS.Workbook();
    await planOnlyWorkbook.xlsx.readFile(planOnlyPath);
    assert.deepEqual(planOnlyWorkbook.worksheets.map(sheet => sheet.name), ['진도']);
    const exportedPlan = planOnlyWorkbook.getWorksheet('진도')!;
    assert.equal(exportedPlan.views[0].state, 'frozen');
    assert.equal((exportedPlan.views[0] as any).ySplit, 1);
    assert.equal((exportedPlan.getCell('A1').fill as ExcelJS.FillPattern).fgColor?.argb, 'FFD9D9D9');
    assert.deepEqual(exportedPlan.getCell('A1').fill, exportedRoom.getCell('A1').fill);

    const folder = path.join(root, 'source');
    fs.mkdirSync(path.join(folder, '8월 11일'), { recursive: true });
    fs.writeFileSync(path.join(folder, '8월 11일', '20101_테스트__2099-08-11_1000__work.txt'), 'ok');
    const zipPath = path.join(root, 'source.zip');
    const zip = new AdmZip();
    zip.addLocalFolder(folder);
    zip.writeZip(zipPath);
    assert.deepEqual((await entriesFromFolder(folder)).map(item => item.relativePath), (await entriesFromZip(zipPath)).map(item => item.relativePath));
    assert.deepEqual((await entriesFromImportSource({ folderPath: folder })).map(item => item.relativePath), (await entriesFromImportSource({ zipPath })).map(item => item.relativePath));
    const anonymousStudents = [
      { id: 1, student_num: 20101, name: '가나다' },
      { id: 2, student_num: 20102, name: '라마바' },
    ];
    assert.deepEqual(matchStudentsByPath('8월 11일/20101_가나다__work.txt', anonymousStudents).map(student => student.id), [1]);
    assert.deepEqual(matchStudentsByPath('8월 11일/20101_다른이름__work.txt', anonymousStudents), []);
    assert.deepEqual(matchStudentsByPath('8월 11일/99999_가나다__work.txt', anonymousStudents), []);
    assert.equal(matchStudentsByPath('20101_가나다.txt', [{ id: 1, student_num: 20101, name: '가나다' }, { id: 3, student_num: 20101, name: '가나다' }]).length, 2);
    assert.equal(matchStudentsByPath(`20101_${'가나다'.normalize('NFD')}.txt`, anonymousStudents).length, 1);

    const service = new ArtifactImportService(anonymousStudents, {
      resolve: async () => ({ kind: 'read' as const, target: undefined }),
      store: async context => ({ path: context.path, status: 'uploaded' as const, studentId: context.student.id, filename: context.filename }),
    });
    const serviceResult = await service.run([
      { relativePath: '20101_가나다.txt', read: async () => Buffer.from('ok') },
      { relativePath: '20102_라마바.txt', read: async () => { throw new Error('익명 읽기 오류'); } },
      { relativePath: '99999_미매칭.txt', read: async () => Buffer.from('skip') },
    ]);
    assert.equal(serviceResult.total, 3);
    assert.deepEqual(serviceResult.results.map(result => result.status), ['uploaded', 'read_error', 'unmatched']);
    assert.equal(serviceResult.matchedStudentIds.size, 2);

    const reflectionCsv = ['날짜,학습주제,Plus,Minus,Interesting'];
    for (let day = 1; day <= 7; day += 1) reflectionCsv.push(`2099. 9. ${day},익명 주제 ${day},"쉼표, 포함 ${day}",${day === 2 ? '"줄1\n줄2"' : ''},`);
    const reflectionRecords = parseActivityReflectionCsv(Buffer.from(reflectionCsv.join('\n')));
    assert.equal(reflectionRecords.length, 7);
    assert.equal(reflectionRecords[0].date, '2099-09-01');
    assert.equal(reflectionRecords[0].plus, '쉼표, 포함 1');
    assert.equal(reflectionRecords[1].minus, '줄1\n줄2');
    assert.throws(() => parseActivityReflectionCsv(Buffer.from('잘못된,머리글\n값,값')), /머리글/);
    assert.throws(() => parseActivityReflectionCsv(Buffer.from('날짜,학습주제,Plus,Minus,Interesting\n2099-02-30,주제,,,,')), /날짜 형식/);
    assert.equal(activityDateFromPath('강의실/2099-09-01 첫 수업/20101_가나다.txt'), '2099-09-01');
    assert.equal(activityDateFromPath('강의실/9월 1일/20101_가나다.txt'), '');
    assert.equal(isReflectionImportPath('강의실/되돌아보기/20101_가나다.csv'), true);
    assert.deepEqual(importDateFolders([
      { relativePath: '2099-09-01/가.txt', read: async () => Buffer.from('') },
      { relativePath: '2099-09-01 설명/나.txt', read: async () => Buffer.from('') },
      { relativePath: '2099-09-02/다.txt', read: async () => Buffer.from('') },
    ]), ['2099-09-01', '2099-09-02']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exit(1); });
