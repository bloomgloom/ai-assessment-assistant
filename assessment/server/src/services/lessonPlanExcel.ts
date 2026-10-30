import ExcelJS from 'exceljs';

export interface LessonPlanRow {
  id: string;
  lessonNo: number;
  progress: string;
  content: string;
  memo: string;
  kind: '개념' | '실습' | '탐구' | '기타';
  sourceFiles: string;
  prompt: string;
}

export interface ExcelActivityDate {
  date: string;
  lessonNo: number;
  progress: string;
  journal: string;
  observations: Array<{ classNum: number; seatNum: number; absent: boolean; note: string }>;
}

export interface JournalStudent {
  id: number;
  classNum: number;
  seatNum: number;
  name: string;
}

export interface JournalDate {
  date: string;
  lessonNo: number;
  progress: string;
  journal: string;
  observations: Map<number, { isAbsent: boolean; note: string }>;
}

export interface JournalClassroom {
  room: string;
  students: JournalStudent[];
  dates: JournalDate[];
}

function cellResult(cell: ExcelJS.Cell): unknown {
  const value = cell.value as any;
  if (value && typeof value === 'object' && 'result' in value) return value.result;
  return value;
}

function text(cell: ExcelJS.Cell): string {
  const value = cellResult(cell);
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value).trim();
}

function number(cell: ExcelJS.Cell): number {
  const value = Number(cellResult(cell));
  return Number.isFinite(value) ? value : 0;
}

function isoDate(value: unknown): string {
  if (value instanceof Date) {
    return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
  }
  const raw = String(value ?? '').trim();
  const match = raw.match(/^(\d{4})[-./]\s*(\d{1,2})[-./]\s*(\d{1,2})/);
  if (!match) return '';
  return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
}

function classroomSheetName(room: string): string {
  const raw = String(room).trim();
  return raw.match(/^\s*(\d+)\s*(?:강의실)?\s*$/)?.[1] || raw.replace(/\s*강의실\s*$/, '') || raw;
}

export class WorkbookGateway {
  private constructor(private readonly workbook: ExcelJS.Workbook) {}

  static async open(filepath: string): Promise<WorkbookGateway> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filepath);
    return new WorkbookGateway(workbook);
  }

  static createPlan(rows: LessonPlanRow[]): WorkbookGateway {
    const workbook = new ExcelJS.Workbook();
    WorkbookGateway.addPlanSheet(workbook, rows);
    return new WorkbookGateway(workbook);
  }

  static createJournal(rows: LessonPlanRow[], classrooms: JournalClassroom[]): WorkbookGateway {
    const workbook = new ExcelJS.Workbook();
    WorkbookGateway.addPlanSheet(workbook, rows);
    for (const classroom of classrooms) WorkbookGateway.addClassroomSheet(workbook, rows, classroom);
    return new WorkbookGateway(workbook);
  }

  async writeBuffer(): Promise<ExcelJS.Buffer> {
    return this.workbook.xlsx.writeBuffer();
  }

  readPlans(): LessonPlanRow[] {
    const sheet = this.workbook.getWorksheet('진도');
    if (!sheet) throw new Error('엑셀에서 "진도" 시트를 찾을 수 없습니다.');
    const headerMap = new Map<string, number>();
    sheet.getRow(1).eachCell((cell, column) => headerMap.set(text(cell), column));
    const required = ['차시', '진도', '내용', '메모', '종류', '산출물', '프롬프트'];
    for (const header of required) if (!headerMap.has(header)) throw new Error(`진도 시트에 "${header}" 머리글이 없습니다.`);
    const rows: LessonPlanRow[] = [];
    for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
      const row = sheet.getRow(rowNumber);
      const lessonNo = Math.trunc(number(row.getCell(headerMap.get('차시')!)));
      if (!lessonNo) continue;
      const kindRaw = text(row.getCell(headerMap.get('종류')!));
      const kind = ['개념', '실습', '탐구', '기타'].includes(kindRaw) ? kindRaw as LessonPlanRow['kind'] : '기타';
      rows.push({
        id: `excel:${rowNumber}`,
        lessonNo,
        progress: text(row.getCell(headerMap.get('진도')!)),
        content: text(row.getCell(headerMap.get('내용')!)),
        memo: text(row.getCell(headerMap.get('메모')!)),
        kind,
        sourceFiles: text(row.getCell(headerMap.get('산출물')!)),
        prompt: text(row.getCell(headerMap.get('프롬프트')!)),
      });
    }
    return rows;
  }

  readClassroom(room: string): ExcelActivityDate[] {
    const roomNumber = classroomSheetName(room);
    const sheet = this.workbook.getWorksheet(roomNumber);
    if (!sheet) throw new Error(`엑셀에서 강의실 시트 "${roomNumber}"을 찾을 수 없습니다.`);
    const dates: ExcelActivityDate[] = [];
    for (let column = 5; column <= sheet.columnCount; column += 1) {
      const date = isoDate(cellResult(sheet.getCell(1, column)));
      if (!date) continue;
      const observations: ExcelActivityDate['observations'] = [];
      for (let row = 6; row <= sheet.rowCount; row += 1) {
        const classNum = number(sheet.getCell(row, 2));
        const seatNum = number(sheet.getCell(row, 3));
        if (!classNum || !seatNum) continue;
        const value = text(sheet.getCell(row, column));
        observations.push({
          classNum,
          seatNum,
          absent: value === '/',
          note: value && value !== '/' ? value : '',
        });
      }
      dates.push({
        date,
        lessonNo: number(sheet.getCell(3, column)),
        progress: text(sheet.getCell(4, column)),
        journal: text(sheet.getCell(5, column)),
        observations,
      });
    }
    const last = dates.at(-1);
    const previous = dates.at(-2);
    const lastLessonCell = sheet.getCell(3, sheet.columnCount).value as any;
    const lastLooksLikeTemplate = !!last && !!previous
      && last.date <= previous.date
      && !!lastLessonCell && typeof lastLessonCell === 'object' && ('formula' in lastLessonCell || 'sharedFormula' in lastLessonCell)
      && !last.journal
      && last.observations.every(observation => !observation.absent && !observation.note);
    if (lastLooksLikeTemplate) dates.pop();
    return dates;
  }

  private static addPlanSheet(workbook: ExcelJS.Workbook, rows: LessonPlanRow[]) {
    const sheet = workbook.addWorksheet('진도');
    sheet.addRow(['차시', '진도', '내용', '메모', '종류', '산출물', '프롬프트']);
    rows.forEach(row => sheet.addRow([row.lessonNo, row.progress, row.content, row.memo, row.kind, row.sourceFiles, row.prompt]));
    WorkbookGateway.formatPlanSheet(sheet);
  }

  private static addClassroomSheet(workbook: ExcelJS.Workbook, plans: LessonPlanRow[], classroom: JournalClassroom) {
    const sheet = workbook.addWorksheet(classroomSheetName(classroom.room));
    sheet.getCell('A1').value = '날짜';
    sheet.getCell('A2').value = '인원';
    sheet.getCell('A3').value = '차시';
    sheet.getCell('A4').value = '진도';
    sheet.getCell('A5').value = '일지';
    classroom.students.forEach((student, index) => {
      const row = index + 6;
      sheet.getCell(row, 1).value = index + 1;
      sheet.getCell(row, 2).value = student.classNum;
      sheet.getCell(row, 3).value = student.seatNum;
      sheet.getCell(row, 4).value = student.name;
    });
    classroom.dates.forEach((date, dateIndex) => {
      const column = dateIndex + 5;
      sheet.getCell(1, column).value = new Date(`${date.date}T00:00:00Z`);
      const attendance = classroom.students.filter(student => !date.observations.get(student.id)?.isAbsent).length;
      WorkbookGateway.setAttendanceFormula(sheet, column, classroom.students.length, attendance);
      sheet.getCell(3, column).value = date.lessonNo;
      WorkbookGateway.setProgressFormula(sheet, column, date.progress);
      sheet.getCell(5, column).value = date.journal;
      classroom.students.forEach((student, index) => {
        const observation = date.observations.get(student.id);
        sheet.getCell(index + 6, column).value = observation?.isAbsent ? '/' : (observation?.note || '');
      });
    });
    const templateColumn = classroom.dates.length + 5;
    const currentYear = new Date().getFullYear();
    sheet.getCell(1, templateColumn).value = new Date(Date.UTC(currentYear, 0, 1));
    const previousLesson = classroom.dates.at(-1)?.lessonNo || 0;
    const nextLesson = previousLesson + 1;
    WorkbookGateway.setAttendanceFormula(sheet, templateColumn, classroom.students.length, classroom.students.length);
    if (templateColumn === 5) sheet.getCell(3, templateColumn).value = nextLesson;
    else {
      const previousLetter = sheet.getColumn(templateColumn - 1).letter;
      sheet.getCell(3, templateColumn).value = { formula: `${previousLetter}3+1`, result: nextLesson };
    }
    WorkbookGateway.setProgressFormula(sheet, templateColumn, plans.find(plan => plan.lessonNo === nextLesson)?.progress || '');
    WorkbookGateway.formatClassroomSheet(sheet, templateColumn, classroom.students.length);
  }

  private static setAttendanceFormula(sheet: ExcelJS.Worksheet, column: number, studentCount: number, result: number) {
    const letter = sheet.getColumn(column).letter;
    const lastRow = Math.max(6, studentCount + 5);
    sheet.getCell(2, column).value = {
      formula: `COUNTA($A$6:$A$${lastRow})-COUNTIF(${letter}$6:${letter}$${lastRow},"/")`,
      result,
    };
  }

  private static setProgressFormula(sheet: ExcelJS.Worksheet, column: number, result: string) {
    const letter = sheet.getColumn(column).letter;
    sheet.getCell(4, column).value = {
      formula: `_xlfn.XLOOKUP(${letter}3,'진도'!$A:$A,'진도'!$B:$B,"")`,
      result,
    };
  }

  private static formatPlanSheet(sheet: ExcelJS.Worksheet) {
    sheet.properties.defaultRowHeight = 18;
    sheet.views = [{ state: 'frozen', ySplit: 1, topLeftCell: 'A2', activeCell: 'A2', showGridLines: true, zoomScale: 100, zoomScaleNormal: 100 }];
    [10.7109375, 30.7109375, 30.7109375, 30.7109375, 10.7109375, 10.7109375, 10.7109375]
      .forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
    sheet.eachRow(row => {
      row.height = 18;
      row.eachCell(cell => { cell.alignment = { vertical: 'middle', wrapText: true }; });
    });
    const headerFill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' }, bgColor: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).eachCell(cell => { cell.fill = headerFill; });
  }

  private static formatClassroomSheet(sheet: ExcelJS.Worksheet, lastColumn: number, studentCount: number) {
    sheet.properties.defaultRowHeight = 18;
    sheet.views = [{ state: 'frozen', xSplit: 4, ySplit: 5, topLeftCell: 'E6', activeCell: 'D6', showGridLines: true, zoomScale: 100, zoomScaleNormal: 100 }];
    sheet.pageSetup = {
      paperSize: 9, orientation: 'portrait', pageOrder: 'downThenOver', fitToWidth: 1, fitToHeight: 1,
      margins: { left: 0.7, right: 0.7, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 },
    };
    [5.140625, 5.140625, 5.140625, 7.7109375].forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
    for (let column = 5; column <= lastColumn; column += 1) sheet.getColumn(column).width = 30.7109375;
    [19, 19, 19, 50, 50].forEach((height, index) => { sheet.getRow(index + 1).height = height; });
    for (let row = 6; row <= studentCount + 5; row += 1) sheet.getRow(row).height = 18;

    const font: Partial<ExcelJS.Font> = { name: '맑은 고딕', size: 12, family: 2, charset: 129 };
    const edge = { style: 'hair' as const, color: { argb: 'FF000000' } };
    const border: Partial<ExcelJS.Borders> = { left: edge, right: edge, top: edge, bottom: edge };
    const headerFill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' }, bgColor: { argb: 'FFFFFFFF' } };
    for (let row = 1; row <= studentCount + 5; row += 1) {
      for (let column = 1; column <= lastColumn; column += 1) {
        const cell = sheet.getCell(row, column);
        cell.font = font;
        cell.border = border;
        cell.alignment = { vertical: 'middle', wrapText: true };
        if (row <= 5) cell.fill = headerFill;
      }
    }
    for (let column = 5; column <= lastColumn; column += 1) sheet.getCell(1, column).numFmt = 'm"월" d"일"';
  }
}

/** @deprecated 새 코드는 WorkbookGateway를 사용한다. */
export { WorkbookGateway as LessonPlanWorkbookReader };
