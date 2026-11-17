export const RECORDS_GUIDE_KEY = 'hideRecordsGuide.v2';
export const RECORDS_TREE_COLLAPSED_KEY = 'recordsTreeCollapsed';
export const RECORDS_TREE_OPEN_STATES_KEY = 'recordsTreeOpenStates';
export const RECORDS_LAST_CLASS_KEY = 'recordsPage_lastClassId';
export const ACTIVITY_TREE_COLLAPSED_KEY = 'activityTreeCollapsed';
export const ACTIVITY_TREE_OPEN_STATES_KEY = 'activityTreeOpenStates';
export const ACTIVITY_LAST_CLASS_KEY = 'activityPage_lastClassId';
export const RECORDS_VIEW_PREFS_PREFIX = 'recordsPage_viewPrefs';
export const SUBJECT_COMPREHENSIVE_DOMAIN = '__SUBJECT_COMPREHENSIVE__';

export const RECORDS_PAGE_TEXT = {
  sidebarTitle: '채점 기록 관리',
  uploadLabel: '파일 업로드',
  emptyTree: '수업이 없습니다',
  collapseTree: '트리 접기',
  expandTree: '트리 펼치기',
  guideSections: [
    {
      title: '1. 수행평가 채점 파일 업로드',
      lines: [
        '나이스 > 교과담임 > 성적 > 수행평가 > 수행평가성적관리에서',
        '조회 후 일괄파일업로드 > 엑셀다운로드를 선택하세요.',
      ],
    },
    {
      title: '2. 교과 세특 파일 업로드',
      lines: [
        '나이스 > 교과담임 > 성적 > 성적처리 > 과목별세부능력및특기사항에서',
        '조회 후 엑셀내려받기를 선택하세요.',
      ],
    },
  ],
} as const;
