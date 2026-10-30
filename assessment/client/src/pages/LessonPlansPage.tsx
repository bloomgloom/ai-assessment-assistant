import { ChangeEvent, ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, CalendarRange, Download, Plus, RefreshCw, Save, School, Sparkles, Trash2, Upload } from 'lucide-react';
import { AiGenerateBox } from '../components/common/AiGenerateBox';
import { CriteriaEditorPromptView, CriteriaEditorSplit } from '../components/common/CriteriaEditorPanel';
import { PageLayout } from '../components/common/PageLayout';
import { StableTextarea } from '../components/common/StableTextarea';
import { ArtifactSourceFolderField, type ArtifactSourceFolderState } from '../components/common/ArtifactSourceFolder';
import { openLessonJournalLinkDialog, subscribeLessonJournalLinkChanged } from '../components/common/LessonJournalLink';
import { AcademicTreeNode, buildAcademicTree } from '../components/common/academicTree';
import { useResizableTable } from '../components/common/useResizableTable';
import { useAcademicTreeController } from '../hooks/useAcademicTreeController';
import { aiApi, lessonPlansApi, type AcademicSubjectScope } from '../lib/api';
import { saveBlob } from '../lib/desktopFiles';
import { useRecordsUnsavedStore } from '../stores/recordsUnsavedStore';

interface LessonSubject extends AcademicSubjectScope { has_source: number }
interface PlanRow {
  id: string; lessonNo: number; progress: string; content: string; memo: string;
  kind: '개념' | '실습' | '탐구' | '기타'; sourceFiles: string; prompt: string;
}
interface ChatMessage { role: 'user' | 'assistant'; content: string }
interface PlanSettings {
  record_mode: 'app' | 'excel'; source_filename: string; source_filepath: string;
  common_prompt: string; practice_prompt: string; inquiry_prompt: string;
  concept_prompt: string; other_prompt: string; comprehensive_prompt: string;
  record_chat: string; comprehensive_chat: string; source_folder?: string;
}
export type LessonTab = 'plans' | 'records' | 'comprehensive';
interface LessonPlansPageProps {
  embeddedSubject?: AcademicSubjectScope & { has_lesson_source?: number };
  embeddedTab?: LessonTab;
}

const emptySettings: PlanSettings = {
  record_mode: 'app', source_filename: '', source_filepath: '', common_prompt: '', practice_prompt: '',
  inquiry_prompt: '', concept_prompt: '', other_prompt: '', comprehensive_prompt: '',
  record_chat: '[]', comprehensive_chat: '[]',
};
const treePrefixes = { year: 'lpy', semester: 'lps', grade: 'lpg', subject: 'lpsub', domain: 'unused' } as const;
const categoryFields = [
  ['실습', 'practice_prompt'], ['탐구', 'inquiry_prompt'], ['개념', 'concept_prompt'], ['기타', 'other_prompt'],
] as const;
const planColumnDefaults = {
  lessonNo: 80, progress: 240, content: 420, memo: 360,
  kind: 120, sourceFiles: 280, prompt: 420, delete: 48,
} as const;

function sameScope(a: AcademicSubjectScope | null, b: AcademicSubjectScope) {
  return !!a && a.year === b.year && a.semester === b.semester && a.grade === b.grade && a.subject === b.subject;
}

function parseChat(value: string): ChatMessage[] {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.filter(item => item?.role && typeof item.content === 'string') : [];
  } catch { return []; }
}

function parseAiJson(value: unknown) {
  if (typeof value === 'object' && value) return value as any;
  const text = String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(text);
}

function downloadFilename(disposition: string, fallback: string) {
  const utf8 = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  const plain = disposition.match(/filename="?([^";]+)"?/i);
  if (utf8) try { return decodeURIComponent(utf8[1]); } catch { return utf8[1]; }
  return plain?.[1] || fallback;
}

function PromptCard({ label, value, onChange, placeholder, fillHeight = false }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  fillHeight?: boolean;
}) {
  return <div className={`${fillHeight ? 'flex h-full min-h-[420px] flex-col' : 'space-y-3'} rounded-lg border border-purple-200 bg-purple-50 p-4 shadow-sm`}>
    <div className="flex h-9 items-center"><div className="text-sm font-semibold text-purple-800">{label}</div></div>
    <StableTextarea className={`textarea w-full resize-y bg-white text-sm leading-relaxed ${fillHeight ? 'mt-3 min-h-0 flex-1' : 'min-h-[96px]'}`} value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} />
  </div>;
}

function LessonPlansLayout({ embedded, sidebar, header, tabs, children }: {
  embedded: boolean;
  sidebar: any;
  header: any;
  tabs: any;
  children: ReactNode;
}) {
  if (embedded) return <div className="flex h-full min-h-0 flex-col">{children}</div>;
  return <PageLayout sidebar={sidebar} header={header} tabs={tabs}>{children}</PageLayout>;
}

export default function LessonPlansPage({ embeddedSubject, embeddedTab }: LessonPlansPageProps = {}) {
  const embedded = !!embeddedSubject;
  const [subjects, setSubjects] = useState<LessonSubject[]>([]);
  const [selected, setSelected] = useState<LessonSubject | null>(() => embeddedSubject ? { ...embeddedSubject, has_source: Number(embeddedSubject.has_lesson_source || 0) } : null);
  const [settings, setSettings] = useState<PlanSettings>(emptySettings);
  const [rows, setRows] = useState<PlanRow[]>([]);
  const [savedSettings, setSavedSettings] = useState<PlanSettings>(emptySettings);
  const [savedRows, setSavedRows] = useState<PlanRow[]>([]);
  const [missing, setMissing] = useState<string[]>([]);
  const [tab, setTab] = useState<LessonTab>('plans');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [generating, setGenerating] = useState<'plans' | 'records' | 'comprehensive' | null>(null);
  const [chatting, setChatting] = useState<'records' | 'comprehensive' | null>(null);
  const [planInstruction, setPlanInstruction] = useState('');
  const [recordDraft, setRecordDraft] = useState('');
  const [comprehensiveDraft, setComprehensiveDraft] = useState('');
  const backupInputRef = useRef<HTMLInputElement>(null);
  const setHasUnsavedChanges = useRecordsUnsavedStore(state => state.setHasUnsavedChanges);
  const {
    tableRef,
    columnWidths,
    columnWidth,
    rowHeight,
    handleColumnResizeStart,
    renderCellResizeHandles,
    handleKeyNavigation,
  } = useResizableTable<string>({ defaultRowHeight: 72, minRowHeight: 40 });

  const tree = useMemo(() => buildAcademicTree(subjects, {
    keyPrefixes: treePrefixes,
    getDomainEntries: () => [],
    getSubjectNodeSubject: items => items[0],
  }), [subjects]);

  const reloadSubjects = async () => {
    const { data } = await lessonPlansApi.getSubjects();
    const next = data as LessonSubject[];
    setSubjects(next);
    setSelected(current => current ? (next.find(item => sameScope(current, item)) || next[0] || null) : (next[0] || null));
  };
  useEffect(() => { if (!embedded) void reloadSubjects(); }, [embedded]);
  useEffect(() => {
    if (embeddedSubject) setSelected({ ...embeddedSubject, has_source: Number(embeddedSubject.has_lesson_source || 0) });
  }, [embeddedSubject?.year, embeddedSubject?.semester, embeddedSubject?.grade, embeddedSubject?.subject, embeddedSubject?.has_lesson_source]);

  const load = async (scope: AcademicSubjectScope) => {
    try {
      const { data } = await lessonPlansApi.getPlans(scope);
      const nextSettings = { ...emptySettings, ...data.settings } as PlanSettings;
      const nextRows = (data.rows || []) as PlanRow[];
      setSettings(nextSettings);
      setRows(nextRows);
      setSavedSettings(nextSettings);
      setSavedRows(nextRows);
      setMissing(data.missingSourceFiles || []);
    } catch (error: any) {
      alert(error?.response?.data?.error || '수업 계획을 불러오지 못했습니다.');
    }
  };
  useEffect(() => { if (selected) void load(selected); }, [selected?.year, selected?.semester, selected?.grade, selected?.subject, selected?.has_source]);

  const isDirty = JSON.stringify(settings) !== JSON.stringify(savedSettings)
    || (settings.record_mode === 'app' && JSON.stringify(rows) !== JSON.stringify(savedRows));
  useEffect(() => {
    setHasUnsavedChanges(isDirty);
    return () => setHasUnsavedChanges(false);
  }, [isDirty, setHasUnsavedChanges]);
  useEffect(() => {
    if (!isDirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      if ((window as any).__allowNextUnload === true) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);
  const canDiscardChanges = () => !isDirty || confirm('저장되지 않은 수업 계획 변경 사항이 있습니다. 이동하시겠습니까?');

  const subjectTree = useAcademicTreeController<LessonSubject>({
    tree,
    selected: node => node.kind === 'subject' && !!node.subject && sameScope(selected, node.subject),
    clickable: node => node.kind === 'subject' && !!node.subject,
    onSelect: node => { if (node.subject && canDiscardChanges()) setSelected(node.subject); },
    canAdd: () => false,
    actions: node => node.kind === 'subject' && node.subject ? [{
      title: node.subject.has_source ? '수업 일지 엑셀 연결 관리' : '수업 일지 엑셀 연결', icon: 'link', variant: node.subject.has_source ? 'blue' : 'neutral', visible: 'hover',
      onClick: () => openLessonJournalLinkDialog(node.subject!),
    }] : [],
    canDelete: node => node.kind === 'subject' && !!node.subject?.has_source,
    deleteSubject: async subject => {
      if (!canDiscardChanges()) return;
      if (!confirm(`${subject.subject}에 연결된 일지 엑셀을 해제하고 앱 편집으로 전환하시겠습니까? 원본 파일은 삭제되지 않습니다.`)) return;
      await lessonPlansApi.deleteSource(subject);
      await reloadSubjects();
      await load(subject);
    },
  });

  const recordChat = useMemo(() => parseChat(settings.record_chat), [settings.record_chat]);
  const comprehensiveChat = useMemo(() => parseChat(settings.comprehensive_chat), [settings.comprehensive_chat]);
  const setSetting = <K extends keyof PlanSettings>(key: K, value: PlanSettings[K]) => setSettings(current => ({ ...current, [key]: value }));
  const applyArtifactSourceFolder = (state: ArtifactSourceFolderState) => {
    setSettings(current => ({ ...current, source_folder: state.sourceFolder }));
    setSavedSettings(current => ({ ...current, source_folder: state.sourceFolder }));
    setMissing(state.missingSourceFiles || []);
  };
  useEffect(() => subscribeLessonJournalLinkChanged(detail => {
    if (!selected || !sameScope(selected, detail.scope)) return;
    setSelected(current => current ? { ...current, has_source: detail.linked ? 1 : 0 } : current);
    void load(selected);
    if (!embedded) void reloadSubjects();
  }), [selected?.year, selected?.semester, selected?.grade, selected?.subject, embedded]);
  const setChat = (kind: 'records' | 'comprehensive', messages: ChatMessage[]) => setSetting(kind === 'records' ? 'record_chat' : 'comprehensive_chat', JSON.stringify(messages));

  const handleSave = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      await lessonPlansApi.saveSettings(selected, settings as any);
      if (settings.record_mode === 'app') await lessonPlansApi.savePlans(selected, rows);
      await load(selected);
    } catch (error: any) { alert(error?.response?.data?.error || '저장하지 못했습니다.'); }
    finally { setSaving(false); }
  };

  const handleBackupUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !selected || !confirm('현재 과목의 수업 계획과 기준을 백업 파일 내용으로 덮어쓰시겠습니까?')) return;
    setUploading(true);
    try { await lessonPlansApi.importBackup(selected, file); await load(selected); }
    catch (error: any) { alert(error?.response?.data?.error || '백업 업로드에 실패했습니다.'); }
    finally { setUploading(false); }
  };

  const handleBackupDownload = async () => {
    if (!selected) return;
    const response = await lessonPlansApi.exportBackup(selected);
    await saveBlob(downloadFilename(response.headers['content-disposition'] || '', `${selected.subject}_수업계획_백업.xlsx`), response.data);
  };

  const handlePlanDownload = async () => {
    if (!selected) return;
    const response = await lessonPlansApi.exportPlan(selected);
    await saveBlob(downloadFilename(response.headers['content-disposition'] || '', `${selected.year} ${selected.grade}학년 ${selected.subject} 진도.xlsx`), response.data);
  };

  const handleRefresh = async () => {
    if (!selected) return;
    setRefreshing(true);
    try {
      await reloadSubjects();
      await load(selected);
    } finally { setRefreshing(false); }
  };

  const sendChat = async (kind: 'records' | 'comprehensive') => {
    if (!selected || settings.record_mode === 'excel') return;
    const draft = (kind === 'records' ? recordDraft : comprehensiveDraft).trim();
    if (!draft) return;
    const messages = kind === 'records' ? recordChat : comprehensiveChat;
    const next: ChatMessage[] = [...messages, { role: 'user', content: draft }];
    setChat(kind, next);
    kind === 'records' ? setRecordDraft('') : setComprehensiveDraft('');
    setChatting(kind);
    try {
      const response = await aiApi.generatePrompt({
        systemPrompt: `당신은 교사의 ${kind === 'records' ? '학생 활동 기록 기준' : '학기 활동 종합 기준'} 설계를 돕는 AI입니다. 지금은 요구사항을 구체화하는 짧은 대화만 하세요.`,
        prompt: `과목: ${selected.subject}\n\n${next.map(message => `${message.role === 'user' ? '교사' : 'AI'}: ${message.content}`).join('\n')}`,
      });
      setChat(kind, [...next, { role: 'assistant', content: String(response.data.result || '').trim() }]);
    } catch (error: any) { alert(error?.response?.data?.error || '채팅 응답 생성에 실패했습니다.'); }
    finally { setChatting(null); }
  };

  const generatePlans = async () => {
    if (!selected) return;
    setGenerating('plans');
    try {
      const response = await aiApi.generatePrompt({
        systemPrompt: '당신은 교사의 차시별 수업 계획을 설계하는 AI입니다. 실제 수업에서 바로 편집할 수 있는 간결한 차시 계획을 만드세요.',
        prompt: `과목: ${selected.subject}\n학년: ${selected.grade}\n교사 요청: ${planInstruction || '한 학기 차시 계획을 구성해 주세요.'}\n현재 계획: ${JSON.stringify(rows)}`,
        outputSchema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: {
          lessonNo: { type: 'number' }, progress: { type: 'string' }, content: { type: 'string' }, memo: { type: 'string' },
          kind: { type: 'string', enum: ['개념', '실습', '탐구', '기타'] }, sourceFiles: { type: 'string' }, prompt: { type: 'string' },
        }, required: ['lessonNo', 'progress', 'content', 'memo', 'kind', 'sourceFiles', 'prompt'], additionalProperties: false } } }, required: ['items'], additionalProperties: false },
      });
      const parsed = parseAiJson(response.data.result);
      setRows((parsed.items || []).map((item: any) => ({ ...item, id: crypto.randomUUID() })));
    } catch (error: any) { alert(error?.response?.data?.error || '차시 계획 생성에 실패했습니다.'); }
    finally { setGenerating(null); }
  };

  const generateCriteria = async (kind: 'records' | 'comprehensive') => {
    if (!selected) return;
    setGenerating(kind);
    try {
      const messages = kind === 'records' ? recordChat : comprehensiveChat;
      const prompt = `과목: ${selected.subject}\n차시 계획: ${JSON.stringify(rows)}\n대화:\n${messages.map(message => `${message.role}: ${message.content}`).join('\n')}`;
      const outputSchema = kind === 'records'
        ? { type: 'object', properties: {
          common: { type: 'string' }, practice: { type: 'string' }, inquiry: { type: 'string' }, concept: { type: 'string' }, other: { type: 'string' },
        }, required: ['common', 'practice', 'inquiry', 'concept', 'other'], additionalProperties: false }
        : { type: 'object', properties: { common: { type: 'string' } }, required: ['common'], additionalProperties: false };
      const response = await aiApi.generatePrompt({
        systemPrompt: kind === 'records' ? '학생 제출물을 사실 중심으로 요약하기 위한 공통 및 활동 종류별 기록 기준을 작성하세요.' : '학기 전체 활동 기록을 종합하기 위한 공통 기준을 작성하세요.',
        prompt,
        outputSchema,
      });
      const parsed = parseAiJson(response.data.result);
      if (kind === 'records') setSettings(current => ({ ...current, common_prompt: parsed.common, practice_prompt: parsed.practice, inquiry_prompt: parsed.inquiry, concept_prompt: parsed.concept, other_prompt: parsed.other }));
      else setSetting('comprehensive_prompt', parsed.common);
    } catch (error: any) { alert(error?.response?.data?.error || '기준 생성에 실패했습니다.'); }
    finally { setGenerating(null); }
  };

  const locked = settings.record_mode === 'excel';
  const activeLessonTab = embeddedTab || tab;
  const updateRow = (index: number, field: keyof PlanRow, value: string | number) => setRows(current => current.map((row, i) => i === index ? { ...row, [field]: value } : row));
  const insertRow = (index: number) => setRows(current => {
    const lessonNo = index === 0 ? 1 : Math.max(1, Math.trunc(Number(current[index - 1]?.lessonNo || 0))) + 1;
    const row: PlanRow = { id: crypto.randomUUID(), lessonNo, progress: '', content: '', memo: '', kind: '기타', sourceFiles: '', prompt: '' };
    const shifted = current.slice(index).map(item => ({
      ...item,
      lessonNo: Math.max(1, Math.trunc(Number(item.lessonNo || 0))) + 1,
    }));
    return [...current.slice(0, index), row, ...shifted];
  });
  const planWidths = Object.fromEntries(Object.entries(planColumnDefaults).map(([key, width]) => [key, columnWidth(key, width)])) as Record<keyof typeof planColumnDefaults, number>;
  const planTableWidth = Object.values(planWidths).reduce((sum, width) => sum + width, 0);
  const headerActions = selected ? [
    { key: 'refresh', icon: <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />, disabled: refreshing || uploading, onClick: handleRefresh, title: '새로고침', ariaLabel: '새로고침' },
    { key: 'save', label: saving ? '저장 중...' : '저장', icon: <Save size={14} />, variant: 'primary' as const, disabled: saving, onClick: handleSave, title: '저장', ariaLabel: '저장' },
    { key: 'backup-upload', type: 'file' as const, icon: <Upload size={14} />, inputRef: backupInputRef, accept: '.xlsx', onChange: handleBackupUpload, disabled: uploading, title: '복원', ariaLabel: '수업 계획 복원' },
    { key: 'backup-download', icon: <Download size={14} />, onClick: handleBackupDownload, title: '백업', ariaLabel: '수업 계획 백업' },
  ] : undefined;

  useEffect(() => {
    if (!embedded) return;
    const save = () => { void handleSave(); };
    const refresh = () => { void handleRefresh(); };
    const download = () => { void handlePlanDownload(); };
    const uploadBackup = () => { backupInputRef.current?.click(); };
    const downloadBackup = () => { void handleBackupDownload(); };
    window.addEventListener('lesson-plan-save', save);
    window.addEventListener('lesson-plan-refresh', refresh);
    window.addEventListener('lesson-plan-download', download);
    window.addEventListener('lesson-plan-backup-upload', uploadBackup);
    window.addEventListener('lesson-plan-backup-download', downloadBackup);
    return () => {
      window.removeEventListener('lesson-plan-save', save);
      window.removeEventListener('lesson-plan-refresh', refresh);
      window.removeEventListener('lesson-plan-download', download);
      window.removeEventListener('lesson-plan-backup-upload', uploadBackup);
      window.removeEventListener('lesson-plan-backup-download', downloadBackup);
    };
  });

  return <LessonPlansLayout
    embedded={embedded}
    sidebar={{
      title: '수업 계획 관리',
      tree: {
        nodes: subjectTree.visibleTree,
        empty: { icon: <School size={32} />, message: <>평가 영역 관리에 등록된 과목이 없습니다</>, hint: '평가 영역 관리에서 과목을 먼저 업로드해 주세요.' },
        node: subjectTree.nodeConfig,
      },
    }}
    header={{ eyebrow: selected ? `${selected.year}학년도 ${selected.semester}학기 ${selected.grade}학년` : undefined, title: selected?.subject || '수업 계획 관리', actions: headerActions }}
    tabs={selected ? { value: tab, onChange: setTab, tabs: [
      { value: 'plans', label: '차시 계획', icon: <CalendarRange size={14} />, color: 'green' },
      { value: 'records', label: '기록 기준', icon: <BookOpen size={14} />, color: 'blue' },
      { value: 'comprehensive', label: '종합 기준', icon: <Sparkles size={14} />, color: 'purple' },
    ] } : undefined}
  >
    {embedded && <input ref={backupInputRef} type="file" className="hidden" accept=".xlsx" onChange={handleBackupUpload}/>} 
    {!selected ? <div className="flex flex-1 items-center justify-center text-sm text-gray-400">왼쪽 트리에서 과목을 선택하세요.</div> : (
      <div className="flex-1 min-h-0 overflow-hidden px-6 pb-6 pt-6">
        {activeLessonTab === 'plans' && <div className="flex h-full min-h-0 flex-col gap-4">
          <ArtifactSourceFolderField scope={selected} value={settings.source_folder || ''} onChange={applyArtifactSourceFolder}/>
          {locked && <div className="rounded border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-700">{settings.source_filename || '선택한 일지 엑셀'}에서 불러온 차시 계획입니다. 파일 연결을 해제하기 전에는 수정하거나 행을 추가할 수 없습니다.</div>}
          {!locked && <AiGenerateBox label="차시 계획 자동 생성" placeholder="차시 계획 생성을 위한 지시사항을 입력하세요." value={planInstruction} onChange={setPlanInstruction} onGenerate={generatePlans} generating={generating === 'plans'} />}
          {missing.length > 0 && <div className="rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">산출물 원본 파일을 찾지 못했습니다: {missing.join(', ')}</div>}
          <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-gray-200 bg-white scrollbar-stable">
            <div className="w-max pb-16 pl-4 pr-24">
              <table ref={tableRef} className="records-table border-collapse text-left text-xs" style={{ tableLayout: 'fixed', width: planTableWidth, minWidth: planTableWidth }}>
                <colgroup>{(['lessonNo','progress','content','memo','kind','sourceFiles','prompt','delete'] as const).map(key => <col key={key} style={{ width: planWidths[key], minWidth: planWidths[key] }} />)}</colgroup>
                <thead className="sticky top-0 z-20 bg-gray-50 shadow-sm"><tr className="group/plan-head border-b border-gray-200">
                  {([['lessonNo','차시'],['progress','진도'],['content','내용'],['memo','메모'],['kind','종류'],['sourceFiles','산출물'],['prompt','프롬프트'],['delete','']] as const).map(([key,label], columnIndex) => <th key={key} className="relative border-r px-3 py-2 text-center font-medium text-gray-600 select-none" style={{ width: planWidths[key], minWidth: planWidths[key] }}>{label}{columnIndex === 0 && !locked && <button type="button" className="absolute bottom-0 left-0 z-30 -translate-x-1/2 translate-y-1/2 rounded-full border border-blue-200 bg-white p-0.5 text-blue-600 opacity-0 shadow-sm transition-opacity hover:bg-blue-50 group-hover/plan-head:opacity-100 focus:opacity-100" title="맨 위에 행 추가" onClick={() => insertRow(0)}><Plus size={12}/></button>}<div className="records-table-column-resize-handle absolute inset-y-0 right-0 z-10 cursor-col-resize" onMouseDown={event => handleColumnResizeStart(event,key,planColumnDefaults[key])}/></th>)}
                </tr></thead>
                <tbody>
                  {rows.map((row, index) => {
                    const height = rowHeight(row.id);
                    return <tr key={row.id} className="records-table-row group/plan-row border-b border-gray-100 align-top">
                      <td className="group/insert relative border-r p-1">{!locked && index > 0 && <button type="button" className="absolute left-0 top-0 z-20 -translate-x-1/2 -translate-y-1/2 rounded-full border border-blue-200 bg-white p-0.5 text-blue-600 opacity-0 shadow-sm transition-opacity group-hover/insert:opacity-100 focus:opacity-100" title="이 위에 행 추가" onClick={() => insertRow(index)}><Plus size={12}/></button>}<input className="input w-full px-2 text-center text-xs disabled:bg-gray-100 disabled:text-gray-400" style={{ height }} disabled={locked} type="number" min={1} step={1} value={row.lessonNo} onChange={event => updateRow(index,'lessonNo',Math.max(1,Math.trunc(Number(event.target.value)||1)))} data-row={index} data-col={0} onKeyDown={event => handleKeyNavigation(event,index,0)}/>{renderCellResizeHandles(row.id,'lessonNo',planColumnDefaults.lessonNo)}</td>
                      {(['progress','content','memo'] as const).map((field, fieldIndex) => <td key={field} className="relative border-r p-1"><StableTextarea className="textarea w-full resize-none text-xs disabled:bg-gray-100 disabled:text-gray-400" style={{ height, minHeight: 40 }} disabled={locked} value={row[field]} onChange={event => updateRow(index,field,event.target.value)} data-row={index} data-col={fieldIndex+1} onKeyDown={event => handleKeyNavigation(event,index,fieldIndex+1)}/>{renderCellResizeHandles(row.id,field,planColumnDefaults[field])}</td>)}
                      <td className="relative border-r p-1"><select className="input w-full px-2 text-xs disabled:bg-gray-100 disabled:text-gray-400" style={{ height }} disabled={locked} value={row.kind} onChange={event => updateRow(index,'kind',event.target.value)} data-row={index} data-col={4} onKeyDown={event => handleKeyNavigation(event,index,4)}>{['개념','실습','탐구','기타'].map(value => <option key={value}>{value}</option>)}</select>{renderCellResizeHandles(row.id,'kind',planColumnDefaults.kind)}</td>
                      {(['sourceFiles','prompt'] as const).map((field, fieldIndex) => <td key={field} className="relative border-r p-1"><StableTextarea className="textarea w-full resize-none text-xs disabled:bg-gray-100 disabled:text-gray-400" style={{ height, minHeight: 40 }} disabled={locked} value={row[field]} onChange={event => updateRow(index,field,event.target.value)} data-row={index} data-col={fieldIndex+5} onKeyDown={event => handleKeyNavigation(event,index,fieldIndex+5)}/>{renderCellResizeHandles(row.id,field,planColumnDefaults[field])}</td>)}
                      <td className="relative border-r p-1 text-center"><div className="flex items-center justify-center" style={{ height }}>{!locked && <button className="rounded p-1 text-red-400 hover:bg-red-50" title="행 삭제" onClick={() => setRows(current => current.filter((_, i) => i !== index))}><Trash2 size={13}/></button>}</div>{renderCellResizeHandles(row.id,'delete',planColumnDefaults.delete)}</td>
                    </tr>;
                  })}
                  {rows.length === 0 && <tr><td colSpan={8} className="px-4 py-8 text-center text-gray-400">차시 계획이 없습니다.</td></tr>}
                  {!locked && rows.length > 0 && <tr className="group/insert-last h-8"><td className="relative border-r"><button type="button" className="absolute left-0 top-0 z-20 -translate-x-1/2 -translate-y-1/2 rounded-full border border-blue-200 bg-white p-0.5 text-blue-600 opacity-0 shadow-sm transition-opacity group-hover/insert-last:opacity-100 focus:opacity-100" title="맨 아래에 행 추가" onClick={() => insertRow(rows.length)}><Plus size={12}/></button></td><td colSpan={7}/></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </div>}

        {activeLessonTab === 'records' && <CriteriaEditorSplit
          left={<CriteriaEditorPromptView prompt={{ label: '기록 기준 항목 생성', placeholder: '필요한 기록 방식과 강조할 내용을 입력하세요.', messages: recordChat, draft: recordDraft, onDraftChange: setRecordDraft, onSend: () => void sendChat('records'), onGenerate: () => void generateCriteria('records'), onClearChat: () => setChat('records', []), generating: generating === 'records', chatting: chatting === 'records' }} />}
          right={<div className="h-full min-h-0 space-y-4 overflow-auto pb-4 pr-1 scrollbar-stable">
            <PromptCard label="공통" value={settings.common_prompt} onChange={value => setSetting('common_prompt', value)} placeholder="모든 활동 기록에 공통으로 적용할 기준" />
            <div className="space-y-2"><h3 className="text-sm font-semibold text-gray-800">카테고리별 기록 기준</h3>{categoryFields.map(([label, field]) => <PromptCard key={field} label={label} value={settings[field]} onChange={value => setSetting(field, value)} placeholder={`${label} 활동의 기록 기준`} />)}</div>
          </div>}
        />}

        {activeLessonTab === 'comprehensive' && <CriteriaEditorSplit
          left={<CriteriaEditorPromptView prompt={{ label: '종합 기준 생성', placeholder: '학기 종합에서 강조할 관점과 작성 방식을 입력하세요.', generateLabel: '종합 기준 생성', messages: comprehensiveChat, draft: comprehensiveDraft, onDraftChange: setComprehensiveDraft, onSend: () => void sendChat('comprehensive'), onGenerate: () => void generateCriteria('comprehensive'), onClearChat: () => setChat('comprehensive', []), generating: generating === 'comprehensive', chatting: chatting === 'comprehensive' }} />}
          right={<div className="h-full min-h-0"><PromptCard fillHeight label="공통" value={settings.comprehensive_prompt} onChange={value => setSetting('comprehensive_prompt', value)} placeholder="학기 전체 활동을 종합할 때 적용할 공통 기준" /></div>}
        />}
      </div>
    )}
  </LessonPlansLayout>;
}
