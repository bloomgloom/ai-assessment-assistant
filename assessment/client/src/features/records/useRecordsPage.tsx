import { lazy, Suspense, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { recordsApi, criteriaApi, classesApi, aiApi, settingsApi, activityApi } from '../../lib/api';
import { useAiBatchStore } from '../../stores/aiBatchStore';
import { useRecordsUnsavedStore } from '../../stores/recordsUnsavedStore';
import { Loader2, PanelLeftClose, PanelLeftOpen, Trash2 } from 'lucide-react';
import { RECORDS_GUIDE_KEY, RECORDS_LAST_CLASS_KEY, RECORDS_PAGE_TEXT, RECORDS_VIEW_PREFS_PREFIX, SUBJECT_COMPREHENSIVE_DOMAIN } from './constants';
import { RecordsCollapsedTree } from './RecordsCollapsedTree';
import { ClassItem, ContentItem, EvalItem, RecordsTreeNode, ScoringContent, SpellcheckResult, Student, WrittenExam, WrittenExamScore } from './types';
import { useRecordsHeader } from './useRecordsHeader';
import { useAiEnabled } from '../../hooks/useAiEnabled';
import { useRecordsTree } from './useRecordsTree';
import { useRecordsUpload } from './useRecordsUpload';
import { saveBlob } from '../../lib/desktopFiles';
import { diffChars, type Change } from 'diff';
import { StableTextarea } from '../../components/common/StableTextarea';
import { BulkImportResultDialog } from '../../components/common/BulkImportResultDialog';
import { useResizableTable } from '../../components/common/useResizableTable';
import { RecordsFrozenHeader, RecordsFrozenStudentCells, recordsFrozenLayout } from '../../components/common/RecordsTableFrozenColumns';
import { ClaudeBatchResultsDialog, type ClaudeBatchResultJob } from '../../components/common/ClaudeBatchResultsDialog';

const ArtifactViewer = lazy(() => import('../../components/ArtifactViewer'));

const RECORD_TEXTAREA_MIN_HEIGHT = 80;

function getDomainColumnDefaultWidth(type: string) {
  if (type === 'comments' || type === 'comments_item') return 200;
  if (type === 'artifact') return 56;
  if (type === 'total') return 64;
  if (type === 'written') return 76;
  return 80;
}

function hasScoringCriteria(items: EvalItem[] | undefined) {
  return !!items?.some(item => item.item_type !== 'formula');
}

function normalizeRecordCriteriaTitles(items: any[]) {
  const recordItems = items.filter(item => item.type === '항목');
  const sourceItems = recordItems.length > 0 ? recordItems : [{ title: '기록' }];
  return sourceItems.map((item, idx) => ({
    title: String(item.title || '').trim() || (sourceItems.length === 1 ? '기록' : `기록 ${idx + 1}`),
  }));
}

function normalizeStoredValue(value: unknown): string {
  if (value == null) return '';
  return String(value);
}

function stableContentStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableContentStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableContentStringify((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? '');
}

function weightedScore(rawScore: unknown, maxScore: unknown, ratio: unknown): number {
  const score = Number(rawScore) || 0;
  const max = Number(maxScore) || 0;
  const weight = Number(ratio) || 0;
  if (!max || !weight) return 0;
  return score * weight / max;
}

function formatScore(value: number): string {
  if (!Number.isFinite(value) || value === 0) return '';
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, '');
}

function buildSpellcheckDiff(originalText: string, correctedText: string): Change[] {
  return diffChars(
    originalText.replace(/\r\n?/g, '\n').normalize('NFC'),
    correctedText.replace(/\r\n?/g, '\n').normalize('NFC')
  ).filter(part => !part.removed);
}

interface RecordsViewPrefs {
  showScoring?: boolean;
  showComments?: boolean;
  showComprehensive?: boolean;
  domainFilter?: string;
}

interface BulkZipUploadResultItem {
  path: string;
  status: 'uploaded' | 'unmatched' | 'conflict' | 'read_error';
  studentId?: number;
  student?: string;
  reason?: string;
}

interface BulkZipUploadResult {
  message: string;
  count: number;
  total: number;
  studentCount: number;
  unmatchedCount: number;
  conflictCount: number;
  errorCount: number;
  results: BulkZipUploadResultItem[];
  failed?: boolean;
}

function recordsViewPrefsKey(classItem: ClassItem) {
  return [
    RECORDS_VIEW_PREFS_PREFIX,
    classItem.year,
    classItem.semester,
    classItem.grade,
    classItem.subject,
  ].join(':');
}

function readRecordsViewPrefs(classItem: ClassItem): RecordsViewPrefs | null {
  try {
    const raw = localStorage.getItem(recordsViewPrefsKey(classItem));
    return raw ? JSON.parse(raw) as RecordsViewPrefs : null;
  } catch {
    return null;
  }
}

function writeRecordsViewPrefs(classItem: ClassItem, prefs: RecordsViewPrefs) {
  localStorage.setItem(recordsViewPrefsKey(classItem), JSON.stringify(prefs));
}

export function useRecordsPage() {
  const aiEnabled = useAiEnabled();
  const [llmProvider, setLlmProvider] = useState('');
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [subjects, setSubjects] = useState<any[]>([]);
  const [selectedClass, setSelectedClass] = useState<ClassItem | null>(null);
  const [selectedDomain, setSelectedDomain] = useState<string>('');

  const [students, setStudents] = useState<Student[]>([]);
  const [evalItems, setEvalItems] = useState<EvalItem[]>([]);

  const [contents, setContents] = useState<Record<string, any>>({});
  const [savedContents, setSavedContents] = useState<Record<string, any>>({});
  const [evalItemsMap, setEvalItemsMap] = useState<Record<string, EvalItem[]>>({});
  const [commentsItemsMap, setCommentsItemsMap] = useState<Record<string, Array<{ title: string }>>>({});
  const [writtenExams, setWrittenExams] = useState<WrittenExam[]>([]);
  const [writtenScores, setWrittenScores] = useState<Record<string, string>>({});
  const [savedWrittenScores, setSavedWrittenScores] = useState<Record<string, string>>({});
  const [activitySummaries, setActivitySummaries] = useState<Record<number, string>>({});

  const [saving, setSaving] = useState(false);
  const [uploadingZip, setUploadingZip] = useState(false);
  const [uploadingFullRecords, setUploadingFullRecords] = useState(false);
  const [artifactRefreshKey, setArtifactRefreshKey] = useState(0);
  const [spellcheckingIds, setSpellcheckingIds] = useState<Set<number>>(new Set());
  const [spellcheckDiffs, setSpellcheckDiffs] = useState<Record<number, Change[]>>({});
  const [focusedSpellcheckId, setFocusedSpellcheckId] = useState<number | null>(null);
  const [spellcheckProgress, setSpellcheckProgress] = useState<{ completed: number; total: number } | null>(null);
  const [spellcheckStopping, setSpellcheckStopping] = useState(false);
  const [showScoring, setShowScoring] = useState(true);
  const [showComments, setShowComments] = useState(true);
  const [showComprehensive, setShowComprehensive] = useState(true);
  const [domainFilter, setDomainFilter] = useState<string>('all');
  const [selectedStudentIds, setSelectedStudentIds] = useState<Set<number>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [showClaudeBatchDialog, setShowClaudeBatchDialog] = useState(false);
  const [receivingClaudeBatchId, setReceivingClaudeBatchId] = useState('');
  const [bulkZipResult, setBulkZipResult] = useState<BulkZipUploadResult | null>(null);

  const [showGuide, setShowGuide] = useState(() => localStorage.getItem(RECORDS_GUIDE_KEY) !== '1');
  const recordsTree = useRecordsTree(classes);
  const spellcheckAbortRef = useRef<AbortController | null>(null);
  const recordsRestoredRef = useRef(false);

  const fullRecordsInputRef = useRef<HTMLInputElement>(null);
  const spellcheckHighlightRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const {
    tableRef,
    columnWidths: colWidths,
    rowHeights: rowTextareaHeights,
    handleColumnResizeStart: handleResizeStart,
    renderCellResizeHandles,
    handleKeyNavigation: handleKeyNav,
  } = useResizableTable<number>({ defaultRowHeight: RECORD_TEXTAREA_MIN_HEIGHT });
  const aiBatchJob = useAiBatchStore(state => state.currentJob);
  const claudeBatchJobs = useAiBatchStore(state => state.claudeBatchJobs);
  const aiBatchUpdates = useAiBatchStore(state => state.updates);
  const startAiBatch = useAiBatchStore(state => state.startBatch);
  const loadClaudeBatchJobs = useAiBatchStore(state => state.loadClaudeBatchJobs);
  const startClaudeBatch = useAiBatchStore(state => state.startClaudeBatch);
  const startClaudeSpellcheckBatch = useAiBatchStore(state => state.startClaudeSpellcheckBatch);
  const checkClaudeBatchResults = useAiBatchStore(state => state.checkClaudeBatchResults);
  const isAiCellLocked = useAiBatchStore(state => state.isCellLocked);
  const hasLockedAiCells = useAiBatchStore(state => state.hasLockedCells);
  const setHasUnsavedRecords = useRecordsUnsavedStore(state => state.setHasUnsavedChanges);
  const appliedUpdateCountRef = useRef(0);
  const restoringViewPrefsRef = useRef(false);
  const batchGenerating = aiBatchJob?.status === 'running' || aiBatchJob?.status === 'stopping';
  const isDirty = useMemo(
    () => stableContentStringify(contents) !== stableContentStringify(savedContents)
      || stableContentStringify(writtenScores) !== stableContentStringify(savedWrittenScores),
    [contents, savedContents, writtenScores, savedWrittenScores]
  );
  useEffect(() => {
    let cancelled = false;
    settingsApi.get()
      .then((res) => {
        if (!cancelled) setLlmProvider(String(res.data?.provider || ''));
      })
      .catch(() => {
        if (!cancelled) setLlmProvider('');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const classClaudeBatchJobs = useMemo(
    () => selectedClass
      ? claudeBatchJobs
        .filter((job) => job.classId === selectedClass.id && String(job.contentType) !== 'activity')
        .sort((a, b) => a.startedAt - b.startedAt)
      : [],
    [claudeBatchJobs, selectedClass]
  );

  useEffect(() => {
    if (!selectedClass) return;
    void loadClaudeBatchJobs(selectedClass.id);
  }, [loadClaudeBatchJobs, selectedClass]);

  useEffect(() => {
    setHasUnsavedRecords(isDirty);
    return () => setHasUnsavedRecords(false);
  }, [isDirty, setHasUnsavedRecords]);

  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      if ((window as any).__allowNextUnload === true) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  const loadData = useCallback(async () => {
    const [cr, sr] = await Promise.all([classesApi.getAll(), criteriaApi.getSubjects()]);
    setClasses(cr.data);
    setSubjects(sr.data);
    return { classes: cr.data as ClassItem[], subjects: sr.data };
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const parseContent = (c: string) => {
    try {
      if (c.trim().startsWith('{')) return JSON.parse(c);
      return { text: c };
    } catch {
      return { text: c };
    }
  };

  const countTextBytes = (text: string) => new TextEncoder().encode(text).length + text.split('\n').length - 1;

  const refreshSpellcheckDiff = (studentId: number, originalText?: string, correctedText?: string) => {
    const source = originalText
      ?? String(contents[`${studentId}_comments_${SUBJECT_COMPREHENSIVE_DOMAIN}`]?.text || '');
    const result = correctedText
      ?? String(contents[`${studentId}_spellcheck_${SUBJECT_COMPREHENSIVE_DOMAIN}`]?.text || '');
    setSpellcheckDiffs(prev => ({
      ...prev,
      [studentId]: buildSpellcheckDiff(source, result),
    }));
  };

  const loadDomainData = useCallback(async (c: ClassItem) => {
    // Load students
    const str = await fetch(`/api/classes/${c.id}/students`);
    const sData = await str.json();
    sData.sort((a: Student, b: Student) => a.student_num - b.student_num);
    setStudents(sData);
    setSelectedStudentIds(new Set());

    const subj = subjects.find(s => s.year === c.year && s.semester === c.semester && s.grade === c.grade && s.subject === c.subject);
    if (!subj) return {
      evalItemsMap: {} as Record<string, EvalItem[]>,
      commentsItemsMap: {} as Record<string, Array<{ title: string }>>,
      writtenExams: [] as WrittenExam[],
    };

    // Load eval items for all fixed domains
    const eMap: Record<string, EvalItem[]> = {};
    for (const fd of subj.fixedDomains) {
      const er = await criteriaApi.getEval(c.year, c.semester, c.grade, c.subject, fd.name);
      eMap[fd.name] = er.data;
    }
    setEvalItemsMap(eMap);

    // Load comments activity items for all domains
    const siMap: Record<string, Array<{ title: string }>> = {};
    const allDoms = [...subj.fixedDomains, ...subj.customDomains];
    await Promise.all(allDoms.map(async (d: any) => {
      try {
        const sr = await criteriaApi.getComments(c.year, c.semester, c.grade, c.subject, d.name);
        siMap[d.name] = normalizeRecordCriteriaTitles(sr.data as any[]);
      } catch { siMap[d.name] = []; }
    }));
    setCommentsItemsMap(siMap);

    // Load all content
    const [cr, wr, ar] = await Promise.all([
      fetch(`/api/records/classes/${c.id}/content`),
      recordsApi.getWrittenExams(c.id),
      activityApi.getSemesterSummaries(c.id),
    ]);
    const cData = await cr.json() as ContentItem[];
    const map: Record<string, any> = {};
    for (const item of cData) {
      map[`${item.student_id}_${item.content_type}_${item.domain}`] = parseContent(item.content);
    }
    const writtenData = wr.data as { exams: WrittenExam[]; scores: WrittenExamScore[] };
    const writtenScoreMap: Record<string, string> = {};
    for (const item of writtenData.scores || []) {
      writtenScoreMap[`${item.student_id}_${item.domain_name}`] = item.score ?? '';
    }
    setWrittenExams(writtenData.exams || []);
    setWrittenScores(writtenScoreMap);
    setSavedWrittenScores(writtenScoreMap);
    setActivitySummaries(Object.fromEntries((ar.data || []).map((item: any) => [Number(item.student_id), String(item.summary || '')])));
    setContents(map);
    setSavedContents(map);
    setSpellcheckDiffs({});
    setFocusedSpellcheckId(null);
    return { evalItemsMap: eMap, commentsItemsMap: siMap, writtenExams: writtenData.exams || [] };
  }, [subjects]);

  const handleSelectClass = useCallback(async (c: ClassItem) => {
    if (isDirty && !confirm('저장되지 않은 변경 사항이 있습니다. 이동하시겠습니까?')) return;
    restoringViewPrefsRef.current = true;
    setSelectedClass(c);
    setSelectedDomain('');
    setDomainFilter('all');
    setShowScoring(false);
    setShowComments(false);
    setShowComprehensive(true);
    localStorage.setItem(RECORDS_LAST_CLASS_KEY, String(c.id));
    const loaded = await loadDomainData(c);
    const subj = subjects.find(s => s.year === c.year && s.semester === c.semester && s.grade === c.grade && s.subject === c.subject);
    const fixedDomains = subj?.fixedDomains || [];
    const allDomains = [...fixedDomains, ...(subj?.customDomains || [])];
    const defaultShowScoring = fixedDomains.some((d: any) => hasScoringCriteria(loaded.evalItemsMap[d.name]))
      || loaded.writtenExams.length > 0;
    const defaultShowComments = allDomains.some((d: any) => (loaded.commentsItemsMap[d.name] || []).length > 0);
    const savedPrefs = readRecordsViewPrefs(c);
    const restoredShowScoring = savedPrefs?.showScoring ?? defaultShowScoring;
    const restoredShowComments = savedPrefs?.showComments ?? defaultShowComments;
    const restoredShowComprehensive = savedPrefs?.showComprehensive ?? true;
    const allowedDomains = [
      ...fixedDomains,
      ...loaded.writtenExams.map((exam: WrittenExam) => ({ name: exam.domain_name })),
      ...(restoredShowComments ? (subj?.customDomains || []) : []),
    ].map((d: any) => d.name);
    const restoredDomain = savedPrefs?.domainFilter && (savedPrefs.domainFilter === 'all' || allowedDomains.includes(savedPrefs.domainFilter))
      ? savedPrefs.domainFilter
      : 'all';
    const finalShowScoring = defaultShowScoring ? restoredShowScoring : false;
    const finalShowComments = defaultShowComments ? restoredShowComments : false;
    const finalShowComprehensive = !finalShowScoring && !finalShowComments && !restoredShowComprehensive
      ? true
      : restoredShowComprehensive;
    setDomainFilter(restoredDomain);
    setShowScoring(finalShowScoring);
    setShowComments(finalShowComments);
    setShowComprehensive(finalShowComprehensive);
    window.setTimeout(() => {
      restoringViewPrefsRef.current = false;
      writeRecordsViewPrefs(c, {
        showScoring: finalShowScoring,
        showComments: finalShowComments,
        showComprehensive: finalShowComprehensive,
        domainFilter: restoredDomain,
      });
    }, 0);
  }, [isDirty, loadDomainData, subjects]);

  // 마지막 선택 강의실 복원
  useEffect(() => {
    if (recordsRestoredRef.current || classes.length === 0 || subjects.length === 0) return;
    recordsRestoredRef.current = true;
    const savedId = localStorage.getItem(RECORDS_LAST_CLASS_KEY);
    if (!savedId) return;
    const cls = classes.find(c => c.id === Number(savedId));
    if (cls) handleSelectClass(cls);
  }, [classes, subjects, handleSelectClass]);

  const hideGuide = () => {
    localStorage.setItem(RECORDS_GUIDE_KEY, '1');
    setShowGuide(false);
  };

  const recordsUpload = useRecordsUpload({
    selectedClass,
    setClasses,
    setSelectedClass,
    setStudents,
    setContents,
    setSavedContents,
    onSelectClass: handleSelectClass,
  });

  const handleDeleteClass = useCallback(async (c: ClassItem) => {
    const label = `${c.year}학년도 ${c.semester}학기 ${c.grade}학년 ${c.subject} ${c.room}`;
    if (!confirm(`"${label}" 강의실을 삭제하시겠습니까?\n채점 파일과 세특 파일도 함께 삭제됩니다.`)) return;
    try {
      await classesApi.delete(c.id);
      if (selectedClass?.id === c.id) {
        setSelectedClass(null);
        setStudents([]);
        setContents({});
        setSavedContents({});
        setWrittenExams([]);
        setWrittenScores({});
        setSavedWrittenScores({});
      }
      await loadData();
    } catch (err: any) {
      alert(err?.response?.data?.error || '삭제 중 오류가 발생했습니다.');
    }
  }, [selectedClass, loadData]);

  const handleDeleteScoring = useCallback(async (c: ClassItem) => {
    const label = `${c.year}학년도 ${c.semester}학기 ${c.grade}학년 ${c.subject} ${c.room}`;
    if (!confirm(`"${label}" 채점 파일을 삭제하시겠습니까?\n수업 데이터와 세특 파일은 유지됩니다.`)) return;
    try {
      await classesApi.deleteScoring(c.id);
      if (selectedClass?.id === c.id) {
        setSelectedClass(prev => prev ? { ...prev, scoring_filename: '' } : prev);
        setShowScoring(false);
        setShowComments(!!selectedClass.comments_filename);
        setShowComprehensive(!!selectedClass.comments_filename);
      }
      await loadData();
    } catch (err: any) {
      alert(err?.response?.data?.error || '채점 파일 삭제 중 오류가 발생했습니다.');
    }
  }, [selectedClass, loadData]);

  const handleDeleteComments = useCallback(async (c: ClassItem) => {
    const label = `${c.year}학년도 ${c.semester}학기 ${c.grade}학년 ${c.subject} ${c.room}`;
    if (!confirm(`"${label}" 세특 파일을 삭제하시겠습니까?\n학생 개인번호도 초기화됩니다.`)) return;
    try {
      await classesApi.deleteComments(c.id);
      if (selectedClass?.id === c.id) {
        setSelectedClass(prev => prev ? { ...prev, comments_filename: '' } : prev);
        setShowComments(false);
        setShowComprehensive(false);
        setShowScoring(!!selectedClass.scoring_filename);
      }
      await loadData();
    } catch (err: any) {
      alert(err?.response?.data?.error || '세특 파일 삭제 중 오류가 발생했습니다.');
    }
  }, [selectedClass, loadData]);

  const handleSelectDomain = useCallback(async (c: ClassItem, d: string) => {
    // Legacy support if needed, but tree no longer calls this.
  }, []);

  const handleDeleteWrittenExam = useCallback(async (domainName: string) => {
    if (!selectedClass) return;
    if (!confirm(`"${domainName}" 지필 평가 파일을 삭제하시겠습니까?\n기존 점수는 유지되고 수동 수정 가능 상태로 바뀝니다.`)) return;
    try {
      await classesApi.deleteWrittenExam(selectedClass.id, domainName);
      await loadDomainData(selectedClass);
    } catch (err: any) {
      alert(err?.response?.data?.error || '지필 평가 파일 삭제 중 오류가 발생했습니다.');
    }
  }, [selectedClass, loadDomainData]);

  const updateContent = (studentId: number, type: 'scoring' | 'comments' | 'spellcheck', field: string, value: string, explicitDomain?: string) => {
    setContents(prev => {
      const targetDomain = explicitDomain || selectedDomain;
      const key = `${studentId}_${type}_${targetDomain}`;
      const obj = prev[key] || {};

      const newObj = { ...obj, [field]: value };
      if (type === 'scoring' && field !== 'total' && newObj.__reasons) {
        const nextReasons = { ...(newObj.__reasons as Record<string, string>) };
        delete nextReasons[field];
        newObj.__reasons = nextReasons;
      }

      // Auto-calc total if evaluating scoring
      if (type === 'scoring' && explicitDomain && evalItemsMap[explicitDomain]) {
        let total = 0;
        let base = 0;
        evalItemsMap[explicitDomain].forEach(item => {
          if (item.item_type === 'formula') base = Number(item.score) || 0;
          else if (item.item_type === 'llm') total += (Number(newObj[item.name]) || 0);
        });
        newObj['total'] = total + base;
      }

      return { ...prev, [key]: newObj };
    });
  };

  const updateWrittenScore = (studentId: number, domainName: string, value: string) => {
    setWrittenScores(prev => ({ ...prev, [`${studentId}_${domainName}`]: value }));
  };

  const selectedStudents = useMemo(
    () => students.filter((student) => selectedStudentIds.has(student.id)),
    [students, selectedStudentIds]
  );
  const allStudentsSelected = students.length > 0 && selectedStudentIds.size === students.length;

  const toggleStudentSelection = (studentId: number) => {
    setSelectedStudentIds(prev => {
      const next = new Set(prev);
      if (next.has(studentId)) next.delete(studentId);
      else next.add(studentId);
      return next;
    });
  };

  const toggleAllStudents = () => {
    setSelectedStudentIds(prev => (
      prev.size === students.length ? new Set() : new Set(students.map(student => student.id))
    ));
  };

  const applyGeneratedContent = (studentId: number, type: 'scoring' | 'comments', domain: string, content: string | null) => {
    if (!content) return;
    setContents(prev => ({
      ...prev,
      [`${studentId}_${type}_${domain}`]: parseContent(content),
    }));
  };

  const isContentFieldDirty = (key: string, field: string) => {
    return normalizeStoredValue(contents[key]?.[field]) !== normalizeStoredValue(savedContents[key]?.[field]);
  };

  const isScoringReasonDirty = (key: string, field: string) => {
    return normalizeStoredValue((contents[key] as ScoringContent | undefined)?.__reasons?.[field])
      !== normalizeStoredValue((savedContents[key] as ScoringContent | undefined)?.__reasons?.[field]);
  };

  const dirtyControlClass = (dirty: boolean) =>
    dirty ? 'bg-amber-50 border-amber-300 focus:border-amber-500 focus:ring-amber-400' : '';

  const llmErrorTooltip = (scoreData?: Record<string, any>, commentsData?: Record<string, any>) => {
    const parts: string[] = [];
    const scoringError = String(scoreData?.__llmError || '').trim();
    const scoringResult = String(scoreData?.__llmErrorResult || '').trim();
    const commentsError = String(commentsData?.__llmError || '').trim();
    const commentsResult = String(commentsData?.__llmErrorResult || '').trim();
    if (scoringError || scoringResult) {
      parts.push(['[채점 오류]', scoringError, scoringResult].filter(Boolean).join('\n'));
    }
    if (commentsError || commentsResult) {
      parts.push(['[기록/세특 오류]', commentsError, commentsResult].filter(Boolean).join('\n'));
    }
    return parts.join('\n\n').trim();
  };

  const renderLlmErrorTooltip = (message: string) => {
    if (!message) return null;
    return (
      <div className="pointer-events-none absolute left-1/2 top-full z-50 mt-2 hidden max-h-80 w-96 max-w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 overflow-auto rounded-md border border-rose-200 bg-rose-50 p-3 text-left text-xs font-normal leading-relaxed text-rose-950 shadow-lg ring-1 ring-rose-100 group-hover:block group-focus-within:block">
        <div className="mb-1 text-[11px] font-semibold text-rose-700">LLM 오류</div>
        <div className="whitespace-pre-wrap">{message}</div>
      </div>
    );
  };

  useEffect(() => {
    if (aiBatchUpdates.length < appliedUpdateCountRef.current) {
      appliedUpdateCountRef.current = 0;
    }
    if (!selectedClass) return;
    const pendingUpdates = aiBatchUpdates.slice(appliedUpdateCountRef.current)
      .filter(update => update.contentType !== 'activity' && (!update.classId || update.classId === selectedClass.id));
    if (!pendingUpdates.length) return;

    const spellcheckUpdates = pendingUpdates.filter(update => update.contentType === 'spellcheck');
    if (spellcheckUpdates.length) {
      setSpellcheckDiffs(prev => {
        const next = { ...prev };
        for (const update of spellcheckUpdates) {
          if (!update.content) continue;
          try {
            const parsed = JSON.parse(update.content) as SpellcheckResult;
            if (!parsed.correctedText) continue;
            const originalText = String(contents[`${update.studentId}_comments_${SUBJECT_COMPREHENSIVE_DOMAIN}`]?.text || '');
            next[update.studentId] = buildSpellcheckDiff(originalText, parsed.correctedText);
          } catch {
            // 형식이 잘못된 배치 결과는 기존 diff를 유지합니다.
          }
        }
        return next;
      });
      const errorCount = spellcheckUpdates.filter(update => update.error).length;
      if (errorCount) window.setTimeout(() => alert(`교정 배치 결과 ${errorCount}건을 반영하지 못했습니다.`), 0);
    }

    setContents(prev => {
      let next = prev;
      for (const update of pendingUpdates) {
        if (!students.some(student => student.id === update.studentId)) continue;
        if (update.contentType === 'spellcheck') {
          if (!update.content) continue;
          try {
            const parsed = JSON.parse(update.content) as SpellcheckResult;
            if (!parsed.correctedText) continue;
            next = {
              ...next,
              [`${update.studentId}_spellcheck_${SUBJECT_COMPREHENSIVE_DOMAIN}`]: {
                text: parsed.correctedText,
              },
            };
          } catch {
            // 형식이 잘못된 배치 결과는 기존 교정 내용을 유지합니다.
          }
          continue;
        }
        const key = `${update.studentId}_${update.contentType}_${update.domain}`;
        const nextContent = update.content
          ? parseContent(update.content)
          : update.contentType === 'scoring'
          ? {
              total: 0,
              __llmError: update.error,
              __llmErrorResult: update.llmResult,
            }
          : {
              text: '',
              __llmError: update.error,
              __llmErrorResult: update.llmResult,
            };
        next = {
          ...next,
          [key]: nextContent,
        };
      }
      return next;
    });
    appliedUpdateCountRef.current = aiBatchUpdates.length;
  }, [aiBatchUpdates, selectedClass, students]);

  const runSpellcheckComprehensive = async (studentId: number, text: string, signal?: AbortSignal) => {
    const trimmed = text.trim();
    if (!trimmed) {
      alert('맞춤법 검사할 세특 내용이 없습니다.');
      return;
    }

    setSpellcheckingIds(prev => new Set(prev).add(studentId));

    try {
      const res = await aiApi.spellcheck({ text }, signal);
      const correctedText = String(res.data.correctedText || text);
      setContents(prev => ({
        ...prev,
        [`${studentId}_spellcheck_${SUBJECT_COMPREHENSIVE_DOMAIN}`]: {
          text: correctedText,
        },
      }));
      setSpellcheckDiffs(prev => ({
        ...prev,
        [studentId]: buildSpellcheckDiff(text, correctedText),
      }));
    } catch (err: any) {
      if (err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED') return;
      const message = err?.response?.data?.error || '맞춤법 검사 중 오류가 발생했습니다.';
      alert(message);
    } finally {
      setSpellcheckingIds(prev => {
        const next = new Set(prev);
        next.delete(studentId);
        return next;
      });
    }
  };

  const handleBatchSpellcheck = async () => {
    const targetStudents = selectedStudents.length > 0 ? selectedStudents : students;
    if (!targetStudents.length) return;

    const controller = new AbortController();
    spellcheckAbortRef.current = controller;
    setSpellcheckStopping(false);
    setSpellcheckProgress({ completed: 0, total: targetStudents.length });
    try {
      for (let i = 0; i < targetStudents.length; i++) {
        if (controller.signal.aborted) break;
        const student = targetStudents[i];
        const key = `${student.id}_comments_${SUBJECT_COMPREHENSIVE_DOMAIN}`;
        const text = contents[key]?.text || '';
        if (text.trim()) await runSpellcheckComprehensive(student.id, text, controller.signal);
        setSpellcheckProgress({ completed: i + 1, total: targetStudents.length });
      }
    } finally {
      setSpellcheckProgress(null);
      setSpellcheckStopping(false);
      spellcheckAbortRef.current = null;
    }
  };

  const handleStartClaudeSpellcheckBatch = async () => {
    if (!selectedClass) return;
    if (llmProvider !== 'anthropic') {
      alert('Claude 배치는 LLM 공급자가 Anthropic (Claude)일 때만 사용할 수 있습니다.');
      return;
    }
    const targetStudents = selectedStudents.length > 0 ? selectedStudents : students;
    const items = targetStudents
      .map(student => ({
        studentId: student.id,
        text: String(contents[`${student.id}_comments_${SUBJECT_COMPREHENSIVE_DOMAIN}`]?.text || '').trim(),
      }))
      .filter(item => item.text);
    if (!items.length) {
      alert('교정할 세특 내용이 없습니다.');
      return;
    }
    if (!confirm(`${items.length}명 대상 교정 Claude 배치 요청을 실행하시겠습니까?`)) return;
    const submitted = await startClaudeSpellcheckBatch({
      classId: selectedClass.id,
      classLabel: `${selectedClass.year}학년도 ${selectedClass.semester}학기 ${selectedClass.grade}학년 ${selectedClass.subject} ${selectedClass.room}`,
      items,
    });
    if (!submitted) alert('교정 Claude 배치 요청을 제출하지 못했습니다.');
  };

  const applySpellcheckResult = async (studentId: number) => {
    const correctedText = String(
      contents[`${studentId}_spellcheck_${SUBJECT_COMPREHENSIVE_DOMAIN}`]?.text || ''
    );
    if (!correctedText) return;

    const key = `${studentId}_comments_${SUBJECT_COMPREHENSIVE_DOMAIN}`;
    const nextContent = { text: correctedText };
    setContents(prev => ({ ...prev, [key]: nextContent }));
    setSpellcheckDiffs(prev => ({
      ...prev,
      [studentId]: buildSpellcheckDiff(correctedText, correctedText),
    }));
  };

  const handleSaveAll = async () => {
    if (!selectedClass) return;
    if (!isDirty) {
      alert('변경 내용이 없습니다.');
      return;
    }
    setSaving(true);
    try {
      const promises = [];
      const savedKeys: string[] = [];
      const enabledDomainTypes = [
        ...(showScoring ? ['scoring'] : []),
        ...(showComments ? ['comments'] : []),
      ];
      const subj = subjects.find(sub =>
        sub.year === selectedClass.year &&
        sub.semester === selectedClass.semester &&
        sub.grade === selectedClass.grade &&
        sub.subject === selectedClass.subject
      );
      const domainPool = [
        ...(subj?.fixedDomains || []),
        ...(showComments ? (subj?.customDomains || []) : []),
      ];
      const domainsToSave = domainFilter === 'all'
        ? domainPool
        : domainPool.filter((d: any) => d.name === domainFilter);

      for (const s of students) {
        // Save comprehensive comments
        const compKey = `${s.id}_comments_${SUBJECT_COMPREHENSIVE_DOMAIN}`;
        if (showComprehensive && contents[compKey]) {
          savedKeys.push(compKey);
          promises.push(
            recordsApi.saveStudentContent(s.id, {
              content_type: 'comments',
              domain: SUBJECT_COMPREHENSIVE_DOMAIN,
              content: JSON.stringify(contents[compKey])
            })
          );
        }
        const spellcheckKey = `${s.id}_spellcheck_${SUBJECT_COMPREHENSIVE_DOMAIN}`;
        if (showComprehensive && contents[spellcheckKey]) {
          savedKeys.push(spellcheckKey);
          promises.push(
            recordsApi.saveStudentContent(s.id, {
              content_type: 'spellcheck',
              domain: SUBJECT_COMPREHENSIVE_DOMAIN,
              content: JSON.stringify(contents[spellcheckKey])
            })
          );
        }

        // Save other domains
        for (const d of domainsToSave) {
          for (const type of enabledDomainTypes) {
            const key = `${s.id}_${type}_${d.name}`;
            if (contents[key]) {
              savedKeys.push(key);
              promises.push(
                recordsApi.saveStudentContent(s.id, {
                  content_type: type,
                  domain: d.name,
                  content: JSON.stringify(contents[key])
                })
              );
            }
          }
        }
      }
      if (showScoring && writtenExams.length > 0) {
        const visibleWrittenExams = domainFilter === 'all'
          ? writtenExams
          : writtenExams.filter(exam => exam.domain_name === domainFilter);
        const manualWrittenItems: { student_id: number; domain_name: string; score: string }[] = [];
        for (const exam of visibleWrittenExams) {
          if (exam.file_id) continue;
          for (const s of students) {
            const key = `${s.id}_${exam.domain_name}`;
            if (writtenScores[key] !== undefined) {
              manualWrittenItems.push({ student_id: s.id, domain_name: exam.domain_name, score: writtenScores[key] });
            }
          }
        }
        if (manualWrittenItems.length) {
          promises.push(recordsApi.saveWrittenScores(selectedClass.id, manualWrittenItems));
        }
      }
      await Promise.all(promises);
      setSavedContents(prev => {
        const next = { ...prev };
        for (const key of savedKeys) next[key] = contents[key];
        return next;
      });
      setSavedWrittenScores(writtenScores);
      alert('저장되었습니다.');
    } catch (e) {
      alert('저장 중 오류가 발생했습니다.');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteContent = async () => {
    if (!selectedClass) return;

    const targetStudents = selectedStudents.length > 0 ? selectedStudents : students;
    if (targetStudents.length === 0) return;

    const enabledDomainTypes = [
      ...(showScoring ? ['scoring'] : []),
      ...(showComments ? ['comments'] : []),
    ];
    if (enabledDomainTypes.length === 0 && !showComprehensive) return;

    const subj = subjects.find(sub =>
      sub.year === selectedClass.year &&
      sub.semester === selectedClass.semester &&
      sub.grade === selectedClass.grade &&
      sub.subject === selectedClass.subject
    );
    const domainPool = [
      ...(subj?.fixedDomains || []),
      ...(showComments ? (subj?.customDomains || []) : []),
    ];
    const domainsToDelete = domainFilter === 'all'
      ? domainPool.map((d: any) => d.name)
      : domainPool.filter((d: any) => d.name === domainFilter).map((d: any) => d.name);

    const domainLabel = domainFilter === 'all' ? '전체 영역' : domainFilter;
    const typeLabels = [
      ...(showScoring ? ['채점'] : []),
      ...(showComments ? ['기록'] : []),
      ...(showComprehensive ? ['세특'] : []),
    ];
    const typeLabel = typeLabels.join(', ');
    const targetLabel = selectedStudents.length > 0 ? `선택한 ${targetStudents.length}명` : `${targetStudents.length}명 전체`;

    if (!confirm(`${targetLabel}의 "${domainLabel}" ${typeLabel} 기록 데이터를 정말 삭제하시겠습니까?\n(학생 명단은 유지되며 생성된 기록 내용만 삭제됩니다)`)) return;

    setDeleting(true);
    try {
      const studentIds = selectedStudents.length > 0 ? selectedStudents.map(s => s.id) : undefined;
      const requests = [];
      if (enabledDomainTypes.length > 0) {
        for (const domain of domainsToDelete) {
          requests.push(recordsApi.deleteStudentContent({
            classId: selectedClass.id,
            studentIds,
            domain,
            contentTypes: enabledDomainTypes,
          }));
        }
      }
      if (showComprehensive) {
        requests.push(recordsApi.deleteStudentContent({
          classId: selectedClass.id,
          studentIds,
          domain: SUBJECT_COMPREHENSIVE_DOMAIN,
          contentTypes: ['comments', 'spellcheck'],
        }));
      }
      await Promise.all(requests);

      await loadDomainData(selectedClass);
      alert('삭제되었습니다.');
    } catch (e) {
      alert('삭제 중 오류가 발생했습니다.');
    } finally {
      setDeleting(false);
    }
  };

  const handleBatchGenerate = async (type: 'scoring' | 'comments', explicitDomain?: string) => {
    if (!selectedClass) return;

    const subj = subjects.find(s =>
      s.year === selectedClass.year && s.semester === selectedClass.semester &&
      s.grade === selectedClass.grade && s.subject === selectedClass.subject
    );

    let domainsToProcess: string[];
    if (explicitDomain) {
      domainsToProcess = [explicitDomain];
    } else if (domainFilter === 'all') {
      domainsToProcess = [
        ...(subj?.fixedDomains || []),
        ...(type === 'comments' ? (subj?.customDomains || []) : []),
      ].map((d: any) => d.name);
    } else {
      domainsToProcess = [domainFilter];
    }
    if (domainsToProcess.length === 0) return;
    const targetStudents = selectedStudents.length > 0 ? selectedStudents : students;
    if (targetStudents.length === 0) return;

    const domainLabel = domainsToProcess.length > 1
      ? `전체 ${domainsToProcess.length}개 영역`
      : (domainsToProcess[0] === SUBJECT_COMPREHENSIVE_DOMAIN ? '세특' : domainsToProcess[0]);
    const typeLabel = type === 'comments'
      ? (explicitDomain === SUBJECT_COMPREHENSIVE_DOMAIN ? '세특' : '기록')
      : '채점';
    const targetLabel = selectedStudents.length > 0 ? `선택한 ${targetStudents.length}명` : `${targetStudents.length}명 전체`;
    if (!confirm(`${targetLabel} "${domainLabel}" ${typeLabel} 일괄 생성하시겠습니까?`)) return;

    void startAiBatch({
      classId: selectedClass.id,
      classLabel: `${selectedClass.year}학년도 ${selectedClass.semester}학기 ${selectedClass.grade}학년 ${selectedClass.subject} ${selectedClass.room}`,
      domains: domainsToProcess,
      contentType: type,
      studentIds: targetStudents.map(student => student.id),
    });
  };

  const getGenerationTargets = (type: 'scoring' | 'comments' | 'combined', explicitDomain?: string) => {
    if (!selectedClass) return null;

    const subj = subjects.find(s =>
      s.year === selectedClass.year && s.semester === selectedClass.semester &&
      s.grade === selectedClass.grade && s.subject === selectedClass.subject
    );
    const domainsToProcess = explicitDomain
      ? [explicitDomain]
      : domainFilter === 'all'
        ? [
            ...(subj?.fixedDomains || []),
            ...(type === 'comments' ? (subj?.customDomains || []) : []),
          ].map((d: any) => d.name)
        : [domainFilter];
    const targetStudents = selectedStudents.length > 0 ? selectedStudents : students;
    if (domainsToProcess.length === 0 || targetStudents.length === 0) return null;
    return { domainsToProcess, targetStudents };
  };

  const selectedGenerationTasks = (): Array<{ type: 'scoring' | 'comments' | 'combined'; domain?: string; label: string }> => {
    return showScoring && showComments
      ? [{ type: 'combined' as const, label: '채점/기록' }]
      : [
          ...(showScoring ? [{ type: 'scoring' as const, label: '채점' }] : []),
          ...(showComments ? [{ type: 'comments' as const, label: '기록' }] : []),
          ...(showComprehensive ? [{ type: 'comments' as const, domain: SUBJECT_COMPREHENSIVE_DOMAIN, label: '세특' }] : []),
        ];
  };

  const runGenerateRequest = async (type: 'scoring' | 'comments' | 'combined', explicitDomain?: string, useBatch = false) => {
    if (!selectedClass) return;
    const targets = getGenerationTargets(type, explicitDomain);
    if (!targets) return;
    const { domainsToProcess, targetStudents } = targets;

    if (hasLockedAiCells(selectedClass.id, targetStudents.map(student => student.id), type, domainsToProcess)) {
      alert('배치 작업 진행중인 셀이 포함되어 있습니다. 해당 배치 결과를 먼저 확인하세요.');
      return;
    }

    const args = {
      classId: selectedClass.id,
      classLabel: `${selectedClass.year}학년도 ${selectedClass.semester}학기 ${selectedClass.grade}학년 ${selectedClass.subject} ${selectedClass.room}`,
      domains: domainsToProcess,
      contentType: type,
      studentIds: targetStudents.map(student => student.id),
    };
    if (useBatch) {
      const submitted = await startClaudeBatch(args);
      if (!submitted) alert('배치 요청에 실패했습니다. 잠시 후 다시 시도해 주세요.');
    } else {
      await startAiBatch(args);
    }
  };

  const handleGenerateSelected = async () => {
    if (!selectedClass) return;

    if (showComprehensive && (showScoring || showComments)) {
      alert('세특은 채점/기록과 동시에 생성할 수 없습니다. 세특만 선택한 상태에서 생성하세요.');
      return;
    }
    const tasks = selectedGenerationTasks();
    if (!tasks.length) return;
    const targetStudents = selectedStudents.length > 0 ? selectedStudents : students;
    const label = tasks.map(task => task.label).join('/');
    if (!confirm(`${targetStudents.length}명 대상 ${label} 생성을 실행하시겠습니까?`)) return;

    for (const task of tasks) {
      await runGenerateRequest(task.type, task.domain, false);
    }
  };

  const handleStartClaudeBatch = async () => {
    if (!selectedClass) return;
    if (showComprehensive && (showScoring || showComments)) {
      alert('세특은 채점/기록과 동시에 생성할 수 없습니다. 세특만 선택한 상태에서 생성하세요.');
      return;
    }
    if (llmProvider !== 'anthropic') {
      alert('Claude 배치는 LLM 공급자가 Anthropic (Claude)일 때만 사용할 수 있습니다.');
      return;
    }
    const tasks = selectedGenerationTasks();
    if (!tasks.length) return;
    const targetStudents = selectedStudents.length > 0 ? selectedStudents : students;
    const label = tasks.map(task => task.label).join('/');
    if (!confirm(`${targetStudents.length}명 대상 ${label} Claude 배치 요청을 실행하시겠습니까?`)) return;
    for (const task of tasks) {
      await runGenerateRequest(task.type, task.domain, true);
    }
  };

  const handleOpenClaudeBatchResults = () => {
    if (classClaudeBatchJobs.length) setShowClaudeBatchDialog(true);
  };

  const handleCheckClaudeBatchResults = async (jobId: string) => {
    setReceivingClaudeBatchId(jobId);
    try {
      const done = await checkClaudeBatchResults(jobId);
      if (!done) alert('Claude 배치가 아직 서버에서 진행 중입니다.');
    } catch {
      alert('배치 결과 확인에 실패했습니다. 잠시 후 다시 시도해 주세요.');
    } finally { setReceivingClaudeBatchId(''); }
  };

  const batchKindLabel = (type: 'scoring' | 'comments' | 'combined' | 'spellcheck', domains: string[]) => {
    if (type === 'spellcheck') return '교정';
    if (domains.includes(SUBJECT_COMPREHENSIVE_DOMAIN)) return '세특';
    if (type === 'combined') return '채점/기록';
    return type === 'scoring' ? '채점' : '기록';
  };

  const batchDomainLabel = (domains: string[]) => {
    if (domains.length > 1) return '전체';
    const domain = domains[0] || '';
    return domain === SUBJECT_COMPREHENSIVE_DOMAIN ? '세특' : domain;
  };

  const handleBulkArtifactUpload = async ({ file, folderPath }: { file?: File; folderPath?: string }) => {
    if (!selectedClass || domainFilter === 'all' || (!file && !folderPath)) return;
    setUploadingZip(true);
    const formData = new FormData();
    if (file) formData.append('file', file);
    if (folderPath) formData.append('folderPath', folderPath);
    formData.append('domain', domainFilter);

    try {
      const res = await fetch(`/api/artifacts/bulk-upload/${selectedClass.id}`, {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '업로드 실패');

      setBulkZipResult(data as BulkZipUploadResult);
      await loadDomainData(selectedClass);
      setArtifactRefreshKey(k => k + 1);
    } catch (err: any) {
      setBulkZipResult({
        message: `오류: ${err.message}`,
        count: 0,
        total: 0,
        studentCount: 0,
        unmatchedCount: 0,
        conflictCount: 0,
        errorCount: 1,
        results: [],
        failed: true,
      });
    } finally {
      setUploadingZip(false);
    }
  };
  const handleBulkZipUpload = (file: File) => handleBulkArtifactUpload({ file });
  const handleBulkFolderUpload = (folderPath: string) => handleBulkArtifactUpload({ folderPath });

  const handleExport = async (type: 'comments' | 'scoring') => {
    if (!selectedClass) return;
    try {
      const r = await fetch(`/api/records/export/${selectedClass.id}?type=${type}`);
      if (!r.ok) throw new Error('Export failed');
      const blob = await r.blob();
      // Content-Disposition 헤더에서 원본 파일명 추출
      const disposition = r.headers.get('Content-Disposition') || '';
      const utf8Match = disposition.match(/filename\*=UTF-8''(.+)/i);
      const plainMatch = disposition.match(/filename="?([^";]+)"?/i);
      const filename = utf8Match
        ? decodeURIComponent(utf8Match[1])
        : plainMatch
          ? plainMatch[1]
          : `${type === 'comments' ? '세특' : '채점'}_${selectedClass.year}_${selectedClass.subject}_${selectedClass.room}.xlsx`;
      await saveBlob(filename, blob);
    } catch { alert('내보내기 실패'); }
  };

  const getDownloadFilename = (disposition: string, fallback: string) => {
    const utf8Match = disposition.match(/filename\*=UTF-8''(.+)/i);
    const plainMatch = disposition.match(/filename="?([^";]+)"?/i);
    return utf8Match ? decodeURIComponent(utf8Match[1]) : plainMatch ? plainMatch[1] : fallback;
  };

  const handleExportFullRecords = async () => {
    if (!selectedClass) return;
    try {
      const r = await recordsApi.exportFull(selectedClass.id);
      await saveBlob(
        getDownloadFilename(
          r.headers['content-disposition'] || '',
          `전체기록_${selectedClass.year}_${selectedClass.subject}_${selectedClass.room}.xlsx`
        ),
        r.data
      );
    } catch {
      alert('전체 기록 다운로드 실패');
    }
  };

  const handleImportFullRecords = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files?.length) return;
    const file = e.target.files[0];
    const confirmMessage = selectedClass
      ? '업로드한 엑셀 내용으로 현재 강의실의 저장된 AI 채점/활동/세특 내용을 덮어씁니다. 계속하시겠습니까?'
      : '엑셀 파일의 기본정보에 있는 강의실로 전체 기록을 업로드합니다. 강의실이 없으면 새로 만듭니다. 계속하시겠습니까?';
    if (!confirm(confirmMessage)) {
      e.target.value = '';
      return;
    }
    setUploadingFullRecords(true);
    try {
      const r = selectedClass
        ? await recordsApi.importFull(selectedClass.id, file)
        : await recordsApi.importFullFile(file);
      const refreshed = await loadData();
      const importedClassId = Number(r.data.classId || selectedClass?.id);
      const targetClass = refreshed.classes.find(c => c.id === importedClassId);
      if (targetClass) await handleSelectClass(targetClass);
      alert(`전체 기록 업로드 완료: ${r.data.saved}개 항목 저장`);
    } catch (err: any) {
      alert(`전체 기록 업로드 실패: ${err?.response?.data?.error || err.message || String(err)}`);
    } finally {
      setUploadingFullRecords(false);
      if (fullRecordsInputRef.current) fullRecordsInputRef.current.value = '';
    }
  };

  const isScoringDomain = evalItems.length > 0;

  // ── Table column layout ────────────────────────────────────────────────────
  const tableLayout = useMemo(() => {
    if (!selectedClass) return { visibleDomains: [] as any[], domainCols: new Map<string, any[]>(), compCommentsColIdx: -1 };
    const subj = subjects.find(s =>
      s.year === selectedClass.year && s.semester === selectedClass.semester &&
      s.grade === selectedClass.grade && s.subject === selectedClass.subject
    );
    const fixedDomains: any[] = (subj?.fixedDomains || []).map((domain: any) => ({ ...domain, __kind: 'performance' }));
    const customDomains: any[] = subj?.customDomains || [];
    const writtenDomains: any[] = showScoring
      ? writtenExams.map(exam => ({
        name: exam.domain_name,
        max_score: exam.max_score,
        ratio: exam.ratio,
        sort_order: exam.sort_order,
        __kind: 'written',
        file_id: exam.file_id,
        filename: exam.filename,
      }))
      : [];
    const allDomains = [...fixedDomains, ...writtenDomains, ...(showComments ? customDomains : [])];
    const visibleDomains = domainFilter === 'all' ? allDomains : allDomains.filter((d: any) => d.name === domainFilter);

    let fi = 0;
    const domainCols = new Map<string, Array<{ id: string; label: string; type: string; fi: number; itemTitle?: string }>>();
    for (const d of visibleDomains) {
      const isFixed = d.__kind === 'performance';
      const isWritten = d.__kind === 'written';
      const evalList = (evalItemsMap[d.name] || []) as EvalItem[];
      const cols: Array<{ id: string; label: string; type: string; fi: number; itemTitle?: string }> = [];
      if (showScoring && isFixed) {
        cols.push({ id: 'artifact', label: '산출물', type: 'artifact', fi: -1 });
        evalList.filter(e => e.item_type === 'llm').forEach(e =>
          cols.push({ id: e.name, label: `${e.name} (${e.score})`, type: 'llm', fi: fi++ })
        );
        if (evalList.some(e => e.item_type === 'formula'))
          cols.push({ id: 'total', label: '합계', type: 'total', fi: -1 });
      }
      if (showScoring && isWritten) {
        cols.push({ id: 'written', label: `점수 (${d.max_score || 0})`, type: 'written', fi: fi++ });
      }
      if (showComments) {
        if (!cols.find(c => c.id === 'artifact'))
          cols.push({ id: 'artifact', label: '산출물', type: 'artifact', fi: -1 });
        const sitems = commentsItemsMap[d.name] || [];
        if (sitems.length > 0) {
          sitems.forEach((item, i) =>
            cols.push({ id: `comments_${i}`, label: item.title, type: 'comments_item', fi: fi++, itemTitle: item.title })
          );
        }
      }
      domainCols.set(d.name, cols);
    }
    return { visibleDomains, domainCols, compCommentsColIdx: showComprehensive ? fi : -1 };
  }, [selectedClass, subjects, domainFilter, evalItemsMap, commentsItemsMap, writtenExams, showScoring, showComments, showComprehensive]);

  // ── Frozen column widths & sticky left offsets ─────────────────────────────
  const frozenLayout = recordsFrozenLayout(colWidths);
  const cw = frozenLayout.width;
  const compWidth = colWidths['_comp'] ?? 320;
  const activityWidth = colWidths['_activity'] ?? 280;
  const compCountWidth = colWidths['_comp_count'] ?? 74;
  const compSpellWidth = colWidths['_comp_spell'] ?? 320;
  const grandTotalWidth = colWidths['_grand_total'] ?? 70;
  const tableColumnWidths = [
    cw.chk,
    cw.cls,
    cw.num,
    cw.name,
    ...tableLayout.visibleDomains.flatMap((d: any) => {
      const cols = tableLayout.domainCols.get(d.name) || [];
      return cols.map((c: any) => {
        const wk = `${d.name}||${c.id}`;
        return colWidths[wk] ?? getDomainColumnDefaultWidth(c.type);
      });
    }),
    ...(showScoring ? [grandTotalWidth] : []),
    ...(showComprehensive ? [activityWidth, compWidth, compCountWidth, compSpellWidth] : []),
  ];
  const tableTotalWidth = tableColumnWidths.reduce((sum, width) => sum + width, 0);
  const selectedSubject = selectedClass
    ? subjects.find(s =>
      s.year === selectedClass.year &&
      s.semester === selectedClass.semester &&
      s.grade === selectedClass.grade &&
      s.subject === selectedClass.subject
    )
    : undefined;

  const domainsInFilter = useMemo(() => {
    if (!selectedSubject) return [] as any[];
    const allDomains = [
      ...(selectedSubject.fixedDomains || []),
      ...writtenExams.map(exam => ({ name: exam.domain_name })),
      ...(selectedSubject.customDomains || []),
    ];
    return domainFilter === 'all'
      ? allDomains
      : allDomains.filter((d: any) => d.name === domainFilter);
  }, [selectedSubject, writtenExams, domainFilter]);

  const canShowScoring = useMemo(() => {
    if (!selectedSubject) return false;
    const fixedDomains = selectedSubject.fixedDomains || [];
    const targetDomains = domainFilter === 'all'
      ? fixedDomains
      : fixedDomains.filter((d: any) => d.name === domainFilter);
    const hasWritten = domainFilter === 'all'
      ? writtenExams.length > 0
      : writtenExams.some(exam => exam.domain_name === domainFilter);
    return hasWritten || targetDomains.some((d: any) => hasScoringCriteria(evalItemsMap[d.name]));
  }, [selectedSubject, writtenExams, domainFilter, evalItemsMap]);

  const canShowComments = useMemo(() => {
    return domainsInFilter.some((d: any) => (commentsItemsMap[d.name] || []).length > 0);
  }, [domainsInFilter, commentsItemsMap]);

  useEffect(() => {
    if (!selectedClass) return;
    if (!canShowScoring && showScoring) setShowScoring(false);
    if (!canShowComments && showComments) setShowComments(false);
    if (!showScoring && !showComments && !showComprehensive) setShowComprehensive(true);
  }, [selectedClass, canShowScoring, canShowComments, showScoring, showComments, showComprehensive]);

  useEffect(() => {
    if (!selectedSubject || domainFilter === 'all') return;
    const allowedDomains = [
      ...(selectedSubject.fixedDomains || []),
      ...(showScoring ? writtenExams.map(exam => ({ name: exam.domain_name })) : []),
      ...(showComments ? (selectedSubject.customDomains || []) : []),
    ].map((d: any) => d.name);
    if (!allowedDomains.includes(domainFilter)) setDomainFilter('all');
  }, [selectedSubject, showScoring, showComments, writtenExams, domainFilter]);

  useEffect(() => {
    if (!selectedClass) return;
    if (restoringViewPrefsRef.current) return;
    writeRecordsViewPrefs(selectedClass, {
      showScoring,
      showComments,
      showComprehensive,
      domainFilter,
    });
  }, [selectedClass, showScoring, showComments, showComprehensive, domainFilter]);

  const recordsHeader = useRecordsHeader({
    selectedClass,
    selectedSubject,
    writtenExams,
    showScoring,
    showComments,
    showComprehensive,
    claudeBatchJobCount: classClaudeBatchJobs.length,
    canShowScoring,
    canShowComments,
    setShowScoring,
    setShowComments,
    setShowComprehensive,
    domainFilter,
    setDomainFilter,
    uploadingZip,
    handleBulkZipUpload,
    handleBulkFolderUpload,
    handleGenerateSelected,
    handleStartClaudeBatch,
    handleOpenClaudeBatchResults,
    batchGenerating,
    handleBatchSpellcheck,
    handleStartClaudeSpellcheckBatch,
    spellcheckProgress,
    spellcheckingCount: spellcheckingIds.size,
    selectedStudentCount: selectedStudentIds.size,
    handleExport,
    saving,
    handleSaveAll,
    deleting,
    handleDeleteContent,
    uploadingFullRecords,
    fullRecordsInputRef,
    handleImportFullRecords,
    handleExportFullRecords,
    aiEnabled,
    claudeBatchAvailable: llmProvider === 'anthropic',
  });

  return {
    sidebar: {
        title: RECORDS_PAGE_TEXT.sidebarTitle,
        collapsed: recordsTree.collapsed,
        titleAction: (
          <button
            type="button"
            className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 ${recordsTree.collapsed ? 'mx-auto' : 'ml-auto'}`}
            onClick={recordsTree.toggleCollapsed}
            title={recordsTree.collapsed ? RECORDS_PAGE_TEXT.expandTree : RECORDS_PAGE_TEXT.collapseTree}
          >
            {recordsTree.collapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
          </button>
        ),
        upload: {
          label: RECORDS_PAGE_TEXT.uploadLabel,
          loading: recordsUpload.uploadingFiles,
          hideLabel: recordsTree.collapsed,
          input: (
            <input
              ref={recordsUpload.classFilesRef}
              type="file"
              className="hidden"
              accept=".xlsx,.xls"
              multiple
              onChange={recordsUpload.handleClassFilesUpload}
              disabled={recordsUpload.uploadingFiles}
            />
          ),
        },
        notices: recordsTree.collapsed ? [] : [
          {
            type: 'guide' as const,
            visible: showGuide,
            sections: RECORDS_PAGE_TEXT.guideSections.map(section => ({
              ...section,
              lines: [...section.lines],
            })),
            onDismiss: hideGuide,
          },
          { type: 'message' as const, visible: !!recordsUpload.uploadMsg, tone: recordsUpload.uploadMsg?.type || 'success', text: recordsUpload.uploadMsg?.text },
        ],
        tree: recordsTree.collapsed ? (
          <RecordsCollapsedTree
            classes={classes}
            selectedClassId={selectedClass?.id}
            getNodeOpen={recordsTree.getNodeOpen}
            onToggleOpen={recordsTree.toggleNodeOpen}
            onSelectClass={handleSelectClass}
          />
        ) : (
          {
            nodes: recordsTree.tree,
            empty: <p className="text-xs text-gray-400 text-center py-8">{RECORDS_PAGE_TEXT.emptyTree}</p>,
            node: {
              selected: (item: RecordsTreeNode) => item.kind === 'room' && selectedClass?.id === item.classItem?.id,
              clickable: (item: RecordsTreeNode) => item.kind === 'room' && !!item.classItem,
              onSelect: (item: RecordsTreeNode) => item.classItem && handleSelectClass(item.classItem),
              openStates: recordsTree.openStates,
              onToggleOpen: recordsTree.toggleNodeOpen,
              actions: (item: RecordsTreeNode) => item.kind === 'room' && item.classItem ? [
                {
                  title: '채점 삭제',
                  icon: 'trash' as const,
                  variant: 'blue' as const,
                  visible: item.classItem.scoring_filename ? 'always' as const : 'hidden' as const,
                  onClick: (node: RecordsTreeNode) => handleDeleteScoring(node.classItem!),
                },
                {
                  title: '세특 삭제',
                  icon: 'trash' as const,
                  variant: 'purple' as const,
                  visible: item.classItem.comments_filename ? 'always' as const : 'hidden' as const,
                  onClick: (node: RecordsTreeNode) => handleDeleteComments(node.classItem!),
                },
                {
                  title: '전체 삭제',
                  icon: 'trash' as const,
                  variant: 'red' as const,
                  visible: 'always' as const,
                  onClick: (node: RecordsTreeNode) => handleDeleteClass(node.classItem!),
                },
              ] : [],
            },
          }
        ),
      },
    header: {
        leading: recordsHeader.leading,
        actions: recordsHeader.actions,
        hideTitle: true,
      },
    contentProps: {
      selected: !!selectedClass,
      spellcheckProgress,
      spellcheckStopping,
      onStopSpellcheck: () => {
          spellcheckAbortRef.current?.abort();
          setSpellcheckStopping(true);
        },
      children: selectedClass && (
          <>
          {showClaudeBatchDialog && (
            <ClaudeBatchResultsDialog
              subtitle={`${selectedClass.year}학년도 ${selectedClass.semester}학기 ${selectedClass.grade}학년 ${selectedClass.subject} ${selectedClass.room}`}
              jobs={classClaudeBatchJobs as ClaudeBatchResultJob[]}
              kindLabel={job => batchKindLabel(job.contentType as 'scoring' | 'comments' | 'combined' | 'spellcheck', job.domains)}
              domainLabel={job => batchDomainLabel(job.domains)}
              receivingId={receivingClaudeBatchId}
              onReceive={job => handleCheckClaudeBatchResults(job.id)}
              onClose={() => setShowClaudeBatchDialog(false)}
            />
          )}
          {bulkZipResult && (
            <BulkImportResultDialog
              title="산출물 일괄 업로드 결과"
              message={bulkZipResult.message}
              onClose={() => setBulkZipResult(null)}
              results={bulkZipResult.results}
              stats={[
                { label: '전체 파일', value: bulkZipResult.total },
                { label: '등록', value: bulkZipResult.count },
                { label: '연결 학생', value: bulkZipResult.studentCount },
                { label: '미매칭', value: bulkZipResult.unmatchedCount },
                { label: '충돌/오류', value: bulkZipResult.conflictCount + bulkZipResult.errorCount },
              ]}
            />
          )}
          {/* 테이블 뷰 */}
          <div className="flex-1 overflow-auto scrollbar-stable bg-white pb-32">
            {students.length === 0 ? (
              <div className="py-20 text-center text-gray-400">학생 명단이 없습니다.</div>
            ) : (
              <div className="w-max pr-32">
              <table
                ref={tableRef}
                className="records-table text-sm text-left border-collapse"
                style={{ tableLayout: 'fixed', width: tableTotalWidth, minWidth: tableTotalWidth }}
              >
                <colgroup>
                  {tableColumnWidths.map((width, index) => (
                    <col key={index} style={{ width, minWidth: width }} />
                  ))}
                </colgroup>
                {/* ── HEADER ── */}
                <thead className="bg-gray-50 sticky top-0 z-20 shadow-sm">
                  <tr>
                    <RecordsFrozenHeader layout={frozenLayout} allSelected={allStudentsSelected} onToggleAll={toggleAllStudents} onResize={handleResizeStart}/>

                    {/* Domain group headers */}
                    {tableLayout.visibleDomains.map((d: any) => {
                      const cols = tableLayout.domainCols.get(d.name) || [];
                      if (!cols.length) return null;
                      return (
                        <th key={d.name} colSpan={cols.length}
                          className="px-2 py-1.5 font-semibold text-gray-700 text-center border-b border-r bg-gray-100/50 select-none">
                          <div className="flex items-center justify-center gap-1">
                            <span className="truncate">{d.name}</span>
                            {d.__kind === 'written' && d.file_id && (
                              <button
                                type="button"
                                className="inline-flex h-5 w-5 items-center justify-center rounded border border-red-200 bg-white text-red-500 hover:bg-red-50"
                                title="지필 파일 삭제"
                                onClick={() => handleDeleteWrittenExam(d.name)}
                              >
                                <Trash2 size={12} />
                              </button>
                            )}
                          </div>
                        </th>
                      );
                    })}

                    {/* Grand total header */}
                    {showScoring && (
                      <th rowSpan={2} className="relative px-2 py-3 font-semibold text-gray-700 border-b border-r bg-green-50/60 text-center select-none"
                        style={{ width: grandTotalWidth, minWidth: grandTotalWidth }}>
                        합계
                        <div className="records-table-column-resize-handle absolute right-0 top-0 bottom-0 cursor-col-resize bg-transparent z-10"
                          onMouseDown={e => handleResizeStart(e, '_grand_total', 70)} />
                      </th>
                    )}

                    {/* Comp comments header */}
                    {showComprehensive && (
                      <>
                        <th rowSpan={2} className="relative px-4 py-3 font-semibold text-gray-800 border-b border-r bg-amber-50/60 text-center select-none"
                          style={{ width: activityWidth, minWidth: activityWidth }}>
                          활동
                          <div className="records-table-column-resize-handle absolute right-0 top-0 bottom-0 cursor-col-resize bg-transparent z-10"
                            onMouseDown={e => handleResizeStart(e, '_activity', 280)} />
                        </th>
                        <th rowSpan={2} className="relative px-4 py-3 font-semibold text-gray-800 border-b border-r bg-blue-50/50 text-center select-none"
                          style={{ width: compWidth, minWidth: compWidth }}>
                          과목별세부능력및특기사항
                          <div className="records-table-column-resize-handle absolute right-0 top-0 bottom-0 cursor-col-resize bg-transparent z-10"
                            onMouseDown={e => handleResizeStart(e, '_comp', 320)} />
                        </th>
                        <th rowSpan={2} className="relative px-2 py-3 font-semibold text-gray-700 border-b border-r bg-blue-50/50 text-center select-none"
                          style={{ width: compCountWidth, minWidth: compCountWidth }}>
                          글자수
                          <div className="records-table-column-resize-handle absolute right-0 top-0 bottom-0 cursor-col-resize bg-transparent z-10"
                            onMouseDown={e => handleResizeStart(e, '_comp_count', 74)} />
                        </th>
                        <th rowSpan={2} className="relative px-3 py-3 font-semibold text-gray-700 border-b bg-blue-50/50 text-center select-none"
                          style={{ width: compSpellWidth, minWidth: compSpellWidth }}>
                          맞춤법 검사 결과
                          <div className="records-table-column-resize-handle absolute right-0 top-0 bottom-0 cursor-col-resize bg-transparent z-10"
                            onMouseDown={e => handleResizeStart(e, '_comp_spell', 320)} />
                        </th>
                      </>
                    )}
                  </tr>
                  <tr>
                    {tableLayout.visibleDomains.map((d: any) => {
                      const cols = tableLayout.domainCols.get(d.name) || [];
                      return cols.map((c: any) => {
                        const wk = `${d.name}||${c.id}`;
                        const defW = getDomainColumnDefaultWidth(c.type);
                        const w = colWidths[wk] ?? defW;
                        return (
                          <th key={`${d.name}_${c.id}`}
                            className="relative px-2 py-1.5 font-medium text-gray-600 border-b border-r text-center select-none"
                            style={{ width: w, minWidth: w }}>
                            {c.label}
                            <div className="records-table-column-resize-handle absolute right-0 top-0 bottom-0 cursor-col-resize bg-transparent z-10"
                              onMouseDown={e => handleResizeStart(e, wk, defW)} />
                          </th>
                        );
                      });
                    })}
                  </tr>
                </thead>

                {/* ── BODY ── */}
                <tbody className="divide-y divide-gray-100">
                  {students.map((s, rowIdx) => {
                    const compCommentsData = contents[`${s.id}_comments_${SUBJECT_COMPREHENSIVE_DOMAIN}`] || {};
                    const compCommentsText = compCommentsData.text || '';
                    const compLlmError = llmErrorTooltip(undefined, compCommentsData);
                    const compCommentsBytes = countTextBytes(compCommentsText);
                    const isCompCommentsOver = compCommentsBytes > 1500;
                    const isSpellchecking = spellcheckingIds.has(s.id);
                    const spellcheckKey = `${s.id}_spellcheck_${SUBJECT_COMPREHENSIVE_DOMAIN}`;
                    const spellcheckText = String(contents[spellcheckKey]?.text || '');
                    const spellcheckLocked = isSpellchecking || (selectedClass
                      ? isAiCellLocked(selectedClass.id, s.id, 'spellcheck', SUBJECT_COMPREHENSIVE_DOMAIN)
                      : false);
                    const spellcheckDiff = spellcheckDiffs[s.id]
                      || buildSpellcheckDiff(compCommentsText, spellcheckText);
                    const showSpellcheckHighlight = focusedSpellcheckId !== s.id && !!spellcheckText;
                    const classNum = Math.floor((s.student_num % 10000) / 100);
                    const stuNum = s.student_num % 100;
                    const rowTextareaHeight = rowTextareaHeights[s.id];
                    const rowTableHeight = rowTextareaHeight ? rowTextareaHeight + 10 : undefined;

                    return (
                      <tr key={s.id} className="records-table-row" style={{ height: rowTableHeight }}>
                        <RecordsFrozenStudentCells layout={frozenLayout} rowKey={s.id} classNum={classNum} studentNum={stuNum} name={s.name} selected={selectedStudentIds.has(s.id)} onToggle={() => toggleStudentSelection(s.id)} renderResizeHandles={renderCellResizeHandles}/>

                        {/* Domain cells */}
                        {tableLayout.visibleDomains.map((d: any) => {
                          const cols = tableLayout.domainCols.get(d.name) || [];
                          const scoreData = contents[`${s.id}_scoring_${d.name}`] || {};
                          const commentsData = contents[`${s.id}_comments_${d.name}`] || {};
                          const domainLlmError = llmErrorTooltip(scoreData, commentsData);

                          return cols.map((c: any) => {
                            const wk = `${d.name}||${c.id}`;
                            const defW = getDomainColumnDefaultWidth(c.type);
                            const w = colWidths[wk] ?? defW;

                            if (c.type === 'artifact') {
                              return (
                                <td key={`${d.name}_artifact`} className="group relative border-r align-middle text-center p-1"
                                  style={{ width: w, minWidth: w }}>
                                  {renderLlmErrorTooltip(domainLlmError)}
                                  <Suspense fallback={<Loader2 size={12} className="mx-auto animate-spin text-gray-400" />}>
                                    <ArtifactViewer key={`${s.id}_${d.name}_${artifactRefreshKey}`} studentId={s.id} domain={d.name} />
                                  </Suspense>
                                  {renderCellResizeHandles(s.id, wk, defW)}
                                </td>
                              );
                            }
                            if (c.type === 'llm') {
                              const locked = selectedClass
                                ? isAiCellLocked(selectedClass.id, s.id, 'scoring', d.name)
                                : false;
                              const contentKey = `${s.id}_scoring_${d.name}`;
                              const dirty = isContentFieldDirty(contentKey, c.id) || isScoringReasonDirty(contentKey, c.id);
                              const reason = (scoreData as ScoringContent).__reasons?.[c.id] || '';
                              return (
                                <td key={`${d.name}_${c.id}`} className="group relative border-r align-top p-1"
                                  style={{ width: w, minWidth: w }}>
                                  {renderLlmErrorTooltip(domainLlmError)}
                                  <div className="group/reason relative">
                                    <input type="text" className={`input w-full text-sm text-center disabled:bg-blue-50 disabled:text-gray-500 disabled:cursor-not-allowed ${dirtyControlClass(dirty)}`}
                                      value={scoreData[c.id] ?? ''}
                                      onChange={ev => updateContent(s.id, 'scoring', c.id, ev.target.value, d.name)}
                                      disabled={locked}
                                      data-row={rowIdx} data-col={c.fi}
                                      onKeyDown={e => handleKeyNav(e, rowIdx, c.fi)}
                                      title={locked ? 'AI 채점 진행 중이라 수정할 수 없습니다.' : undefined}
                                    />
                                    {reason && !locked && (
                                      <div className="pointer-events-none absolute left-1/2 top-full z-50 mt-2 hidden w-72 -translate-x-1/2 rounded-md border border-amber-200 bg-amber-50 p-3 text-left text-xs leading-relaxed text-amber-950 shadow-lg ring-1 ring-amber-100 group-hover/reason:block group-focus-within/reason:block">
                                        <div className="mb-1 text-[11px] font-semibold text-amber-700">AI 판단 이유</div>
                                        <div className="whitespace-pre-wrap">{reason}</div>
                                      </div>
                                    )}
                                  </div>
                                  {renderCellResizeHandles(s.id, wk, defW)}
                                </td>
                              );
                            }
                            if (c.type === 'total') {
                              const contentKey = `${s.id}_scoring_${d.name}`;
                              const dirty = isContentFieldDirty(contentKey, 'total');
                              return (
                                <td key={`${d.name}_total`} className={`group relative border-r text-center font-bold text-blue-600 align-middle p-2 ${dirty ? 'bg-amber-50' : 'bg-blue-50/30'}`}
                                  style={{ width: w, minWidth: w }}>
                                  {renderLlmErrorTooltip(domainLlmError)}
                                  <span>{scoreData.total || 0}</span>
                                  {renderCellResizeHandles(s.id, wk, defW)}
                                </td>
                              );
                            }
                            if (c.type === 'written') {
                              const key = `${s.id}_${d.name}`;
                              const locked = !!d.file_id;
                              const dirty = normalizeStoredValue(writtenScores[key]) !== normalizeStoredValue(savedWrittenScores[key]);
                              return (
                                <td key={`${d.name}_written`} className="group relative border-r align-middle p-1"
                                  style={{ width: w, minWidth: w }}>
                                  {renderLlmErrorTooltip(domainLlmError)}
                                  <input
                                    type="text"
                                    className={`input w-full text-sm text-center disabled:bg-blue-50 disabled:text-gray-500 disabled:cursor-not-allowed ${dirtyControlClass(dirty)}`}
                                    value={writtenScores[key] ?? ''}
                                    onChange={ev => updateWrittenScore(s.id, d.name, ev.target.value)}
                                    disabled={locked}
                                    data-row={rowIdx}
                                    data-col={c.fi}
                                    onKeyDown={e => handleKeyNav(e, rowIdx, c.fi)}
                                    title={locked ? '지필 파일에서 가져온 점수라 파일 삭제 전까지 수정할 수 없습니다.' : undefined}
                                  />
                                  {renderCellResizeHandles(s.id, wk, defW)}
                                </td>
                              );
                            }
                            if (c.type === 'comments') {
                              const locked = selectedClass
                                ? isAiCellLocked(selectedClass.id, s.id, 'comments', d.name)
                                : false;
                              const contentKey = `${s.id}_comments_${d.name}`;
                              const dirty = isContentFieldDirty(contentKey, 'text');
                              return (
                                <td key={`${d.name}_comments`} className="group relative border-r align-top p-1"
                                  style={{ width: w, minWidth: w }}>
                                  {renderLlmErrorTooltip(domainLlmError)}
                                  <StableTextarea className={`textarea w-full text-sm disabled:bg-blue-50 disabled:text-gray-500 disabled:cursor-not-allowed ${dirtyControlClass(dirty)}`} style={{ minHeight: RECORD_TEXTAREA_MIN_HEIGHT, height: rowTextareaHeight }}
                                    value={commentsData.text || ''}
                                    onChange={ev => updateContent(s.id, 'comments', 'text', ev.target.value, d.name)}
                                    disabled={locked}
                                    data-row={rowIdx} data-col={c.fi}
                                    onKeyDown={e => handleKeyNav(e, rowIdx, c.fi)}
                                    title={locked ? 'AI 기록 생성 진행 중이라 수정할 수 없습니다.' : undefined}
                                  />
                                  {renderCellResizeHandles(s.id, wk, defW)}
                                </td>
                              );
                            }
                            if (c.type === 'comments_item') {
                              const locked = selectedClass
                                ? isAiCellLocked(selectedClass.id, s.id, 'comments', d.name)
                                : false;
                              const itemValue = commentsData[c.itemTitle!]
                                ?? (c.id === 'comments_0' ? commentsData.text : '')
                                ?? '';
                              const contentKey = `${s.id}_comments_${d.name}`;
                              const dirty = isContentFieldDirty(contentKey, c.itemTitle!);
                              return (
                                <td key={`${d.name}_${c.id}`} className="group relative border-r align-top p-1"
                                  style={{ width: w, minWidth: w }}>
                                  {renderLlmErrorTooltip(domainLlmError)}
                                  <StableTextarea className={`textarea w-full text-sm disabled:bg-blue-50 disabled:text-gray-500 disabled:cursor-not-allowed ${dirtyControlClass(dirty)}`} style={{ minHeight: RECORD_TEXTAREA_MIN_HEIGHT, height: rowTextareaHeight }}
                                    value={itemValue}
                                    onChange={ev => updateContent(s.id, 'comments', c.itemTitle!, ev.target.value, d.name)}
                                    disabled={locked}
                                    data-row={rowIdx} data-col={c.fi}
                                    onKeyDown={e => handleKeyNav(e, rowIdx, c.fi)}
                                    title={locked ? 'AI 기록 생성 진행 중이라 수정할 수 없습니다.' : undefined}
                                  />
                                  {renderCellResizeHandles(s.id, wk, defW)}
                                </td>
                              );
                            }
                            return null;
                          });
                        })}

                        {/* Grand total */}
                        {showScoring && (() => {
                          const performanceTotal = ((selectedSubject?.fixedDomains || []) as any[])
                            .reduce((sum: number, d: any) => {
                              const scoreData = (contents[`${s.id}_scoring_${d.name}`] || {}) as ScoringContent;
                              return sum + weightedScore(scoreData.total, d.max_score, d.ratio);
                            }, 0);
                          const writtenTotal = writtenExams
                            .reduce((sum, exam) => sum + weightedScore(writtenScores[`${s.id}_${exam.domain_name}`], exam.max_score, exam.ratio), 0);
                          const grandTotal = performanceTotal + writtenTotal;
                          return (
                            <td className="relative border-r text-center font-bold text-green-700 align-middle p-2 bg-green-50/30"
                              style={{ width: grandTotalWidth, minWidth: grandTotalWidth }}>
                              {formatScore(grandTotal)}
                              {renderCellResizeHandles(s.id, '_grand_total', 70)}
                            </td>
                          );
                        })()}

                        {/* Comp comments */}
                        {showComprehensive && (
                          <>
                            <td className="group relative align-top p-2 border-r bg-amber-50/20 whitespace-pre-wrap text-sm text-gray-700"
                              style={{ width: activityWidth, minWidth: activityWidth }}>
                              {activitySummaries[s.id] || ''}
                              {renderCellResizeHandles(s.id, '_activity', 280)}
                            </td>
                            <td className="group relative align-top p-1 border-r"
                              style={{ width: compWidth, minWidth: compWidth }}>
                              {renderLlmErrorTooltip(compLlmError)}
                              <StableTextarea className={`textarea w-full text-sm bg-blue-50/20 border-blue-100 disabled:bg-blue-50 disabled:text-gray-500 disabled:cursor-not-allowed ${dirtyControlClass(isContentFieldDirty(`${s.id}_comments_${SUBJECT_COMPREHENSIVE_DOMAIN}`, 'text'))}`} style={{ minHeight: RECORD_TEXTAREA_MIN_HEIGHT, height: rowTextareaHeight }}
                                value={compCommentsText}
                                onChange={ev => updateContent(s.id, 'comments', 'text', ev.target.value, SUBJECT_COMPREHENSIVE_DOMAIN)}
                                disabled={selectedClass ? isAiCellLocked(selectedClass.id, s.id, 'comments', SUBJECT_COMPREHENSIVE_DOMAIN) : false}
                                data-row={rowIdx} data-col={tableLayout.compCommentsColIdx}
                                onKeyDown={e => handleKeyNav(e, rowIdx, tableLayout.compCommentsColIdx)}
                                onBlur={() => refreshSpellcheckDiff(s.id, compCommentsText, spellcheckText)}
                                title={selectedClass && isAiCellLocked(selectedClass.id, s.id, 'comments', SUBJECT_COMPREHENSIVE_DOMAIN) ? 'AI 세특 생성 진행 중이라 수정할 수 없습니다.' : undefined}
                              />
                              {renderCellResizeHandles(s.id, '_comp', 320)}
                            </td>
                            <td className="group relative align-top p-1 border-r text-center"
                              style={{ width: compCountWidth, minWidth: compCountWidth }}>
                              {renderLlmErrorTooltip(compLlmError)}
                              <div className={`text-xs font-semibold ${isCompCommentsOver ? 'text-red-600' : 'text-gray-600'}`}>
                                <div>{isCompCommentsOver ? '초과' : '적정'}</div>
                                <div>{compCommentsBytes}</div>
                              </div>
                              <button
                                type="button"
                                className="mt-2 inline-flex h-6 w-6 items-center justify-center rounded border border-blue-200 bg-white text-sm font-bold text-blue-600 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-40"
                                onClick={() => applySpellcheckResult(s.id)}
                                disabled={!spellcheckText.trim()}
                                title="맞춤법 검사 결과를 종합세특에 반영"
                              >
                                &lt;
                              </button>
                              {renderCellResizeHandles(s.id, '_comp_count', 74)}
                            </td>
                            <td className="group relative align-top p-1"
                              style={{ width: compSpellWidth, minWidth: compSpellWidth }}>
                              {renderLlmErrorTooltip(compLlmError)}
                              <div className={`relative rounded-md ${spellcheckLocked ? 'bg-blue-50' : 'bg-blue-50/20'}`}>
                                {showSpellcheckHighlight && (
                                  <div
                                    ref={element => {
                                      spellcheckHighlightRefs.current[s.id] = element;
                                    }}
                                    aria-hidden="true"
                                    className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words rounded-md border border-transparent px-3 py-2 text-sm leading-normal"
                                    style={{ minHeight: RECORD_TEXTAREA_MIN_HEIGHT, height: rowTextareaHeight }}
                                  >
                                    {spellcheckDiff.map((part, index) => (
                                      <span
                                        key={`${index}-${part.value.length}`}
                                        className={part.added ? 'font-medium text-red-600' : 'text-gray-800'}
                                      >
                                        {part.value}
                                      </span>
                                    ))}
                                  </div>
                                )}
                                <StableTextarea
                                  className={`textarea relative z-[1] w-full border-blue-100 bg-transparent text-sm leading-normal disabled:cursor-not-allowed ${dirtyControlClass(isContentFieldDirty(spellcheckKey, 'text'))} ${
                                    showSpellcheckHighlight ? 'text-transparent caret-gray-900' : 'text-gray-800'
                                  }`}
                                  style={{ minHeight: RECORD_TEXTAREA_MIN_HEIGHT, height: rowTextareaHeight }}
                                  value={spellcheckText}
                                  onChange={event => updateContent(
                                    s.id,
                                    'spellcheck',
                                    'text',
                                    event.target.value,
                                    SUBJECT_COMPREHENSIVE_DOMAIN
                                  )}
                                  onFocus={() => setFocusedSpellcheckId(s.id)}
                                  onBlur={() => {
                                    refreshSpellcheckDiff(s.id, compCommentsText, spellcheckText);
                                    setFocusedSpellcheckId(current => current === s.id ? null : current);
                                  }}
                                  onScroll={event => {
                                    const highlight = spellcheckHighlightRefs.current[s.id];
                                    if (!highlight) return;
                                    highlight.scrollTop = event.currentTarget.scrollTop;
                                    highlight.scrollLeft = event.currentTarget.scrollLeft;
                                  }}
                                  disabled={spellcheckLocked}
                                  data-row={rowIdx}
                                  data-col={tableLayout.compCommentsColIdx + 1}
                                  onKeyDown={event => handleKeyNav(event, rowIdx, tableLayout.compCommentsColIdx + 1)}
                                  title={spellcheckLocked ? 'AI 맞춤법 검사 진행 중이라 수정할 수 없습니다.' : undefined}
                                />
                              </div>
                              {renderCellResizeHandles(s.id, '_comp_spell', 320)}
                            </td>
                          </>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
            )}
          </div>
          </>
        ),
    },
  };
}
