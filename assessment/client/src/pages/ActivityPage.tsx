import { Fragment, lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Download, PanelLeftClose, PanelLeftOpen, Plus, RefreshCw, Save, Trash2, Upload } from 'lucide-react';
import type { PreviewArtifact } from '../components/ArtifactPreviewContent';
import { PageLayout } from '../components/common/PageLayout';
import { PageHeaderActions, type PageHeaderAction } from '../components/common/PageHeaderActions';
import { ExecutionModeMenu, HeaderFilterSelect, HeaderImportMenu, HeaderViewToggleGroup } from '../components/common/HeaderViewControls';
import { RecordsFrozenHeader, RecordsFrozenStudentCells, recordsFrozenLayout } from '../components/common/RecordsTableFrozenColumns';
import { useResizableTable } from '../components/common/useResizableTable';
import { BulkImportResultDialog } from '../components/common/BulkImportResultDialog';
import { openLessonJournalLinkDialog, subscribeLessonJournalLinkChanged } from '../components/common/LessonJournalLink';
import { StableTextarea } from '../components/common/StableTextarea';
import { CompactArtifactCell } from '../components/common/CompactArtifactCell';
import { ClaudeBatchResultsDialog, type ClaudeBatchResultJob } from '../components/common/ClaudeBatchResultsDialog';
import { RecordsCollapsedTree } from '../features/records/RecordsCollapsedTree';
import { useRecordsTree } from '../features/records/useRecordsTree';
import type { ClassItem, RecordsTreeNode } from '../features/records/types';
import { activityApi, classesApi, claudeBatchApi, lessonPlansApi, type AcademicSubjectScope } from '../lib/api';
import { openDirectory, saveBlob } from '../lib/desktopFiles';
import { useRecordsUnsavedStore } from '../stores/recordsUnsavedStore';

interface ActivityDate { id: number; activity_date: string; lesson_no: number; progress: string; journal: string; source_mode: string; pending_file_count: number; updated_at?: string }
interface ActivityFile { id: number; filename: string; summarized_at: string }
interface StudentRow { id: number; student_num: number; name: string; summary: string; saved_summary: string; is_absent: number; observation: string; topic: string; plus_text: string; minus_text: string; interesting_text: string; semester_summary?: string; files: ActivityFile[] }
interface PlanRow { lessonNo: number; progress: string }
type ActivityView = 'activity' | 'observation' | 'reflection' | 'comprehensive';
const ArtifactPreviewModal = lazy(() => import('../components/ArtifactPreviewModal'));

const scopeOf = (item: ClassItem): AcademicSubjectScope => ({ year: item.year, semester: item.semester, grade: item.grade, subject: item.subject });
function nextDateAfter(value?: string) {
  const date = value ? new Date(`${value}T12:00:00`) : new Date();
  if (value) date.setDate(date.getDate() + 1);
  return date.toISOString().slice(0, 10);
}
const classAndSeat = (studentNum: number) => ({ classNum: Math.floor((studentNum % 10000) / 100), seatNum: studentNum % 100 });

export default function ActivityPage() {
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [classId, setClassId] = useState(0);
  const [dates, setDates] = useState<ActivityDate[]>([]);
  const [savedDates, setSavedDates] = useState<ActivityDate[]>([]);
  const [selectedDate, setSelectedDate] = useState('all');
  const [tables, setTables] = useState<Record<string, StudentRow[]>>({});
  const [savedTables, setSavedTables] = useState<Record<string, StudentRow[]>>({});
  const [rosterStudents, setRosterStudents] = useState<StudentRow[]>([]);
  const [views, setViews] = useState<Set<ActivityView>>(() => new Set(['activity']));
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [selectedStudentIds, setSelectedStudentIds] = useState<Set<number>>(new Set());
  const [settings, setSettings] = useState<any>(null);
  const [planRows, setPlanRows] = useState<PlanRow[]>([]);
  const [linkedSubjects, setLinkedSubjects] = useState<Record<string, boolean>>({});
  const [previewArtifact, setPreviewArtifact] = useState<PreviewArtifact | null>(null);
  const [uploadingCell, setUploadingCell] = useState('');
  const [batchJobs, setBatchJobs] = useState<ClaudeBatchResultJob[]>([]);
  const [showBatchResults, setShowBatchResults] = useState(false);
  const [receivingBatchId, setReceivingBatchId] = useState('');
  const [saving, setSaving] = useState(false);
  const backupInputRef = useRef<HTMLInputElement>(null);
  const { tableRef, columnWidths, rowHeights, handleColumnResizeStart, handleRowResizeStart, renderCellResizeHandles } = useResizableTable<number>({ defaultRowHeight: 80 });
  const frozenLayout = recordsFrozenLayout(columnWidths);
  const selectedClass = classes.find(item => item.id === classId);
  const selectedDateRow = dates.find(item => item.activity_date === selectedDate);
  const recordsTree = useRecordsTree(classes);
  const excelMode = settings?.record_mode === 'excel';
  const setHasUnsavedChanges = useRecordsUnsavedStore(state => state.setHasUnsavedChanges);

  const subjectKey = (scope: AcademicSubjectScope) => `${scope.year}:${scope.semester}:${scope.grade}:${scope.subject}`;
  const loadLinkedSubjects = async () => {
    const { data } = await lessonPlansApi.getSubjects();
    setLinkedSubjects(Object.fromEntries((data as any[]).map(item => [subjectKey(item), !!item.has_source])));
  };

  const loadSettings = async (item = selectedClass) => {
    if (!item) return;
    const { data } = await lessonPlansApi.getPlans(scopeOf(item));
    setSettings(data.settings);
    setPlanRows((data.rows || []) as PlanRow[]);
  };
  const loadDates = async (targetClassId = classId) => {
    if (!targetClassId) return [] as ActivityDate[];
    const { data } = await activityApi.getDates(targetClassId);
    const rows = data as ActivityDate[];
    setDates(rows);
    setSavedDates(rows);
    setSelectedDate(current => current === 'all' || rows.some(row => row.activity_date === current) ? current : 'all');
    return rows;
  };
  const loadBatchJobs = async (targetClassId = classId) => {
    if (!targetClassId) return;
    const { data } = await claudeBatchApi.list(targetClassId);
    setBatchJobs((data.jobs || []).filter((job: ClaudeBatchResultJob) => job.contentType === 'activity'));
  };
  const loadRoster = async (targetClassId = classId) => {
    if (!targetClassId) return [] as StudentRow[];
    const { data } = await classesApi.getStudents(targetClassId);
    const rows = (data as Array<{ id: number; student_num: number; name: string }>).map(student => ({
      ...student, summary: '', saved_summary: '', is_absent: 0, observation: '', topic: '',
      plus_text: '', minus_text: '', interesting_text: '', semester_summary: '', files: [],
    }));
    setRosterStudents(rows);
    return rows;
  };
  const loadTables = async (targetDates = dates, targetDate = selectedDate) => {
    if (!classId) return;
    const draftKeys = new Set(targetDates.filter(row => row.id < 0).map(row => String(row.id)));
    const actualDates = targetDates.filter(row => row.id > 0);
    const wanted = targetDate === 'all' ? actualDates : actualDates.filter(row => row.activity_date === targetDate);
    const responses = await Promise.all(wanted.map(row => activityApi.getTable(classId, row.activity_date)));
    const next: Record<string, StudentRow[]> = Object.fromEntries(responses.map(response => [String(response.data.date.id), response.data.students as StudentRow[]]));
    setTables(current => ({ ...Object.fromEntries(Object.entries(current).filter(([key]) => draftKeys.has(key))), ...next }));
    setSavedTables(structuredClone(next));
    setSelectedStudentIds(new Set(Object.values(next).flat().filter(student => student.files?.some(file => !file.summarized_at)).map(student => student.id)));
  };
  const refresh = async () => {
    if (!classId) return;
    if (!canDiscardChanges()) return;
    if (isDirty) discardChanges();
    setBusy(true);
    try {
      const rows = await loadDates();
      await Promise.all([loadSettings(), loadTables(rows, selectedDate), loadBatchJobs()]);
    } catch (error: any) { alert(error?.response?.data?.error || '활동 기록을 새로고침하지 못했습니다.'); }
    finally { setBusy(false); }
  };

  useEffect(() => {
    void loadLinkedSubjects();
    classesApi.getAll().then(({ data }) => {
      setClasses(data);
      if (data[0]) setClassId(data[0].id);
    });
  }, []);
  useEffect(() => {
    setDates([]); setSavedDates([]); setTables({}); setSavedTables({}); setRosterStudents([]); setSelectedDate('all'); setSettings(null); setPlanRows([]); setBatchJobs([]); setShowBatchResults(false);
    const item = classes.find(row => row.id === classId);
    if (classId && item) void Promise.all([loadDates(classId), loadSettings(item), loadBatchJobs(classId), loadRoster(classId)]);
  }, [classId, classes.length]);
  useEffect(() => {
    if (classId && dates.length) void loadTables();
    else setTables({});
  }, [classId, selectedDate, dates.filter(row => row.id > 0).map(row => `${row.id}:${row.updated_at || ''}`).join('|')]);
  useEffect(() => subscribeLessonJournalLinkChanged(detail => {
    setLinkedSubjects(current => ({ ...current, [subjectKey(detail.scope)]: detail.linked }));
    if (selectedClass && subjectKey(scopeOf(selectedClass)) === subjectKey(detail.scope)) void loadSettings(selectedClass);
  }), [selectedClass?.id]);

  const editableDates = (value: ActivityDate[]) => value.map(date => ({ id: date.id, activity_date: date.activity_date, lesson_no: date.lesson_no, journal: date.journal }));
  const editableTables = (value: Record<string, StudentRow[]>) => Object.fromEntries(Object.entries(value).map(([date, rows]) => [date, rows.map(row => ({ id: row.id, summary: row.summary, is_absent: row.is_absent, observation: row.observation, semester_summary: row.semester_summary || '' }))]));
  const isDirty = useMemo(() => JSON.stringify(editableDates(dates)) !== JSON.stringify(editableDates(savedDates))
    || JSON.stringify(editableTables(tables)) !== JSON.stringify(editableTables(savedTables)), [dates, savedDates, tables, savedTables]);
  const canDiscardChanges = () => !isDirty || confirm('저장되지 않은 활동 기록 변경 사항이 있습니다. 이동하시겠습니까?');
  useEffect(() => {
    setHasUnsavedChanges(isDirty);
    window.__hasUnsavedChanges = isDirty;
    return () => {
      setHasUnsavedChanges(false);
      window.__hasUnsavedChanges = false;
    };
  }, [isDirty, setHasUnsavedChanges]);
  useEffect(() => {
    if (!isDirty) return;
    const handler = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  const visibleDates = selectedDate === 'all' ? dates : dates.filter(row => row.activity_date === selectedDate);
  const students = useMemo(() => {
    const byId = new Map<number, StudentRow>(rosterStudents.map(student => [student.id, student]));
    Object.values(tables).flat().forEach(student => byId.set(student.id, student));
    return [...byId.values()].sort((a, b) => a.student_num - b.student_num);
  }, [rosterStudents, tables]);
  const allStudentsSelected = students.length > 0 && students.every(student => selectedStudentIds.has(student.id));
  const toggleAllStudents = () => setSelectedStudentIds(allStudentsSelected ? new Set() : new Set(students.map(student => student.id)));
  const toggleStudentSelection = (studentId: number) => setSelectedStudentIds(current => {
    const next = new Set(current);
    if (next.has(studentId)) next.delete(studentId); else next.add(studentId);
    return next;
  });
  const rowFor = (studentId: number, dateId: number) => tables[String(dateId)]?.find(row => row.id === studentId);
  const planProgress = (lessonNo: number) => planRows.find(row => Number(row.lessonNo) === Number(lessonNo))?.progress || '';
  const insertDate = (index: number) => {
    if (excelMode) return;
    const previous = dates[index - 1];
    const following = dates[index];
    let date = previous ? nextDateAfter(previous.activity_date) : following
      ? new Date(new Date(`${following.activity_date}T12:00:00`).getTime() - 86400000).toISOString().slice(0, 10)
      : nextDateAfter();
    while (dates.some(item => item.activity_date === date)) date = nextDateAfter(date);
    const lessonNo = previous ? Number(previous.lesson_no) + 1 : Math.max(1, Number(following?.lesson_no || 2) - 1);
    const draft: ActivityDate = { id: -Date.now(), activity_date: date, lesson_no: lessonNo, progress: planProgress(lessonNo), journal: '', source_mode: 'app', pending_file_count: 0 };
    setDates(current => [...current.slice(0, index), draft, ...current.slice(index)]);
    setTables(current => ({ ...current, [String(draft.id)]: structuredClone(rosterStudents) }));
    setSelectedDate('all');
  };
  const updateDate = (id: number, patch: Partial<ActivityDate>) => {
    const currentDate = dates.find(date => date.id === id);
    if (patch.activity_date && currentDate && selectedDate === currentDate.activity_date) setSelectedDate(patch.activity_date);
    setDates(current => current.map(date => {
      if (date.id !== id) return date;
      const next = { ...date, ...patch };
      if (patch.lesson_no != null) next.progress = planProgress(Number(patch.lesson_no));
      return next;
    }));
  };
  const saveAll = async () => {
    if (!classId || saving || !isDirty) return;
    if (dates.some(date => !/^\d{4}-\d{2}-\d{2}$/.test(date.activity_date) || Number(date.lesson_no) <= 0)) return alert('날짜와 차시를 확인해 주세요.');
    if (new Set(dates.map(date => date.activity_date)).size !== dates.length) return alert('같은 날짜의 수업을 두 번 만들 수 없습니다.');
    setSaving(true);
    try {
      const persistedDates = [...dates];
      const persistedTables = { ...tables };
      for (let index = 0; index < persistedDates.length; index += 1) {
        const date = persistedDates[index];
        if (date.id < 0) {
          const { data } = await activityApi.addDate(classId, { date: date.activity_date, lessonNo: date.lesson_no, journal: date.journal });
          const savedDate = { ...date, id: Number(data.id) };
          persistedDates[index] = savedDate;
          persistedTables[String(savedDate.id)] = persistedTables[String(date.id)] || [];
          delete persistedTables[String(date.id)];
        }
        else {
          const saved = savedDates.find(item => item.id === date.id);
          if (saved && (saved.activity_date !== date.activity_date || saved.lesson_no !== date.lesson_no || saved.journal !== date.journal)) {
            await activityApi.updateDate(classId, date.id, { date: date.activity_date, lessonNo: date.lesson_no, journal: date.journal });
          }
        }
      }
      for (const date of persistedDates) {
        const currentRows = persistedTables[String(date.id)] || [];
        const baseline = new Map((savedTables[String(date.id)] || []).map(row => [row.id, row]));
        for (const row of currentRows) {
          const saved = baseline.get(row.id);
          if (!saved || row.summary !== saved.summary) await activityApi.saveSummary(classId, { studentId: row.id, date: date.activity_date, summary: row.summary || '' });
          if (!excelMode && (!saved || row.is_absent !== saved.is_absent || row.observation !== saved.observation)) {
            await activityApi.saveObservation(classId, { studentId: row.id, date: date.activity_date, isAbsent: !!row.is_absent, note: row.observation || '' });
          }
        }
      }
      const rows = await loadDates();
      await Promise.all([loadSettings(), loadTables(rows, selectedDate)]);
    } catch (error: any) { alert(error?.response?.data?.error || '활동 기록을 저장하지 못했습니다.'); }
    finally { setSaving(false); }
  };
  const deleteDate = async (date: ActivityDate) => {
    if (date.id < 0) {
      setDates(current => current.filter(item => item.id !== date.id));
      setTables(current => {
        const next = { ...current };
        delete next[String(date.id)];
        return next;
      });
      return;
    }
    if (isDirty && !confirm('저장되지 않은 다른 변경 사항이 있습니다. 변경 사항을 취소하고 날짜를 삭제하시겠습니까?')) return;
    if (!confirm(`${date.activity_date} 날짜를 삭제하시겠습니까?`)) return;
    try {
      discardChanges();
      await activityApi.deleteDate(classId, date.id);
      setSelectedDate('all');
      const rows = await loadDates();
      await loadTables(rows, 'all');
    }
    catch (error: any) { alert(error?.response?.data?.error || '날짜를 삭제하지 못했습니다.'); }
  };
  const importZip = async (file?: File) => {
    if (!file || !classId) return;
    if (isDirty) return alert('변경한 활동 기록을 먼저 저장해 주세요.');
    if (views.has('reflection') && !views.has('activity') && selectedDate !== 'all') return alert('성찰 기록 업로드는 전체 날짜 보기에서 사용할 수 있습니다.');
    setBusy(true);
    try {
      const targetDate = selectedDate === 'all' ? '' : selectedDate;
      let response;
      try { response = await activityApi.importZip(classId, file, targetDate); }
      catch (error: any) {
        if (error?.response?.status !== 409 || error?.response?.data?.code !== 'DATE_FOLDERS_FOUND') throw error;
        if (!confirm(`${error.response.data.error}\n\n날짜 폴더를 무시하고 ${targetDate} 산출물로 계속 업로드하시겠습니까?`)) return;
        response = await activityApi.importZip(classId, file, targetDate, true);
      }
      setResult(response.data);
      await refresh();
    }
    catch (error: any) { alert(error?.response?.data?.error || '산출물을 불러오지 못했습니다.'); }
    finally { setBusy(false); }
  };
  const importFolder = async (selectedFolder?: string) => {
    if (!classId) return;
    if (isDirty) return alert('변경한 활동 기록을 먼저 저장해 주세요.');
    if (views.has('reflection') && !views.has('activity') && selectedDate !== 'all') return alert('성찰 기록 업로드는 전체 날짜 보기에서 사용할 수 있습니다.');
    const folder = selectedFolder || await openDirectory();
    if (folder === null) return alert('폴더 업로드는 데스크톱 앱에서 사용할 수 있습니다.');
    if (!folder) return;
    setBusy(true);
    try {
      const targetDate = selectedDate === 'all' ? '' : selectedDate;
      let response;
      try { response = await activityApi.importFolder(classId, folder, targetDate); }
      catch (error: any) {
        if (error?.response?.status !== 409 || error?.response?.data?.code !== 'DATE_FOLDERS_FOUND') throw error;
        if (!confirm(`${error.response.data.error}\n\n날짜 폴더를 무시하고 ${targetDate} 산출물로 계속 업로드하시겠습니까?`)) return;
        response = await activityApi.importFolder(classId, folder, targetDate, true);
      }
      setResult(response.data);
      await refresh();
    }
    catch (error: any) { alert(error?.response?.data?.error || '산출물 폴더를 불러오지 못했습니다.'); }
    finally { setBusy(false); }
  };
  const uploadStudentFiles = async (student: StudentRow, date: ActivityDate, files: File[]) => {
    const key = `${student.id}:${date.id}`;
    setUploadingCell(key);
    try {
      await activityApi.uploadFiles(classId, student.id, date.activity_date, files);
      const { data } = await activityApi.getTable(classId, date.activity_date);
      const refreshed = (data.students as StudentRow[]).find(item => item.id === student.id);
      if (refreshed) {
        const tableKey = String(date.id);
        setTables(current => ({ ...current, [tableKey]: (current[tableKey] || []).map(item => item.id === student.id ? refreshed : item) }));
        setSavedTables(current => ({ ...current, [tableKey]: (current[tableKey] || []).map(item => item.id === student.id ? refreshed : item) }));
        setSelectedStudentIds(current => new Set(current).add(student.id));
      }
    } catch (error: any) {
      alert(error?.response?.data?.error || '학생 산출물을 업로드하지 못했습니다.');
    } finally { setUploadingCell(''); }
  };
  const downloadJournal = async () => {
    if (!selectedClass) return;
    try {
      const { data } = await lessonPlansApi.exportJournal(scopeOf(selectedClass));
      await saveBlob(`${selectedClass.year} ${selectedClass.grade}학년 ${selectedClass.subject} 일지.xlsx`, data);
    } catch (error: any) { alert(error?.response?.data?.error || '일지 파일을 다운로드하지 못했습니다.'); }
  };
  const uploadBackup = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !selectedClass || !confirm('현재 과목의 수업 계획과 기준을 백업 파일 내용으로 덮어쓰시겠습니까?')) return;
    setBusy(true);
    try { await lessonPlansApi.importBackup(scopeOf(selectedClass), file); await refresh(); }
    catch (error: any) { alert(error?.response?.data?.error || '백업 업로드에 실패했습니다.'); }
    finally { setBusy(false); }
  };
  const downloadBackup = async () => {
    if (!selectedClass) return;
    try {
      const { data } = await lessonPlansApi.exportBackup(scopeOf(selectedClass));
      await saveBlob(`${selectedClass.year}학년도 ${selectedClass.semester}학기 ${selectedClass.grade}학년 ${selectedClass.subject} 작업 백업.xlsx`, data);
    } catch (error: any) { alert(error?.response?.data?.error || '백업 다운로드에 실패했습니다.'); }
  };
  const startRecord = async (requestMode: 'immediate' | 'batch') => {
    if (!classId) return;
    if (isDirty) return alert('변경한 활동 기록을 먼저 저장해 주세요.');
    const runModes: Array<'date' | 'semester'> = [];
    if (views.has('activity')) runModes.push('date');
    if (views.has('comprehensive')) runModes.push('semester');
    const targets = !selectedDateRow || !selectedStudentIds.size ? undefined : [...selectedStudentIds].map(studentId => ({ studentId, activityDateId: selectedDateRow.id }));
    setBusy(true);
    try {
      const request = requestMode === 'immediate' ? activityApi.generate : activityApi.startBatch;
      const responses = await Promise.all(runModes.map(mode => request(classId, { targets: mode === 'date' ? targets : undefined, mode })));
      const requestCount = responses.reduce((sum, response) => sum + Number(response.data.requestCount || 0), 0);
      alert(requestCount ? `${requestCount}건을 ${requestMode === 'immediate' ? '즉시' : '배치'} 요청했습니다.` : '요청할 기록이 없습니다.');
      if (requestMode === 'immediate') await refresh();
      else await loadBatchJobs();
    } catch (error: any) { alert(error?.response?.data?.error || '기록 요청에 실패했습니다.'); }
    finally { setBusy(false); }
  };
  const receiveBatchResult = async (job: ClaudeBatchResultJob) => {
    setReceivingBatchId(job.id);
    try {
      const response = await claudeBatchApi.receive(job.providerBatchIds || [job.id]);
      alert(response.data.inProgress ? '아직 처리 중인 배치가 있습니다.' : '활동 기록 배치 결과를 반영했습니다.');
      await Promise.all([refresh(), loadBatchJobs()]);
    } catch (error: any) { alert(error?.response?.data?.error || '배치 결과를 가져오지 못했습니다.'); }
    finally { setReceivingBatchId(''); }
  };
  const toggleView = (value: ActivityView) => setViews(current => {
    const next = new Set(current);
    if (next.has(value)) {
      if (next.size > 1) next.delete(value);
    } else next.add(value);
    return next;
  });
  const discardChanges = () => {
    setDates(savedDates);
    setTables(structuredClone(savedTables));
  };
  const selectClass = (nextClassId: number) => {
    if (nextClassId === classId) return;
    if (!canDiscardChanges()) return;
    discardChanges();
    setClassId(nextClassId);
  };
  const selectDate = (nextDate: string) => {
    if (nextDate === selectedDate) return;
    if (!canDiscardChanges()) return;
    discardChanges();
    setSelectedDate(nextDate);
  };
  const deleteSelectedContent = async () => {
    if (!classId || !selectedStudentIds.size) return alert('내용을 삭제할 학생 행을 선택해 주세요.');
    if (!canDiscardChanges()) return;
    if (isDirty) discardChanges();
    const selectedViews = [...views];
    const targetDates = visibleDates.filter(date => date.id > 0).map(date => date.activity_date);
    if (!confirm(`선택한 ${selectedStudentIds.size}명의 현재 보기 내용을 삭제하시겠습니까?\n학생, 수업과 산출물 파일은 유지됩니다.`)) return;
    setBusy(true);
    try {
      await activityApi.deleteContent(classId, { studentIds: [...selectedStudentIds], dates: targetDates, views: selectedViews });
      const rows = await loadDates();
      await loadTables(rows, selectedDate);
    } catch (error: any) { alert(error?.response?.data?.error || '선택한 내용을 삭제하지 못했습니다.'); }
    finally { setBusy(false); }
  };

  const sidebar = {
    title: '활동 기록 관리', collapsed: recordsTree.collapsed,
    titleAction: <button type="button" className={`inline-flex h-8 w-8 items-center justify-center rounded border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 ${recordsTree.collapsed ? 'mx-auto' : 'ml-auto'}`} onClick={recordsTree.toggleCollapsed}>{recordsTree.collapsed ? <PanelLeftOpen size={15}/> : <PanelLeftClose size={15}/>}</button>,
    tree: recordsTree.collapsed ? <RecordsCollapsedTree classes={classes} selectedClassId={classId} getNodeOpen={recordsTree.getNodeOpen} onToggleOpen={recordsTree.toggleNodeOpen} onSelectClass={item => selectClass(item.id)}/> : {
      nodes: recordsTree.tree,
      empty: <p className="py-8 text-center text-xs text-gray-400">채점 기록 관리에 등록된 수업이 없습니다.</p>,
      node: {
        selected: (item: RecordsTreeNode) => item.kind === 'room' && classId === item.classItem?.id,
        clickable: (item: RecordsTreeNode) => item.kind === 'room' && !!item.classItem,
        onSelect: (item: RecordsTreeNode) => item.classItem && selectClass(item.classItem.id),
        actions: (item: RecordsTreeNode) => item.kind === 'subject' && item.year && item.semester && item.grade && item.subject ? [{
          title: linkedSubjects[subjectKey({ year: item.year!, semester: item.semester!, grade: item.grade!, subject: item.subject! })] ? '수업 일지 엑셀 연결 관리' : '수업 일지 엑셀 연결',
          icon: 'link' as const,
          variant: linkedSubjects[subjectKey({ year: item.year!, semester: item.semester!, grade: item.grade!, subject: item.subject! })] ? 'blue' as const : 'neutral' as const,
          visible: 'hover' as const,
          onClick: () => openLessonJournalLinkDialog({ year: item.year!, semester: item.semester!, grade: item.grade!, subject: item.subject! }),
        }] : [],
        openStates: recordsTree.openStates, onToggleOpen: recordsTree.toggleNodeOpen,
      },
    },
  };

  const leading = <div className="flex min-w-0 items-center gap-2">
    <HeaderViewToggleGroup options={([['activity','활동'],['observation','관찰'],['reflection','성찰'],['comprehensive','종합']] as const).map(([value,label]) => ({ value, label, active: views.has(value) }))} onToggle={toggleView}/>
    <HeaderFilterSelect value={selectedDate} onChange={event => selectDate(event.target.value)} disabled={!views.has('activity') && !views.has('observation') && !views.has('reflection')}><option value="all">전체 날짜 보기</option>{dates.filter(date => date.id > 0).map(date => <option key={date.id} value={date.activity_date}>{date.activity_date} · {date.lesson_no}차시 · {date.progress || '진도 없음'}{date.pending_file_count ? ` · 새 파일 ${date.pending_file_count}개` : ''}</option>)}</HeaderFilterSelect>
  </div>;
  const generationLabel = views.size === 1
    ? views.has('activity') ? '기록' : views.has('comprehensive') ? '작성' : null
    : null;
  const headerActions: PageHeaderAction[] = [
    { key: 'refresh', icon: <RefreshCw size={14}/>, onClick: () => void refresh(), disabled: busy, title: '새로고침', ariaLabel: '새로고침' },
    ...((views.has('activity') || views.has('reflection')) ? [{ key: 'artifacts', type: 'custom' as const, render: () => <HeaderImportMenu loading={busy} disabled={busy} onZip={file => importZip(file)} onFolder={folderPath => importFolder(folderPath)}/> }] : []),
    ...(generationLabel ? [{ key: 'record', type: 'custom' as const, render: () => <ExecutionModeMenu label={generationLabel} onImmediate={() => void startRecord('immediate')} onBatch={() => void startRecord('batch')} disabled={busy} immediateTitle={`즉시 ${generationLabel}`} batchTitle={`배치 ${generationLabel}`}/> }] : []),
    ...(batchJobs.length ? [{ key: 'batch-results', label: `결과 (${batchJobs.length})`, onClick: () => setShowBatchResults(true), disabled: busy }] : []),
    { key: 'save', label: saving ? '저장 중...' : '저장', icon: <Save size={14}/>, variant: 'primary', onClick: () => void saveAll(), disabled: saving || busy || !isDirty },
    { key: 'delete-content', icon: <Trash2 size={14}/>, variant: 'danger', title: '선택한 행의 내용 삭제', ariaLabel: '선택한 행의 내용 삭제', onClick: () => void deleteSelectedContent(), disabled: busy || !selectedStudentIds.size },
    { key: 'download', icon: <Download size={14}/>, variant: 'success', title: '활동 기록 다운로드', ariaLabel: '활동 기록 다운로드', onClick: () => void downloadJournal(), disabled: !selectedClass },
    { key: 'backup-upload', type: 'file', icon: <Upload size={14}/>, inputRef: backupInputRef, accept: '.xlsx', onChange: uploadBackup, disabled: busy || !selectedClass, title: '복원', ariaLabel: '활동 기록 복원' },
    { key: 'backup-download', icon: <Download size={14}/>, onClick: () => void downloadBackup(), disabled: !selectedClass, title: '백업', ariaLabel: '활동 기록 백업' },
  ];
  const hasDateViews = views.has('activity') || views.has('observation') || views.has('reflection');
  type ActivityColumnKind = 'files' | 'activity' | 'absent' | 'observation' | 'reflection';
  const columnTemplates: Array<{ kind: ActivityColumnKind; label: string; width: number; enabled: boolean }> = [
    { kind: 'files', label: '산출물', width: 56, enabled: views.has('activity') },
    { kind: 'activity', label: '활동 기록', width: 200, enabled: views.has('activity') },
    { kind: 'absent', label: '결석', width: 64, enabled: views.has('observation') },
    { kind: 'observation', label: '관찰 기록', width: 200, enabled: views.has('observation') },
    { kind: 'reflection', label: '성찰 기록', width: 200, enabled: views.has('reflection') },
  ];
  const enabledTemplates = columnTemplates.filter(column => column.enabled);
  const dateColumnCount = enabledTemplates.length;
  const dataColumns = visibleDates.flatMap(date => enabledTemplates.map(column => ({ ...column, date, key: `${date.id}-${column.kind}` })));
  const comprehensiveWidth = columnWidths._comprehensive ?? 320;
  const tableColumnWidths = [frozenLayout.width.chk, frozenLayout.width.cls, frozenLayout.width.num, frozenLayout.width.name, ...dataColumns.map(column => columnWidths[column.key] ?? column.width), ...(views.has('comprehensive') ? [comprehensiveWidth] : [])];
  const tableTotalWidth = tableColumnWidths.reduce((sum, width) => sum + width, 0);
  const dateSubHeaders = (date: ActivityDate, visibleIndex: number) => <>{dataColumns.filter(column => column.date.id === date.id).map((column, columnIndex, dateColumns) => {
    const width = columnWidths[column.key] ?? column.width;
    const dateIndex = dates.findIndex(item => item.id === date.id);
    return <th key={column.key} className="group/lesson-insert relative border-b border-r px-2 py-1.5 text-center font-medium text-gray-600 select-none" style={{ width, minWidth: width }}>{column.label}
      {!excelMode && columnIndex === 0 && <button type="button" className="absolute bottom-0 left-0 z-30 -translate-x-1/2 translate-y-1/2 rounded-full border border-blue-200 bg-white p-0.5 text-blue-600 opacity-0 shadow-sm transition-opacity hover:bg-blue-50 group-hover/lesson-insert:opacity-100 focus:opacity-100" title="왼쪽에 수업 추가" onClick={() => insertDate(dateIndex)}><Plus size={12}/></button>}
      {!excelMode && visibleIndex === visibleDates.length - 1 && columnIndex === dateColumns.length - 1 && <button type="button" className="absolute bottom-0 right-0 z-30 translate-x-1/2 translate-y-1/2 rounded-full border border-blue-200 bg-white p-0.5 text-blue-600 opacity-0 shadow-sm transition-opacity hover:bg-blue-50 group-hover/lesson-insert:opacity-100 focus:opacity-100" title="오른쪽에 수업 추가" onClick={() => insertDate(dateIndex + 1)}><Plus size={12}/></button>}
      <div className="records-table-column-resize-handle absolute bottom-0 right-0 top-0 z-10 cursor-col-resize bg-transparent" onMouseDown={event => handleColumnResizeStart(event, column.key, column.width)}/>
    </th>;
  })}</>;
  const dateCells = (student: StudentRow, date: ActivityDate) => {
    const row = rowFor(student.id, date.id);
    if (!row) return <td key={`${date.id}-empty`} className="border p-2 text-gray-300" colSpan={dateColumnCount}>-</td>;
    const pendingFiles = row.files?.some(file => !file.summarized_at);
    return <>{dataColumns.filter(column => column.date.id === date.id).map(column => {
      const width = columnWidths[column.key] ?? column.width;
      let content: React.ReactNode = '-';
      const tableKey = String(date.id);
      const savedRow = savedTables[tableKey]?.find(item => item.id === row.id);
      if (column.kind === 'files') content = <CompactArtifactCell files={row.files || []} pending={pendingFiles} uploading={uploadingCell === `${student.id}:${date.id}`} onPreview={file => setPreviewArtifact({ id: file.id, filename: file.filename, source: 'activity' })} onUpload={files => uploadStudentFiles(student, date, files)}/>;
      if (column.kind === 'activity') content = <StableTextarea className={`textarea h-full min-h-20 w-full ${row.summary !== savedRow?.summary ? 'border-amber-300 bg-amber-50' : ''}`} value={row.summary || ''} onChange={event => setTables(current => ({ ...current, [tableKey]: current[tableKey].map(item => item.id === row.id ? { ...item, summary: event.target.value } : item) }))}/>;
      if (column.kind === 'absent') content = <input type="checkbox" checked={!!row.is_absent} disabled={excelMode} onChange={event => setTables(current => ({ ...current, [tableKey]: current[tableKey].map(item => item.id === row.id ? { ...item, is_absent: event.target.checked ? 1 : 0 } : item) }))}/>;
      if (column.kind === 'observation') content = excelMode ? <span className="whitespace-pre-wrap">{row.observation || '-'}</span> : <StableTextarea className={`textarea h-full min-h-20 w-full disabled:bg-gray-100 disabled:text-gray-400 ${row.observation !== savedRow?.observation ? 'border-amber-300 bg-amber-50' : ''}`} disabled={!!row.is_absent} value={row.observation || ''} onChange={event => setTables(current => ({ ...current, [tableKey]: current[tableKey].map(item => item.id === row.id ? { ...item, observation: event.target.value } : item) }))}/>;
      if (column.kind === 'reflection') content = row.plus_text || row.minus_text || row.interesting_text
        ? <div className="whitespace-pre-wrap text-xs leading-5"><div><span className="font-medium text-gray-600">Plus:</span> {row.plus_text}</div><div><span className="font-medium text-gray-600">Minus:</span> {row.minus_text}</div><div><span className="font-medium text-gray-600">Interesting:</span> {row.interesting_text}</div></div>
        : <span className="text-gray-300">-</span>;
      return <td key={column.key} className={`relative border-r px-2 py-2 align-top ${column.kind === 'absent' ? 'text-center' : ''} ${column.kind === 'files' && pendingFiles ? 'border-amber-300 bg-amber-50' : ''}`} style={{ width, minWidth: width }}>{content}{renderCellResizeHandles(student.id, column.key, column.width)}</td>;
    })}</>;
  };
  const dateHeader = (date: ActivityDate) => {
    const headerRowKey = -1_000_000_000 - Math.abs(date.id);
    const height = rowHeights[String(headerRowKey)] ?? 168;
    const lastColumn = enabledTemplates[enabledTemplates.length - 1];
    const lastColumnKey = `${date.id}-${lastColumn?.kind || 'activity'}`;
    const lastColumnWidth = lastColumn ? (columnWidths[lastColumnKey] ?? lastColumn.width) : 200;
    return <th key={date.id} colSpan={dateColumnCount} className="relative border-b border-r bg-gray-100/50 px-2 py-2 text-left font-normal text-gray-700" style={{ height }}>
    <div className="grid h-full grid-cols-[34px_minmax(112px,1fr)] items-stretch gap-x-1.5 gap-y-1 text-xs" style={{ gridTemplateRows: '28px 28px minmax(28px, 28fr) minmax(48px, 48fr)' }}>
      <span className="text-[11px] text-gray-400">날짜</span>
      <input type="date" className="input h-full min-h-7 min-w-0 px-1.5 py-0 text-xs disabled:bg-gray-100" disabled={excelMode} value={date.activity_date} onChange={event => updateDate(date.id, { activity_date: event.target.value })}/>
      <span className="text-[11px] text-gray-400">차시</span>
      <input type="number" min="1" className="input h-full min-h-7 w-full min-w-0 px-1.5 py-0 text-xs disabled:bg-gray-100" disabled={excelMode} value={date.lesson_no} onChange={event => updateDate(date.id, { lesson_no: Math.max(1, Number(event.target.value) || 1) })}/>
      <span className="text-[11px] text-gray-400">진도</span>
      <div className="h-full min-h-7 min-w-0 overflow-auto rounded border border-gray-200 bg-gray-50 px-2 py-1 text-xs text-gray-600">{date.progress || '진도 없음'}</div>
      <span className="text-[11px] text-gray-400">일지</span>
      {excelMode ? <div className="h-full min-h-0 overflow-auto whitespace-pre-wrap rounded border border-gray-200 bg-gray-50 px-2 py-1">{date.journal || '-'}</div> : <StableTextarea className="textarea h-full min-h-0 w-full resize-none px-2 py-1 text-xs" value={date.journal || ''} onChange={event => updateDate(date.id, { journal: event.target.value })}/>} 
    </div>
    <div className="records-table-column-resize-handle absolute inset-y-0 right-0 z-20 cursor-col-resize" title="드래그하여 수업 열 너비 조절" onMouseDown={event => handleColumnResizeStart(event, lastColumnKey, lastColumnWidth)}/>
    <div className="records-table-row-resize-handle absolute inset-x-0 bottom-0 z-20 cursor-row-resize" title="드래그하여 날짜·차시·진도·일지 영역 높이 조절" onMouseDown={event => handleRowResizeStart(event, headerRowKey, 168, 160)}/>
  </th>;
  };

  return <PageLayout<RecordsTreeNode> sidebar={sidebar} header={{ leading, actions: <PageHeaderActions actions={headerActions}/> }}>
    <div className="flex-1 overflow-auto scrollbar-stable bg-white pb-32">
      {!selectedClass ? <div className="flex h-full items-center justify-center text-gray-400">왼쪽에서 강의실을 선택하세요.</div> : hasDateViews && !dates.length ? <div className="flex h-full flex-col items-center justify-center gap-3 text-gray-400"><span>표시할 수업이 없습니다.</span>{!excelMode && <button type="button" className="btn-secondary" onClick={() => insertDate(0)}><Plus size={14}/> 수업 추가</button>}</div> : <div className="w-max pr-32"><table ref={tableRef} className="records-table border-collapse text-left text-sm" style={{ tableLayout: 'fixed', width: tableTotalWidth, minWidth: tableTotalWidth }}>
        <colgroup>{tableColumnWidths.map((width, index) => <col key={index} style={{ width, minWidth: width }}/>)}</colgroup>
        <thead className="sticky top-0 z-20 bg-gray-50 shadow-sm"><tr><RecordsFrozenHeader layout={frozenLayout} rowSpan={hasDateViews ? 2 : 1} allSelected={allStudentsSelected} onToggleAll={toggleAllStudents} onResize={handleColumnResizeStart}/>{hasDateViews && visibleDates.map(dateHeader)}{views.has('comprehensive') && <th rowSpan={hasDateViews ? 2 : 1} className="relative border-b border-r bg-amber-50/60 px-4 py-3 text-center font-semibold text-gray-800 select-none" style={{ width: comprehensiveWidth, minWidth: comprehensiveWidth }}>활동 종합 기록<div className="records-table-column-resize-handle absolute bottom-0 right-0 top-0 z-10 cursor-col-resize bg-transparent" onMouseDown={event => handleColumnResizeStart(event, '_comprehensive', 320)}/></th>}</tr>{hasDateViews && <tr>{visibleDates.map((date, index) => <Fragment key={date.id}>{dateSubHeaders(date, index)}</Fragment>)}</tr>}</thead>
        <tbody className="divide-y divide-gray-100">{students.map(student => { const { classNum, seatNum } = classAndSeat(student.student_num); const rowHeight = rowHeights[String(student.id)] ? rowHeights[String(student.id)] + 10 : undefined; return <tr key={student.id} className="records-table-row" style={{ height: rowHeight }}><RecordsFrozenStudentCells layout={frozenLayout} rowKey={student.id} classNum={classNum} studentNum={seatNum} name={student.name} selected={selectedStudentIds.has(student.id)} onToggle={() => toggleStudentSelection(student.id)} renderResizeHandles={renderCellResizeHandles}/>{hasDateViews && visibleDates.map(date => <Fragment key={date.id}>{dateCells(student, date)}</Fragment>)}{views.has('comprehensive') && <td className="relative border-r px-3 py-2 align-top whitespace-pre-wrap" style={{ width: comprehensiveWidth, minWidth: comprehensiveWidth }}>{student.semester_summary || '-'}{renderCellResizeHandles(student.id, '_comprehensive', 320)}</td>}</tr>; })}
          {hasDateViews && visibleDates.length > 0 && <tr className="h-10 bg-gray-50/60"><td colSpan={4} className="border-r"/>{visibleDates.map(date => <td key={`delete-${date.id}`} colSpan={dateColumnCount} className="border-r text-center">{!excelMode && date.source_mode === 'app' && <button type="button" className="rounded p-1.5 text-red-500 hover:bg-red-50" title={`${date.activity_date} 수업 삭제`} aria-label={`${date.activity_date} 수업 삭제`} onClick={() => void deleteDate(date)}><Trash2 size={14}/></button>}</td>)}{views.has('comprehensive') && <td className="border-r"/>}</tr>}
        </tbody>
      </table></div>}
    </div>
    {showBatchResults && selectedClass && <ClaudeBatchResultsDialog
      title="활동 기록 배치 결과"
      subtitle={`${selectedClass.year}학년도 ${selectedClass.semester}학기 ${selectedClass.grade}학년 ${selectedClass.subject} ${selectedClass.room}`}
      jobs={batchJobs}
      kindLabel={job => job.domains.includes('__ACTIVITY_SEMESTER__') ? '활동 종합' : '활동 기록'}
      domainLabel={job => job.domains.includes('__ACTIVITY_SEMESTER__') ? '학기 전체' : '차시별'}
      receivingId={receivingBatchId}
      onReceive={receiveBatchResult}
      onClose={() => setShowBatchResults(false)}
    />}
    <Suspense fallback={null}><ArtifactPreviewModal artifact={previewArtifact} onClose={() => setPreviewArtifact(null)}/></Suspense>
    {result && <BulkImportResultDialog title="산출물 업로드 결과" message={result.message} onClose={() => setResult(null)} results={(result.results || []).filter((item: any) => item.status !== 'unchanged')} stats={[{label:'전체 파일',value:result.total||0},{label:'새 파일',value:result.added||0},{label:'기존 파일 업데이트',value:result.updated||0},{label:'변경 없음',value:result.unchanged||0},{label:'연결 학생',value:result.studentCount||0},{label:'미매칭',value:result.unmatchedCount||0},{label:'날짜 칸 없음',value:result.dateMissingCount||0},{label:'충돌/오류',value:(result.conflictCount||0)+(result.errorCount||0)}]} groupLabel={(key,items) => { if (key === '연결 안 됨') return `연결 안 됨 — ${items.length}개`; const date = dates.find(item => item.activity_date === key); return `${key} · ${date?.lesson_no ?? '-'}차시 · ${date?.progress || '진도 없음'} — 새 파일 ${items.filter(item => item.status === 'added' || item.status === 'updated').length}개`; }}/>} 
  </PageLayout>;
}
