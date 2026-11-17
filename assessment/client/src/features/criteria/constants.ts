export const CRITERIA_SELECTION_KEY = 'criteriaPage_lastSelection';
export const CRITERIA_TREE_OPEN_STATES_KEY = 'criteriaPage_treeOpenStates';
export const CRITERIA_GUIDE_KEY = 'hideCriteriaGuide.v2';
export const CRITERIA_SOURCE_TYPE = 'standards';

export const CRITERIA_TREE_KEY_PREFIXES = {
  year: 'y',
  semester: 's',
  grade: 'g',
  subject: 'sub',
  domain: 'dom',
} as const;

export const CRITERIA_PAGE_TEXT = {
  sidebarTitle: '성취 기준 관리',
  uploadLabel: '성취 기준 파일 업로드',
  guideTitle: '업로드 안내',
  guideLines: [
    '나이스 > 교과담임 > 성적 > 지필/수행선행작업 > 성취기준관리에서',
    '성취기준 및 성취수준(평가기준)을 조회 및 출력 후 파일 저장 버튼을 눌러 엑셀(XLS)를 선택하세요.',
  ],
  emptyTreeMessage: '성취 기준 파일을 업로드하세요',
} as const;

export const CRITERIA_TREE_TEXT = {
  deleteSubjectConfirm: (subject: string) => `${subject} 성취 기준 파일과 데이터를 삭제하시겠습니까?`,
  deleteScopeConfirm: (label: string) => `${label} 아래 성취 기준을 모두 삭제하시겠습니까?`,
  missingBuiltInStandards: '내장 성취 기준을 찾을 수 없습니다.',
} as const;

export const CRITERIA_UPLOAD_TEXT = {
  conflictConfirm: (data: { year: number; semester: number; grade: number; subject: string }) =>
    `${data.year}학년도 ${data.semester}학기 ${data.grade}학년 ${data.subject}의 데이터가 이미 있습니다. 덮어씌우시겠습니까?\n(기존의 성취기준 및 영역 데이터가 모두 삭제됩니다)`,
  successMessage: (data: { year: number; semester: number; grade: number; subject: string; credit: number | string; standardsCount: number }) =>
    `${data.year}학년도 ${data.semester}학기 ${data.grade}학년 ${data.subject}(${data.credit}): 성취 기준 ${data.standardsCount}개 업로드`,
} as const;
