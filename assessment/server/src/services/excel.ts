import ExcelJS from 'exceljs';
import path from 'path';

// ────────────────────────────────────────────────────────────────────────────
// 수업 관리: 채점 파일 파싱
// ────────────────────────────────────────────────────────────────────────────

export interface ClassInfo {
  year: number;       // 2026
  semester: number;   // 1
  grade: number;      // 2 (학년)
  subject: string;    // 정보
  room: string;       // 1강의실
}

export interface CommentsFileInfo extends ClassInfo {
  timestamp: string;
}

export interface WrittenExamInfo extends ClassInfo {
  examName: string;
  credit: number;
  maxScore: number;
}

export interface WrittenExamStudent {
  studentNum: number;
  name: string;
  score: string;
  excelRow: number;
}

export interface AssessmentDomain {
  name: string;
  maxScore: number;
  excelCol: string;   // E, F, G ...
  sortOrder: number;
}

export interface ClassStudent {
  studentNum: number;
  name: string;
  excelRow: number;
}

export interface ScoringFileData {
  classInfo: ClassInfo;
  domains: AssessmentDomain[];
  students: ClassStudent[];
}

/**
 * 파일명에서 수업 정보를 파싱합니다.
 * 형식: "수행평가 파일일괄등록 - 2026학년도 1학기 2 정보(3)_전체영역_1강의실.xlsx"
 *
 * macOS(HFS+/APFS)는 파일명을 NFD(분해 형식)로 저장합니다.
 * 브라우저 업로드 시 originalname이 NFD로 전달되므로 NFC로 정규화한 뒤 파싱합니다.
 */
export function parseClassFilename(filename: string): ClassInfo | null {
  // NFD → NFC 정규화 (macOS 파일명 대응)
  const normalized = filename.normalize('NFC');
  // 확장자 및 경로 제거
  const base = path.basename(normalized, path.extname(normalized));

  // 주 패턴: {year}학년도 {semester}학기 {grade} {subject}({n})_전체영역_{room}
  const match = base.match(
    /(\d{4})학년도\s+(\d+)학기\s+(\d+)\s+(.+?)\(\d+\)_전체영역_(.+)/
  );
  if (match) {
    return {
      year: parseInt(match[1], 10),
      semester: parseInt(match[2], 10),
      grade: parseInt(match[3], 10),
      subject: match[4].trim(),
      room: match[5].trim(),
    };
  }

  // 느슨한 패턴: {year}학년도 {semester}학기 ... {grade}학년 {subject} {room}
  const loose = base.match(/(\d{4})학년도\s+(\d+)학기/);
  if (loose) {
    return {
      year: parseInt(loose[1], 10),
      semester: parseInt(loose[2], 10),
      grade: 0,
      subject: base,
      room: '',
    };
  }

  return null;
}

export function parseCommentsFilename(filename: string): CommentsFileInfo | null {
  const normalized = filename.normalize('NFC');
  const base = path.basename(normalized, path.extname(normalized));
  const match = base.match(/(\d{4})_(\d+)학기_(\d+)학년_(.+?)_(.+?)_과목세특_(\d+)/);
  if (!match) return null;
  const room = match[6].length <= 2 ? match[6] : match[4].trim();
  return {
    year: parseInt(match[1], 10),
    semester: parseInt(match[2], 10),
    grade: parseInt(match[3], 10),
    room: /^\d+$/.test(room) ? `${room}강의실` : room,
    subject: match[5].trim(),
    timestamp: match[6],
  };
}

export interface SubjectDomainInfo {
  year: number;
  semester: number;
  grade: number;
  subject: string;
  credit: number;
}

export interface SubjectDomainRow {
  evalType: string;
  name: string;
  reflected: string;
  ratio: number;
  maxScore: number;
  sortOrder: number;
}

export interface AreaManagementData {
  info: SubjectDomainInfo;
  rows: SubjectDomainRow[];
}

export interface AchievementStandardRow {
  domainName: string;
  code: string;
  content: string;
  level: string;
  description: string;
  sortOrder: number;
}

export interface AchievementStandardsData {
  info: SubjectDomainInfo;
  rows: AchievementStandardRow[];
}

/**
 * 채점 Excel 파일에서 수행평가 영역, 만점, 학생 명단을 추출합니다.
 *
 * Excel 구조:
 *   Row 1 (E1~): 수행평가 영역명
 *   Row 2 (E2~): 만점(예: "만점(20)" 또는 "20")
 *   Row 3:       보조 헤더 (번호 | 반 | 번호 | 이름 ...)
 *   Row 4+:      학생 데이터
 */
export async function parseScoringExcel(filePath: string): Promise<{
  domains: AssessmentDomain[];
  students: ClassStudent[];
}> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);

  const sheet = wb.worksheets[0];
  if (!sheet) throw new Error('엑셀 파일에 시트가 없습니다.');

  // ── 영역명 / 만점 추출 (E 열 = 5 이상) ──────────────────────────────────
  const DOMAIN_START_COL = 5; // E열
  const domains: AssessmentDomain[] = [];

  const row1 = sheet.getRow(1);
  const row2 = sheet.getRow(2);

  for (let colIdx = DOMAIN_START_COL; ; colIdx++) {
    const nameCell = row1.getCell(colIdx);
    const scoreCell = row2.getCell(colIdx);

    const name = String(nameCell.value ?? '').trim();
    if (!name) break; // 빈 셀이면 영역 끝

    const scoreRaw = String(scoreCell.value ?? '').trim();
    // "만점(20)", "20점", "20" 등에서 숫자 추출
    const scoreMatch = scoreRaw.match(/(\d+)/);
    const maxScore = scoreMatch ? parseInt(scoreMatch[1], 10) : 0;

    // 열 번호 → 열 문자 변환 (5→E, 6→F ...)
    const excelCol = colIdxToLetter(colIdx);

    domains.push({ name, maxScore, excelCol, sortOrder: colIdx - DOMAIN_START_COL });
  }

  // ── 학생 명단 추출 (4행~) ──────────────────────────────────────────────
  // 헤더 행 탐지: row 3에서 이름/반/번호 컬럼 위치 파악
  let nameCol = 0;
  let numCol = 0;
  let classCol = 0;

  const row3 = sheet.getRow(3);
  row3.eachCell((cell, colIdx) => {
    const val = String(cell.value ?? '').trim();
    if (['이름', '성명'].includes(val)) nameCol = colIdx;
    if (['번', '번호', '출석번호'].includes(val) && numCol === 0) numCol = colIdx;
    if (['반', '학반', '학년반'].includes(val)) classCol = colIdx;
  });

  // row1에서도 검색 (헤더가 1행에 있는 경우 대비)
  if (!nameCol) {
    row1.eachCell((cell, colIdx) => {
      if (colIdx >= DOMAIN_START_COL) return;
      const val = String(cell.value ?? '').trim();
      if (['이름', '성명'].includes(val)) nameCol = colIdx;
      if (['번', '번호', '출석번호'].includes(val) && numCol === 0) numCol = colIdx;
      if (['반', '학반', '학년반'].includes(val)) classCol = colIdx;
    });
  }

  // 못 찾으면 기본값: A=순번, B=반, C=번호, D=이름
  if (!nameCol) nameCol = 4; // D
  if (!numCol) numCol = 3; // C
  if (!classCol) classCol = 2; // B

  const students: ClassStudent[] = [];

  sheet.eachRow((row, rowIdx) => {
    if (rowIdx < 4) return; // 헤더 행 스킵

    const nameCell = row.getCell(nameCol);
    const numCell = row.getCell(numCol);
    const classCell = row.getCell(classCol);

    const name = cleanStudentName(String(nameCell.value ?? '').trim());
    if (!name || !isKoreanName(name)) return; // 빈 행 / 비이름 행 스킵

    const classNum = parseInt(String(classCell.value ?? '0'), 10) || 0;
    const num = parseInt(String(numCell.value ?? '0').replace(/\D/g, ''), 10) || 0;
    // classNum * 100 + num 형식으로 저장 (학년 prefix는 classes.ts에서 추가)
    const studentNum = classNum * 100 + num;

    students.push({ studentNum, name, excelRow: rowIdx });
  });

  return { domains, students };
}

export async function parseAreaManagementExcel(filePath: string): Promise<AreaManagementData> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const sheet = wb.worksheets[0];
  if (!sheet) throw new Error('엑셀 파일에 시트가 없습니다.');

  let headerRowIdx = 0;
  const titleText = cellText(sheet.getCell('C3').value);
  const contextText = cellText(sheet.getCell('B5').value);

  if (!titleText.includes('반영비율/만점')) throw new Error('C3 셀에서 반영비율/만점 제목을 찾을 수 없습니다.');
  if (!contextText.includes('학년도') || !contextText.includes('학기') || !contextText.includes('학년')) {
    throw new Error('B5 셀에서 학년도/학기/학년 정보를 찾을 수 없습니다.');
  }

  for (let r = 1; r <= Math.min(sheet.rowCount, 30); r++) {
    const row = sheet.getRow(r);
    if (!headerRowIdx && rowTexts(row).some((text) => text.includes('평가구분'))) headerRowIdx = r;
  }

  if (!headerRowIdx) throw new Error('영역 관리 헤더 행을 찾을 수 없습니다.');

  const header = sheet.getRow(headerRowIdx);
  const subjectCol = findHeaderCol(header, '과목명');
  const evalTypeCol = findHeaderCol(header, '평가구분');
  const nameCol = findHeaderCol(header, '고사/영역명');
  const reflectedCol = findHeaderCol(header, '학기말 반영여부');
  const ratioCol = findHeaderCol(header, '반영비율');
  const maxScoreCol = findHeaderCol(header, '과목/영역 만점');

  if (!subjectCol || !evalTypeCol || !nameCol || !reflectedCol || !ratioCol || !maxScoreCol) {
    throw new Error('영역 관리 필수 컬럼을 찾을 수 없습니다.');
  }

  const rows: SubjectDomainRow[] = [];
  let subjectCreditText = '';
  for (let r = headerRowIdx + 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const evalType = cellText(row.getCell(evalTypeCol).value);
    const name = cellText(row.getCell(nameCol).value);
    if (!name || name.includes('합 계')) continue;
    if (!subjectCreditText) subjectCreditText = cellText(row.getCell(subjectCol).value);

    rows.push({
      evalType: evalType === '정기시험' ? '지필' : evalType === '수행평가' ? '수행' : evalType,
      name,
      reflected: cellText(row.getCell(reflectedCol).value),
      ratio: numericCell(row.getCell(ratioCol).value),
      maxScore: numericCell(row.getCell(maxScoreCol).value),
      sortOrder: rows.length,
    });
  }

  const info = parseSubjectContext(contextText, subjectCreditText);
  return { info, rows };
}

export async function parseAchievementStandardsExcel(filePath: string): Promise<AchievementStandardsData> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const sheet = wb.worksheets[0];
  if (!sheet) throw new Error('엑셀 파일에 시트가 없습니다.');

  let headerRowIdx = 0;
  const titleText = cellText(sheet.getCell('C4').value);
  const contextText = cellText(sheet.getCell('B6').value);

  if (!titleText.includes('성취평가기준 조회')) throw new Error('C4 셀에서 성취평가기준 조회 제목을 찾을 수 없습니다.');
  if (!contextText.includes('학년도') || !contextText.includes('학기')) {
    throw new Error('B6 셀에서 학년도/학기/학년/과목 정보를 찾을 수 없습니다.');
  }

  for (let r = 1; r <= Math.min(sheet.rowCount, 40); r++) {
    const row = sheet.getRow(r);
    const texts = rowTexts(row);
    if (!headerRowIdx && texts.some((text) => text.includes('성취기준')) && texts.some((text) => text.includes('성취수준') || text.includes('평가기준'))) {
      headerRowIdx = r;
    }
  }

  if (!headerRowIdx) throw new Error('성취 기준 헤더 행을 찾을 수 없습니다.');

  const info = parseSubjectContext(contextText, '');
  const header = sheet.getRow(headerRowIdx);
  const domainCol = findHeaderCol(header, '영역명') || 2;
  const standardCol = findHeaderCol(header, '성취기준') || 3;
  const levelCol = findHeaderCol(header, '성취수준') || findHeaderCol(header, '평가기준') || 7;
  const descCol = Math.max(levelCol + 2, 9);

  // Returns true if the raw cell value ends with whitespace (before trim).
  // Used to restore a space that cellText() trims away at print-page split boundaries.
  const rawEndsWithSpace = (value: unknown): boolean => {
    let s = '';
    if (value == null) return false;
    if (typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      if (typeof obj.text === 'string') s = obj.text;
      else if (Array.isArray(obj.richText)) s = (obj.richText as { text?: string }[]).map(p => p.text || '').join('');
      else if (obj.result != null) s = String(obj.result);
      else return false;
    } else {
      s = String(value);
    }
    return /\s$/.test(s);
  };

  const rows: AchievementStandardRow[] = [];
  let pendingRow: AchievementStandardRow | null = null;
  let pendingStdEndsSpace = false;
  let pendingDescEndsSpace = false;

  for (let r = headerRowIdx + 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const domainName = cellText(row.getCell(domainCol).value);
    const standardRaw = cellText(row.getCell(standardCol).value);
    const level = cellText(row.getCell(levelCol).value);
    const description = cellText(row.getCell(descCol).value);

    // Skip fully empty rows
    if (!domainName && !standardRaw && !level && !description) continue;
    // Skip repeated print-layout header rows (page break re-print of column titles)
    if (domainName === '영역명' || standardRaw === '성취기준') continue;
    // Skip rows with only numeric/garbage in level col (page number artifacts)
    if (!domainName && !standardRaw && level && /^\d+$/.test(level)) continue;

    // Continuation row: standard content does not start with '[code]' pattern.
    // This happens at print page boundaries where content spills to the next page.
    // Use the space flag to restore the space that cellText() trimmed away.
    if (standardRaw && !standardRaw.startsWith('[') && pendingRow) {
      pendingRow.content += (pendingStdEndsSpace ? ' ' : '') + standardRaw;
      pendingStdEndsSpace = rawEndsWithSpace(row.getCell(standardCol).value);
      if (description) {
        pendingRow.description += (pendingDescEndsSpace ? ' ' : '') + description;
        pendingDescEndsSpace = rawEndsWithSpace(row.getCell(descCol).value);
      }
      continue;
    }

    // Normal row: requires domain, standard with code, level, description
    if (!domainName || !standardRaw || !level || !description) continue;

    const codeMatch = standardRaw.match(/\[([^\]]+)\]/);
    const newRow: AchievementStandardRow = {
      domainName,
      code: codeMatch ? `[${codeMatch[1]}]` : '',
      content: standardRaw,
      level,
      description,
      sortOrder: rows.length,
    };
    rows.push(newRow);
    pendingRow = newRow;
    pendingStdEndsSpace = rawEndsWithSpace(row.getCell(standardCol).value);
    pendingDescEndsSpace = rawEndsWithSpace(row.getCell(descCol).value);
  }

  return { info, rows };
}

/**
 * 이름에서 부가 정보 제거: "홍길동 [학교간공동교육과정]", "홍길동(전학)" 등 → "홍길동"
 */
export function cleanStudentName(str: string): string {
  return str.replace(/[\s]*[\[\(][^\]\)]*[\]\)]/g, '').trim();
}

/** 숫자가 포함되지 않은 한글 문자열이면 이름으로 판단 */
function isKoreanName(str: string): boolean {
  return /^[가-힣\s]{2,10}$/.test(str);
}

function cellText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.text === 'string') return obj.text.trim();
    if (Array.isArray(obj.richText)) return obj.richText.map((part) => String((part as { text?: string }).text || '')).join('').trim();
    if (obj.result != null) return String(obj.result).trim();
  }
  return String(value).replace(/\s+/g, ' ').trim();
}

function rowTexts(row: ExcelJS.Row): string[] {
  const texts: string[] = [];
  row.eachCell((cell) => texts.push(cellText(cell.value)));
  return texts;
}

function findHeaderCol(row: ExcelJS.Row, pattern: string): number {
  let found = 0;
  row.eachCell((cell, colIdx) => {
    if (!found && cellText(cell.value).includes(pattern)) found = colIdx;
  });
  return found;
}

function numericCell(value: unknown): number {
  if (typeof value === 'number') return value;
  const match = cellText(value).match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

function parseSubjectContext(contextText: string, subjectCreditText: string): SubjectDomainInfo {
  const context = `${contextText} ${subjectCreditText}`.normalize('NFC');
  const year = Number(context.match(/(\d{4})학년도/)?.[1] || 0);
  const semester = Number(context.match(/(\d+)학기/)?.[1] || 0);
  const grade = Number(context.match(/(?:^|[^\d])(\d+)학년(?!도)/)?.[1] || context.match(/학기\s+\S+\s+(\d+)\s+/)?.[1] || 0);

  const subjectMatch = subjectCreditText.match(/^(.+?)\s*\(\s*\d+(?:\.\d+)?\s*\)/)
    || context.match(/\d+학년\s+(.+?)\s*\(\s*\d+(?:\.\d+)?\s*\)/)
    || context.match(/(?:주간|야간)?\s*\d+\s+(.+?)\s*\(\s*\d+(?:\.\d+)?\s*\)/);
  const subject = (subjectMatch?.[1] || subjectCreditText.match(/^(.+?)\(\d+(?:\.\d+)?\)/)?.[1] || context.match(/\d+\s+(.+?)\(\d+(?:\.\d+)?\)/)?.[1] || '').trim();

  const creditMatch = subjectCreditText.match(/\(\s*(\d+(?:\.\d+)?)\s*\)/)
    || context.match(/\(\s*(\d+(?:\.\d+)?)\s*\)/);
  const credit = Number(creditMatch?.[1] || 0);

  if (!year || !semester || !grade || !subject) {
    throw new Error('학년도/학기/학년/과목 정보를 찾을 수 없습니다.');
  }
  return { year, semester, grade, subject, credit };
}

/** 1-based 열 인덱스 → 열 문자 (1→A, 5→E, 27→AA) */
function colIdxToLetter(idx: number): string {
  let s = '';
  while (idx > 0) {
    idx--;
    s = String.fromCharCode(65 + (idx % 26)) + s;
    idx = Math.floor(idx / 26);
  }
  return s;
}

export interface CommentsStudent {
  name: string;
  classNum: number;
  studentNum: number;
  personalNum: string; // 개인번호 (NEIS 내부 식별자)
  excelRow: number;
}

/**
 * 세특 Excel 파일에서 학생 목록(이름, 반/번호, 개인번호)을 추출합니다.
 * 헤더 행을 자동 탐지하며, 개인번호 열이 없으면 빈 문자열로 처리합니다.
 */
export async function parseCommentsExcel(filePath: string): Promise<CommentsStudent[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const sheet = wb.worksheets[0];
  if (!sheet) throw new Error('엑셀 파일에 시트가 없습니다.');

  let nameCol = 0, classCol = 0, numCol = 0, personalNumCol = 0;
  let combinedClassNumCol = 0; // "반/번호" 형식 (예: "1/1")
  let headerRow = 0;

  for (let r = 1; r <= Math.min(sheet.rowCount, 5); r++) {
    const row = sheet.getRow(r);
    let foundName = false;
    row.eachCell((cell, colIdx) => {
      const val = String(cell.value ?? '').trim();
      if (['이름', '성명'].includes(val) && !nameCol) { nameCol = colIdx; foundName = true; }
      if (['반', '학반', '학년반'].includes(val) && !classCol) classCol = colIdx;
      if (['번', '번호', '출석번호'].includes(val) && !numCol) numCol = colIdx;
      if (val === '반/번호' && !combinedClassNumCol) combinedClassNumCol = colIdx;
      if (['개인번호', '교원개인번호', '학생개인번호'].includes(val) && !personalNumCol) personalNumCol = colIdx;
    });
    if (foundName) { headerRow = r; break; }
  }

  if (!nameCol) { nameCol = 8; headerRow = 1; }
  // 개별 반/번호 컬럼이 없고 합산 컬럼도 없으면 기본값
  if (!classCol && !combinedClassNumCol) classCol = 2;
  if (!numCol && !combinedClassNumCol) numCol = 3;

  const students: CommentsStudent[] = [];
  sheet.eachRow((row, rowIdx) => {
    if (rowIdx <= headerRow) return;
    const name = cleanStudentName(String(row.getCell(nameCol).value ?? '').trim());
    if (!name || !isKoreanName(name)) return;

    let classNum = 0, num = 0;
    if (combinedClassNumCol) {
      // "반/번호" 형식: "1/1" → classNum=1, num=1
      const parts = String(row.getCell(combinedClassNumCol).value ?? '').trim().split('/');
      classNum = parseInt(parts[0], 10) || 0;
      num = parseInt(parts[1]?.replace(/\D/g, '') ?? '0', 10) || 0;
    } else {
      classNum = parseInt(String(row.getCell(classCol).value ?? '0'), 10) || 0;
      num = parseInt(String(row.getCell(numCol).value ?? '0').replace(/\D/g, ''), 10) || 0;
    }

    const personalNum = personalNumCol ? String(row.getCell(personalNumCol).value ?? '').trim() : '';
    students.push({ name, classNum, studentNum: classNum * 100 + num, personalNum, excelRow: rowIdx });
  });

  return students;
}

export async function parseWrittenExamExcel(filePath: string): Promise<{
  info: WrittenExamInfo;
  students: WrittenExamStudent[];
}> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const sheet = wb.worksheets[0];
  if (!sheet) throw new Error('엑셀 파일에 시트가 없습니다.');

  const contextText = cellText(sheet.getCell('B6').value);
  const examText = cellText(sheet.getCell('B7').value);
  const maxScoreText = cellText(sheet.getCell('B8').value);

  const year = Number(contextText.match(/(\d{4})학년도/)?.[1] || 0);
  const semester = Number(contextText.match(/(\d+)학기/)?.[1] || 0);
  const grade = Number(contextText.match(/(?:^|[^\d])(\d+)학년(?!도)/)?.[1] || 0);
  const room = (contextText.match(/(\S*?\d+강의실)/)?.[1] || '').trim();
  const examName = (examText.match(/고사\s*:\s*(.*?)\s+교과목\s*:/)?.[1] || '').trim();
  const subjectRaw = (examText.match(/교과목\s*:\s*(.+)$/)?.[1] || '').trim();
  const subjectCreditMatch = subjectRaw.match(/(?:^|:)([^:()]+)\((\d+(?:\.\d+)?)\)\s*$/);
  const subject = (subjectCreditMatch?.[1] || '').trim();
  const credit = Number(subjectCreditMatch?.[2] || 0);
  const maxScore = Number(maxScoreText.match(/(\d+(?:\.\d+)?)/)?.[1] || 0);

  if (!year || !semester || !grade || !room) throw new Error('B6 셀에서 학년도/학기/학년/강의실 정보를 찾을 수 없습니다.');
  if (!examName || !subject || !credit) throw new Error('B7 셀에서 고사명/교과목/학점 정보를 찾을 수 없습니다.');

  let headerRowIdx = 0;
  let classNumCol = 0;
  let nameCol = 0;
  let scoreCol = 0;
  for (let r = 1; r <= Math.min(sheet.rowCount, 20); r++) {
    const row = sheet.getRow(r);
    row.eachCell((cell, colIdx) => {
      const text = cellText(cell.value);
      if (!classNumCol && text === '반/번호') classNumCol = colIdx;
      if (!nameCol && ['성명', '이름'].includes(text)) nameCol = colIdx;
      if (!scoreCol && text === '점수') scoreCol = colIdx;
    });
    if (classNumCol && nameCol && scoreCol) {
      headerRowIdx = r;
      break;
    }
  }
  if (!headerRowIdx || !classNumCol || !nameCol || !scoreCol) {
    throw new Error('지필 평가 헤더(반/번호, 성명, 점수)를 찾을 수 없습니다.');
  }

  const students: WrittenExamStudent[] = [];
  sheet.eachRow((row, rowIdx) => {
    if (rowIdx <= headerRowIdx) return;
    const classNumText = cellText(row.getCell(classNumCol).value);
    const name = cleanStudentName(cellText(row.getCell(nameCol).value));
    if (!classNumText || !name || !isKoreanName(name)) return;
    const match = classNumText.match(/(\d+)\s*\/\s*(\d+)/);
    if (!match) return;
    const classNum = Number(match[1]) || 0;
    const num = Number(match[2]) || 0;
    const score = cellText(row.getCell(scoreCol).value);
    students.push({ studentNum: classNum * 100 + num, name, score, excelRow: rowIdx });
  });

  return {
    info: { year, semester, grade, subject, room, examName, credit, maxScore },
    students,
  };
}

export interface StudentRow {
  name: string;
  classNum: number;
  studentNum: number;
  excelRow: number;
  [key: string]: unknown;
}

/**
 * 엑셀 파일에서 학생 정보를 추출합니다.
 * 컬럼 구조: A=번호, B=반, C=번호, D=이름 (또는 헤더 자동 감지)
 */
export async function parseStudentExcel(filePath: string): Promise<StudentRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);

  const sheet = wb.worksheets[0];
  if (!sheet) throw new Error('엑셀 파일에 시트가 없습니다.');

  const students: StudentRow[] = [];

  // 헤더 행 찾기 (이름 컬럼 포함 여부로 판단)
  let headerRow = 1;
  let nameCol = 0;
  let classCol = 0;
  let numCol = 0;

  const firstRow = sheet.getRow(1);
  firstRow.eachCell((cell, colIdx) => {
    const val = String(cell.value || '').trim();
    if (['이름', '성명'].includes(val)) nameCol = colIdx;
    if (['반', '학반', '학년반'].includes(val)) classCol = colIdx;
    if (['번', '번호', '학번', '출석번호'].includes(val)) numCol = colIdx;
  });

  // 헤더가 없으면 기본 컬럼 구조 사용: A=행번, B=반, C=번호, D=이름
  if (!nameCol) {
    headerRow = 0;
    classCol = 2;
    numCol = 3;
    nameCol = 4;
  }

  sheet.eachRow((row, rowIdx) => {
    if (rowIdx <= headerRow) return;
    const nameCell = row.getCell(nameCol);
    const classCell = row.getCell(classCol);
    const numCell = row.getCell(numCol);

    const name = String(nameCell.value || '').trim();
    if (!name) return;

    const classNum = parseInt(String(classCell.value || '0'), 10) || 0;
    const studentNum = parseInt(String(numCell.value || '0'), 10) || 0;

    // 추가 데이터 컬럼도 수집
    const extra: Record<string, unknown> = {};
    row.eachCell((cell, colIdx) => {
      if (colIdx !== nameCol && colIdx !== classCol && colIdx !== numCol) {
        const header = sheet.getRow(headerRow).getCell(colIdx).value;
        const key = header ? String(header) : `col_${colIdx}`;
        extra[key] = cell.value;
      }
    });

    students.push({ name, classNum, studentNum, excelRow: rowIdx, ...extra });
  });

  return students;
}

/**
 * 원본 채점 Excel 파일에 영역별 합계 점수를 기록합니다.
 * @param filePath  원본 파일 경로
 * @param entries   [{ excelRow, excelCol, score }]  excelCol: 'E', 'F', ...
 * @returns         수정된 파일의 Buffer
 */
export async function writeScoringToExcel(
  filePath: string,
  entries: { excelRow: number; excelCol: string; score: number | null }[]
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);

  const sheet = wb.worksheets[0];
  if (!sheet) throw new Error('엑셀 파일에 시트가 없습니다.');

  for (const { excelRow, excelCol, score } of entries) {
    if (!excelCol || excelRow == null) continue;
    const cell = sheet.getCell(`${excelCol}${excelRow}`);
    cell.value = score ?? '';
  }

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/**
 * 원본 세특 Excel 파일에 종합 세특 내용을 기록합니다.
 * 세특 파일 구조: Row 1 = 헤더, Row 2+ = 학생 데이터
 *   C4(col4) = 학생개인번호, C10(col10) = 세부능력 및 특기사항
 * @param filePath      원본 파일 경로
 * @param entries       [{ personalNum, commentsText }]
 * @returns             수정된 파일의 Buffer
 */
export async function writeCommentsToExcel(
  filePath: string,
  entries: { personalNum: string; commentsText: string }[]
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);

  const sheet = wb.worksheets[0];
  if (!sheet) throw new Error('엑셀 파일에 시트가 없습니다.');

  const PERSONAL_NUM_COL = 4;  // D열 = 학생개인번호
  const COMMENTS_COL = 10;       // J열 = 세부능력 및 특기사항

  const personalNumMap = new Map(entries.map(e => [e.personalNum, e.commentsText]));

  sheet.eachRow((row, rowIdx) => {
    if (rowIdx === 1) return; // 헤더 스킵
    const pNum = String(row.getCell(PERSONAL_NUM_COL).value ?? '').trim();
    if (!pNum) return;
    const text = personalNumMap.get(pNum);
    if (text !== undefined) {
      row.getCell(COMMENTS_COL).value = text;
    }
  });

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/**
 * 채점/세특 결과를 엑셀로 내보냅니다.
 */
export async function exportToExcel(data: {
  students: StudentRow[];
  headers: string[];
  rows: (string | number | null)[][];
  sheetName?: string;
}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet(data.sheetName || '결과');

  // 헤더
  const headerRow = sheet.addRow(data.headers);
  headerRow.font = { bold: true };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFD9E1F2' },
  };

  // 열 너비 자동 설정
  data.headers.forEach((h, i) => {
    const col = sheet.getColumn(i + 1);
    col.width = Math.max(12, h.length * 2 + 4);
    if (i >= 3) {
      col.width = 40; // 텍스트 컬럼
      col.alignment = { wrapText: true, vertical: 'top' };
    }
  });

  // 데이터 행
  for (const row of data.rows) {
    const r = sheet.addRow(row);
    r.alignment = { vertical: 'top', wrapText: true };
  }

  // freeze 헤더
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
