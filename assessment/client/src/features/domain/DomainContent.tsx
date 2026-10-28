import { Dispatch, DragEvent, lazy, ReactNode, RefObject, SetStateAction, Suspense, useEffect, useState } from 'react';
import MarkdownIt from 'markdown-it';
import { AlertCircle, ClipboardCheck, Download, Edit3, ExternalLink, Eye, FileText, Link2, Loader2, Plus, RefreshCw, Save, Trash2, Upload, X } from 'lucide-react';
import { AiGenerateBox } from '../../components/common/AiGenerateBox';
import { CriteriaItemCard } from '../../components/common/CriteriaItemCard';
import { StableTextarea } from '../../components/common/StableTextarea';
import { assignmentConfigsApi } from '../../lib/api';
import { downloadUrl, filesToInputChangeEvent, hasDesktopFileDialogs, openFiles, saveBlob } from '../../lib/desktopFiles';
import { DomainCriteriaPanel, DomainCriteriaPromptView, DomainCriteriaSplit } from './DomainCriteriaPanel';
import { AiChatMessage, AssignmentClassSnapshot, AssignmentConfig, AssignmentResource, AssignmentRunDetail, AssignmentRunStudent, AssignmentRunSubmission, AssignmentRunSummary, EvalItem, CommentsItem, StandardRef, SubjectDomainRow, SubjectItem } from './types';

const ArtifactPreviewModal = lazy(() => import('../../components/ArtifactPreviewModal'));

type DomainTab = 'standards' | 'scoring' | 'records' | 'assignment' | 'ratio' | 'comments';

interface DomainContentProps {
  selectedSubject: SubjectItem | null;
  selectedDomain: string | null;
  activeTab: DomainTab;
  isCustomDomain: boolean;
  subjectDomainsMetaPrompt: string;
  setSubjectDomainsMetaPrompt: (value: string) => void;
  generatingSubjectDomains: boolean;
  handleGenerateSubjectDomains: () => void;
  subjectAssessmentRatioError: string | null;
  subjectAssessmentRatioInvalid: boolean;
  allSubjectDomains: SubjectDomainRow[];
  subjectHasUploadedFile: boolean;
  isLockedSubjectDomainRow: (row: SubjectDomainRow) => boolean;
  updateSubjectDomainRow: (idx: number, patch: Partial<SubjectDomainRow>) => void;
  removeSubjectDomainRow: (idx: number) => void;
  addSubjectDomainRow: () => void;
  achievementStandards: any[];
  standardsMetaPrompt: string;
  setStandardsMetaPrompt: (value: string) => void;
  domainAiChats: Record<'standards' | 'scoring' | 'records', AiChatMessage[]>;
  domainAiDrafts: Record<'standards' | 'scoring' | 'records', string>;
  chattingDomainAi: 'standards' | 'scoring' | 'records' | null;
  setDomainAiDraft: (kind: 'standards' | 'scoring' | 'records', value: string) => void;
  handleDomainAiChatSend: (kind: 'standards' | 'scoring' | 'records') => void;
  clearDomainAiChat: (kind: 'standards' | 'scoring' | 'records') => void;
  generatingStandards: boolean;
  handleGenerateStandards: () => void;
  addStandardRef: () => void;
  standardRefs: StandardRef[];
  uniqueStandardDomains: string[];
  uniqueCodesForDomain: (domain: string) => any[];
  updateStandardRefDomain: (idx: number, domain: string) => void;
  updateStandardRefCode: (idx: number, code: string) => void;
  removeStandardRef: (idx: number) => void;
  evalItems: EvalItem[];
  currentMaxScore: number;
  calculatedScore: number;
  isScoreMismatch: boolean;
  updateEvalItem: (idx: number, field: keyof EvalItem, value: string) => void;
  evalMetaPrompts: Record<number, string>;
  setEvalMetaPrompts: Dispatch<SetStateAction<Record<number, string>>>;
  setIsDirty: (dirty: boolean) => void;
  handleGenerateEvalItems: () => void;
  generatingEval: boolean;
  handleGenerateEvalRubrics: () => void;
  addEvalItem: () => void;
  evalChecked: Set<number>;
  setEvalChecked: Dispatch<SetStateAction<Set<number>>>;
  removeEvalItem: (idx: number) => void;
  moveEvalItem: (from: number, to: number) => void;
  commentsMetaPrompts: Record<number, string>;
  setCommentsMetaPrompts: Dispatch<SetStateAction<Record<number, string>>>;
  handleGenerateCommentsItems: () => void;
  generatingComments: boolean;
  handleGenerateCommentsCriteria: () => void;
  addDomainCommentsItem: () => void;
  commentsItems: CommentsItem[];
  commentsChecked: Set<number>;
  setCommentsChecked: Dispatch<SetStateAction<Set<number>>>;
  updateCommentsItem: (idx: number, field: keyof CommentsItem, value: string) => void;
  removeCommentsItem: (idx: number) => void;
  moveCommentsItem: (from: number, to: number) => void;
  subjectCommentsPrompt: string;
  updateSubjectCommentsPrompt: (prompt: string) => void;
  subjectCommentsChat: AiChatMessage[];
  subjectCommentsDraft: string;
  setSubjectCommentsDraft: (value: string) => void;
  chattingSubjectComments: boolean;
  generatingSubjectComments: boolean;
  handleSubjectCommentsChatSend: () => void;
  handleGenerateSubjectComments: () => void;
  clearSubjectCommentsChat: () => void;
  aiEnabled: boolean;
  assignmentGuideFileRef: RefObject<HTMLInputElement>;
  assignmentResourceFileRef: RefObject<HTMLInputElement>;
  assignmentConfig: AssignmentConfig | null;
  assignmentResources: AssignmentResource[];
  assignmentClasses: AssignmentClassSnapshot[];
  assignmentLoading: boolean;
  assignmentUploading: boolean;
  updateAssignmentConfig: (patch: Partial<AssignmentConfig>) => void;
  saveAssignmentConfig: (
    overrides?: Partial<AssignmentConfig>,
    options?: { refreshGuide?: boolean },
  ) => Promise<boolean>;
  handleAssignmentGuideUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleAssignmentResourceUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  addAssignmentResourceLink: (url: string, title?: string) => Promise<boolean>;
  deleteAssignmentResource: (id: number) => void;
}

function EmptySelection() {
  return (
    <div className="flex-1 flex items-center justify-center text-gray-400">
      <div className="text-center">
        <ClipboardCheck size={40} className="mx-auto mb-3 opacity-30" />
        <p className="text-sm">왼쪽 트리에서 영역이나 과목명을 선택하세요</p>
        <p className="text-xs mt-2">과목 또는 영역을 선택해 평가 기준을 설정합니다.</p>
      </div>
    </div>
  );
}

function Section({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={className}>{children}</section>;
}

const mdRenderer = new MarkdownIt({ html: true, linkify: true, breaks: false, typographer: false });

function renderMarkdown(md: string) {
  return mdRenderer.render(md);
}

function formatBytes(size: number) {
  if (!size) return '-';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function formatRunTime(value: string, compact = false) {
  if (!value) return '-';
  const normalized = value.replace('T', ' ').slice(0, 19);
  return compact ? normalized.slice(5, 16) : normalized;
}

function runSubmissionLabel(submission?: AssignmentRunSubmission) {
  if (!submission) return '미제출';
  if (submission.status === 'accepted') return '파일 제출';
  if (submission.status === 'no_file') return '파일 없이 실시';
  if (submission.status === 'rejected') return '제출 실패';
  return submission.status || '미제출';
}

function submissionsForStudent(detail: AssignmentRunDetail, student: AssignmentRunStudent) {
  return detail.submissions.filter(submission =>
    (submission.assignment_student_id != null && Number(submission.assignment_student_id) === Number(student.assignment_student_id))
    || (Number(submission.student_num) === Number(student.student_num) && submission.name === student.name)
  );
}

function parseExtensionList(value: string) {
  return value
    .split(/[\s,]+/)
    .map(item => item.trim().replace(/^\./, '').toLowerCase())
    .filter(Boolean)
    .filter((item, index, arr) => arr.indexOf(item) === index);
}

function serializeExtensionList(items: string[]) {
  return items.map(item => item.replace(/^\./, '').toLowerCase()).filter(Boolean).join('\n');
}

interface AssignmentExtensionRule {
  id: string;
  name: string;
  extension: string;
  required: boolean;
  max_file_size_mb: number;
  max_files: number;
}

function parseExtensionRules(value: string, fallbackSize = 50, fallbackFiles = 1): AssignmentExtensionRule[] {
  try {
    const parsed = JSON.parse(value || '[]');
    if (Array.isArray(parsed)) {
      return parsed
        .map((item, index) => {
          const extension = String(item.extension || item.ext || '').trim().replace(/^\./, '').toLowerCase();
          return {
            id: String(item.id || item.slot_id || `slot-${index + 1}-${extension}`),
            name: String(item.name || item.content || item.label || extension).trim(),
            extension,
            required: item.required !== false && item.required !== 0,
            max_file_size_mb: Math.max(1, Number(item.max_file_size_mb || item.maxFileSizeMb || fallbackSize)),
            max_files: Math.max(1, Number(item.max_files || item.maxFiles || fallbackFiles)),
          };
        })
        .filter(item => item.id && item.name && item.extension)
        .filter((item, index, arr) => arr.findIndex(other => other.id === item.id) === index);
    }
  } catch {
    // Legacy newline/comma separated extension list.
  }
  return parseExtensionList(value).map((extension, index) => ({
    id: `slot-${index + 1}-${extension}`,
    name: extension,
    extension,
    required: true,
    max_file_size_mb: Math.max(1, Number(fallbackSize) || 50),
    max_files: Math.max(1, Number(fallbackFiles) || 1),
  }));
}

function serializeExtensionRules(items: AssignmentExtensionRule[]) {
  return JSON.stringify(
    items
      .map(item => ({
        id: item.id.trim(),
        name: item.name.trim(),
        extension: item.extension.trim().replace(/^\./, '').toLowerCase(),
        required: item.required !== false,
        max_file_size_mb: Math.max(1, Number(item.max_file_size_mb) || 50),
        max_files: Math.max(1, Number(item.max_files) || 1),
      }))
      .filter(item => item.id && item.name && item.extension)
      .filter((item, index, arr) => arr.findIndex(other => other.id === item.id) === index)
  );
}

function extBadgeClass(ext: string): string {
  switch (ext) {
    case 'py':   return 'bg-blue-100 text-blue-700 border-blue-300';
    case 'c':
    case 'cpp':
    case 'h':    return 'bg-purple-100 text-purple-700 border-purple-300';
    case 'pdf':  return 'bg-red-100 text-red-700 border-red-300';
    case 'html': return 'bg-orange-100 text-orange-700 border-orange-300';
    case 'hwpx': return 'bg-teal-100 text-teal-700 border-teal-300';
    case 'csv':  return 'bg-emerald-100 text-emerald-700 border-emerald-300';
    case 'ipynb': return 'bg-indigo-100 text-indigo-700 border-indigo-300';
    case 'java': return 'bg-red-100 text-red-800 border-red-300';
    case 'js':
    case 'ts':
    case 'jsx':
    case 'tsx':  return 'bg-yellow-100 text-yellow-800 border-yellow-300';
    case 'json': return 'bg-gray-100 text-gray-700 border-gray-300';
    case 'sql':  return 'bg-green-100 text-green-700 border-green-300';
    default:     return 'bg-gray-100 text-gray-500 border-gray-300';
  }
}

export function DomainContent({
  selectedSubject,
  selectedDomain,
  activeTab,
  isCustomDomain,
  subjectDomainsMetaPrompt,
  setSubjectDomainsMetaPrompt,
  generatingSubjectDomains,
  handleGenerateSubjectDomains,
  subjectAssessmentRatioError,
  subjectAssessmentRatioInvalid,
  allSubjectDomains,
  subjectHasUploadedFile,
  isLockedSubjectDomainRow,
  updateSubjectDomainRow,
  removeSubjectDomainRow,
  addSubjectDomainRow,
  achievementStandards,
  standardsMetaPrompt,
  setStandardsMetaPrompt,
  domainAiChats,
  domainAiDrafts,
  chattingDomainAi,
  setDomainAiDraft,
  handleDomainAiChatSend,
  clearDomainAiChat,
  generatingStandards,
  handleGenerateStandards,
  addStandardRef,
  standardRefs,
  uniqueStandardDomains,
  uniqueCodesForDomain,
  updateStandardRefDomain,
  updateStandardRefCode,
  removeStandardRef,
  evalItems,
  currentMaxScore,
  calculatedScore,
  isScoreMismatch,
  updateEvalItem,
  evalMetaPrompts,
  setEvalMetaPrompts,
  setIsDirty,
  handleGenerateEvalItems,
  generatingEval,
  handleGenerateEvalRubrics,
  addEvalItem,
  evalChecked,
  setEvalChecked,
  removeEvalItem,
  moveEvalItem,
  commentsMetaPrompts,
  setCommentsMetaPrompts,
  handleGenerateCommentsItems,
  generatingComments,
  handleGenerateCommentsCriteria,
  addDomainCommentsItem,
  commentsItems,
  commentsChecked,
  setCommentsChecked,
  updateCommentsItem,
  removeCommentsItem,
  moveCommentsItem,
  subjectCommentsPrompt,
  updateSubjectCommentsPrompt,
  subjectCommentsChat,
  subjectCommentsDraft,
  setSubjectCommentsDraft,
  chattingSubjectComments,
  generatingSubjectComments,
  handleSubjectCommentsChatSend,
  handleGenerateSubjectComments,
  clearSubjectCommentsChat,
  aiEnabled,
  assignmentGuideFileRef,
  assignmentResourceFileRef,
  assignmentConfig,
  assignmentResources,
  assignmentClasses,
  assignmentLoading,
  assignmentUploading,
  updateAssignmentConfig,
  saveAssignmentConfig,
  handleAssignmentGuideUpload,
  handleAssignmentResourceUpload,
  addAssignmentResourceLink,
  deleteAssignmentResource,
}: DomainContentProps) {
  const [guideEditorOpen, setGuideEditorOpen] = useState(false);
  const [guideOriginal, setGuideOriginal] = useState('');
  const [contentDraft, setContentDraft] = useState('');
  const [extensionDraft, setExtensionDraft] = useState('');
  const [viewingResource, setViewingResource] = useState<AssignmentResource | null>(null);
  const [resourceLinkDraft, setResourceLinkDraft] = useState('');
  const [guideLinkDraft, setGuideLinkDraft] = useState('');
  const [assignmentHistory, setAssignmentHistory] = useState<AssignmentRunSummary[]>([]);
  const [assignmentHistoryLoading, setAssignmentHistoryLoading] = useState(false);
  const [selectedRunSummary, setSelectedRunSummary] = useState<AssignmentRunSummary | null>(null);
  const [selectedRunDetail, setSelectedRunDetail] = useState<AssignmentRunDetail | null>(null);
  const [runDetailLoading, setRunDetailLoading] = useState(false);
  const [draggedItem, setDraggedItem] = useState<{ kind: 'scoring' | 'records'; index: number } | null>(null);
  const [dragOverItem, setDragOverItem] = useState<{ kind: 'scoring' | 'records'; index: number } | null>(null);

  useEffect(() => {
    setGuideLinkDraft(assignmentConfig?.guide_url || '');
  }, [assignmentConfig?.id, assignmentConfig?.guide_url]);

  useEffect(() => {
    setResourceLinkDraft(current => {
      if (assignmentResources.some(resource => resource.source_url === current)) return current;
      return assignmentResources.find(resource => resource.source_url)?.source_url || '';
    });
  }, [assignmentConfig?.id, assignmentResources]);

  useEffect(() => {
    if (activeTab !== 'assignment' || !selectedSubject || !selectedDomain) {
      setAssignmentHistory([]);
      return;
    }
    let cancelled = false;
    setAssignmentHistoryLoading(true);
    assignmentConfigsApi.getHistory({
      year: selectedSubject.year,
      semester: selectedSubject.semester,
      grade: selectedSubject.grade,
      subject: selectedSubject.subject,
      domainName: selectedDomain,
    }).then(response => {
      if (!cancelled) setAssignmentHistory(response.data || []);
    }).catch(() => {
      if (!cancelled) setAssignmentHistory([]);
    }).finally(() => {
      if (!cancelled) setAssignmentHistoryLoading(false);
    });
    return () => { cancelled = true; };
  }, [activeTab, selectedSubject, selectedDomain, assignmentConfig?.id]);

  const openRunDetail = async (summary: AssignmentRunSummary) => {
    if (!selectedSubject || !selectedDomain) return;
    setSelectedRunSummary(summary);
    setSelectedRunDetail(null);
    setRunDetailLoading(true);
    try {
      const response = await assignmentConfigsApi.getHistoryDetail(summary.id, {
        year: selectedSubject.year,
        semester: selectedSubject.semester,
        grade: selectedSubject.grade,
        subject: selectedSubject.subject,
        domainName: selectedDomain,
      });
      setSelectedRunDetail(response.data);
    } catch (error: any) {
      setSelectedRunSummary(null);
      alert(`실시 기록을 불러오지 못했습니다: ${error?.response?.data?.error || error.message || String(error)}`);
    } finally {
      setRunDetailLoading(false);
    }
  };

  const startItemDrag = (kind: 'scoring' | 'records', index: number, event: DragEvent<HTMLDivElement>) => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', `${kind}:${index}`);
    setDraggedItem({ kind, index });
    setDragOverItem({ kind, index });
  };

  const finishItemDrag = () => {
    setDraggedItem(null);
    setDragOverItem(null);
  };

  const dropItem = (kind: 'scoring' | 'records', index: number, event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (!draggedItem || draggedItem.kind !== kind) return finishItemDrag();
    if (kind === 'scoring') moveEvalItem(draggedItem.index, index);
    else moveCommentsItem(draggedItem.index, index);
    finishItemDrag();
  };

  const assignmentExtensionRules = parseExtensionRules(
    assignmentConfig?.allowed_extensions || '',
    assignmentConfig?.max_file_size_mb || 50,
    assignmentConfig?.max_files || 1
  );
  const updateAssignmentExtensionRules = (rules: AssignmentExtensionRule[]) => {
    const normalized = rules
      .map(item => ({
        id: item.id,
        name: item.name.trim(),
        extension: item.extension.trim().replace(/^\./, '').toLowerCase(),
        required: item.required !== false,
        max_file_size_mb: Math.max(1, Number(item.max_file_size_mb) || 50),
        max_files: Math.max(1, Number(item.max_files) || 1),
      }))
      .filter(item => item.id && item.name && item.extension)
      .filter((item, index, arr) => arr.findIndex(other => other.id === item.id) === index);
    updateAssignmentConfig({
      allowed_extensions: serializeExtensionRules(normalized),
      max_file_size_mb: Math.max(1, ...normalized.map(item => item.max_file_size_mb), 50),
      max_files: Math.max(1, ...normalized.map(item => item.max_files), 1),
    });
  };

  if (!selectedSubject) {
    return <EmptySelection />;
  }

  const useFullHeightCriteriaLayout = !!selectedDomain && ['standards', 'scoring', 'records', 'comments'].includes(activeTab);

  return (
    <div className={`flex-1 min-h-0 px-6 pt-6 ${useFullHeightCriteriaLayout ? 'overflow-hidden pb-6' : 'overflow-auto pb-32 scrollbar-stable'}`}>
      <div className={`min-w-[760px] ${useFullHeightCriteriaLayout ? 'h-full min-h-0' : 'space-y-8'}`}>
      {!selectedDomain && activeTab === 'ratio' && (
        <Section>
          <div className="mb-4">
            <AiGenerateBox
              label="평가 영역 자동 생성"
              placeholder="반영비율/만점관리 생성을 위한 지시사항을 입력하세요. (예: 수행평가 2개와 기록 영역 1개로 구성)"
              value={subjectDomainsMetaPrompt}
              onChange={(value) => {
                setSubjectDomainsMetaPrompt(value);
                setIsDirty(true);
              }}
              onGenerate={handleGenerateSubjectDomains}
              generating={generatingSubjectDomains}
              disabled={!aiEnabled}
            />
          </div>
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            <div className={`flex h-8 items-center gap-1.5 border-b px-3 text-xs transition-colors ${subjectAssessmentRatioError ? 'border-red-200 bg-red-50 text-red-700' : 'border-gray-100 bg-gray-50 text-transparent'}`}>
              {subjectAssessmentRatioError && <AlertCircle size={12} className="shrink-0" />}
              <span>{subjectAssessmentRatioError || '반영비율 합계 정상'}</span>
            </div>
            <table className="w-full text-xs">
              <thead className="bg-gray-50/50">
                <tr className="border-b border-gray-100">
                  <th className="px-3 py-2 text-left font-medium text-gray-500 w-28">평가종류</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-500">영역명</th>
                  <th className="px-3 py-2 text-center font-medium text-gray-500 w-28">학기말반영</th>
                  <th className={`px-3 py-2 text-center font-medium w-28 ${subjectAssessmentRatioInvalid ? 'bg-red-50 text-red-700' : 'text-gray-500'}`}>반영비율</th>
                  <th className="px-3 py-2 text-center font-medium text-gray-500 w-28">만점</th>
                  <th className="px-3 py-2 w-10" />
                </tr>
              </thead>
              <tbody>
                {allSubjectDomains.map((row, i) => {
                  const locked = isLockedSubjectDomainRow(row);
                  const recordType = row.eval_type === '기록';
                  const ratioInvalid = subjectAssessmentRatioInvalid && (row.eval_type === '지필' || row.eval_type === '수행');
                  const inputClass = `input h-8 px-2 py-0 text-xs ${locked ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : ''}`;
                  return (
                    <tr key={row.id ?? i} className={`border-b border-gray-100 last:border-0 ${locked ? 'text-gray-400' : ''}`}>
                      <td className="px-2 py-1.5">
                        <select
                          className={inputClass}
                          value={row.eval_type || (subjectHasUploadedFile ? '기록' : '수행')}
                          onChange={(e) => updateSubjectDomainRow(i, {
                            eval_type: e.target.value,
                            reflected: e.target.value === '기록' ? 'X' : 'O',
                          })}
                          disabled={locked}
                        >
                          {locked ? (
                            <option value={row.eval_type}>{row.eval_type}</option>
                          ) : subjectHasUploadedFile ? (
                            <option value="기록">기록</option>
                          ) : (
                            <>
                              <option value="지필">지필</option>
                              <option value="수행">수행</option>
                              <option value="기록">기록</option>
                            </>
                          )}
                        </select>
                      </td>
                      <td className="px-2 py-1.5">
                        <input
                          className={`${inputClass} w-full`}
                          value={row.name || ''}
                          onChange={(e) => updateSubjectDomainRow(i, { name: e.target.value })}
                          disabled={locked}
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        {recordType ? (
                          <div className="flex h-8 items-center justify-center rounded border border-gray-200 bg-gray-100 px-2 text-xs font-medium text-gray-400">
                            X
                          </div>
                        ) : (
                          <div className={`flex h-8 items-center justify-center rounded border px-2 text-xs font-medium ${locked ? 'border-gray-200 bg-gray-100 text-gray-400' : 'border-gray-200 bg-gray-50 text-gray-600'}`}>
                            O
                          </div>
                        )}
                      </td>
                      <td className="px-2 py-1.5">
                        {recordType ? (
                          <div className="flex h-8 items-center justify-center rounded border border-gray-200 bg-gray-100 px-2 text-xs font-medium text-gray-400">
                            -
                          </div>
                        ) : (
                          <input
                            className={`${inputClass} text-center ${ratioInvalid ? 'border-red-300 bg-red-50 text-red-700 focus:ring-red-200' : ''}`}
                            type="number"
                            min="0"
                            value={row.ratio ?? 0}
                            onChange={(e) => updateSubjectDomainRow(i, { ratio: e.target.value })}
                            disabled={locked}
                          />
                        )}
                      </td>
                      <td className="px-2 py-1.5">
                        {recordType ? (
                          <div className="flex h-8 items-center justify-center rounded border border-gray-200 bg-gray-100 px-2 text-xs font-medium text-gray-400">
                            -
                          </div>
                        ) : (
                          <input
                            className={`${inputClass} text-center`}
                            type="number"
                            min="0"
                            value={row.max_score ?? 0}
                            onChange={(e) => updateSubjectDomainRow(i, { max_score: e.target.value })}
                            disabled={locked}
                          />
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-center">
                        {!locked && (
                          <button
                            className="p-1 hover:bg-red-50 text-red-400 rounded"
                            onClick={() => removeSubjectDomainRow(i)}
                            title="행 삭제"
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {allSubjectDomains.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-gray-400">
                      반영비율/만점관리 데이터가 없습니다.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            <button
              className="flex w-full items-center justify-center gap-1.5 border-t border-dashed border-gray-200 py-2 text-xs text-blue-600 hover:bg-blue-50"
              onClick={addSubjectDomainRow}
            >
              <Plus size={13} /> 행 추가
            </button>
          </div>
        </Section>
      )}

      {selectedDomain && activeTab === 'standards' && (
        <Section className="h-full min-h-0">
          <DomainCriteriaPanel
            prompt={achievementStandards.length === 0 ? (
              <p className="text-xs text-gray-400 text-center py-2 bg-gray-50 rounded border border-dashed border-gray-200">
                기준 관리에 성취기준을 먼저 업로드하세요.
              </p>
            ) : (
              {
                label: '성취 기준 항목 자동 생성',
                placeholder: "예: 이 영역의 핵심 성취기준 2~3개를 골라줘",
                messages: domainAiChats.standards,
                draft: domainAiDrafts.standards,
                onDraftChange: (value) => setDomainAiDraft('standards', value),
                onSend: () => handleDomainAiChatSend('standards'),
                onGenerate: handleGenerateStandards,
                onClearChat: () => clearDomainAiChat('standards'),
                generating: generatingStandards,
                chatting: chattingDomainAi === 'standards',
                disabled: !aiEnabled,
              }
            )}
            items={{
              title: '성취 기준 항목',
              addLabel: '항목 추가',
              onAdd: addStandardRef,
              empty: standardRefs.length === 0 && achievementStandards.length > 0 && (
                <p className="text-center py-4 text-gray-400 text-sm">참조할 성취기준을 추가하거나 AI로 선택하세요.</p>
              ),
              children: standardRefs.map((ref, idx) => {
                  const codes = uniqueCodesForDomain(ref.domain_name_ref);
                  return (
                    <div key={idx} className="bg-amber-50 border border-amber-200 rounded-lg p-3 space-y-2">
                      <div className="flex items-center gap-2">
                        <select
                          className="input text-xs flex-[3] min-w-0"
                          value={ref.domain_name_ref}
                          onChange={e => updateStandardRefDomain(idx, e.target.value)}
                        >
                          <option value="">영역 선택</option>
                          {uniqueStandardDomains.map(d => <option key={d} value={d}>{d}</option>)}
                        </select>
                        <select
                          className="input text-xs flex-[7] min-w-0"
                          value={ref.code}
                          onChange={e => updateStandardRefCode(idx, e.target.value)}
                          disabled={!ref.domain_name_ref}
                        >
                          <option value="">성취기준 선택</option>
                          {codes.map(s => {
                            const preview = s.content.replace(s.code, '').trim().slice(0, 40);
                            return <option key={s.code} value={s.code}>{s.code} {preview}{s.content.length > s.code.length + 40 ? '…' : ''}</option>;
                          })}
                        </select>
                        <button
                          className="p-1 hover:bg-red-100 text-red-400 rounded shrink-0"
                          onClick={() => removeStandardRef(idx)}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                      {ref.content && (
                        <p className="text-xs text-gray-600 leading-relaxed bg-white rounded p-2 border border-amber-100">
                          <span className="font-mono text-blue-600 mr-1.5">{ref.code}</span>
                          {ref.content.replace(ref.code, '').trim()}
                        </p>
                      )}
                    </div>
                  );
                }),
            }}
          />
        </Section>
      )}

      {selectedDomain && !isCustomDomain && activeTab === 'scoring' && (
        <Section className="h-full min-h-0">
          <DomainCriteriaPanel
            top={(() => {
              const formulaIdx = evalItems.findIndex(i => i.item_type === 'formula');
              if (formulaIdx < 0) return null;
              const formulaItem = evalItems[formulaIdx];
              return (
                <div className={`space-y-3 rounded-lg border p-4 shadow-sm ${isScoreMismatch ? 'bg-red-50 border-red-300' : 'bg-blue-50 border-blue-200'}`}>
                  <div className="flex h-9 items-center gap-3">
                    <div className={`w-24 text-sm font-semibold ${isScoreMismatch ? 'text-red-800' : 'text-blue-800'}`}>공통</div>
                    <div className={`text-sm flex-1 font-medium ${isScoreMismatch ? 'text-red-700' : 'text-blue-700'}`}>
                      만점 {currentMaxScore}점
                      {isScoreMismatch && <span className="ml-2 font-bold">(합계 {calculatedScore}점)</span>}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`text-sm font-medium ${isScoreMismatch ? 'text-red-800' : 'text-blue-800'}`}>기본점수:</span>
                      <input
                        className="input w-20 text-sm text-center"
                        type="number"
                        placeholder="0"
                        value={formulaItem.score}
                        onChange={e => updateEvalItem(formulaIdx, 'score', e.target.value)}
                      />
                    </div>
                  </div>
                  <StableTextarea
                    className="textarea min-h-[86px] w-full resize-y bg-white text-sm leading-relaxed"
                    placeholder="공통 채점 기준 내용"
                    value={formulaItem.rubric}
                    onChange={e => updateEvalItem(formulaIdx, 'rubric', e.target.value)}
                  />
                </div>
              );
            })()}
            prompt={{
              label: '채점 기준 항목 자동 생성',
              placeholder: '예: 코드 기반 수행평가, 4단계 루브릭으로',
              messages: domainAiChats.scoring,
              draft: domainAiDrafts.scoring,
              onDraftChange: (value) => setDomainAiDraft('scoring', value),
              onSend: () => handleDomainAiChatSend('scoring'),
              onGenerate: handleGenerateEvalItems,
              onClearChat: () => clearDomainAiChat('scoring'),
              generating: generatingEval,
              chatting: chattingDomainAi === 'scoring',
              disabled: !aiEnabled,
            }}
            items={{
              title: '채점 기준 항목',
              addLabel: '항목 추가',
              generating: generatingEval,
              onAdd: addEvalItem,
              empty: evalItems.filter(i => i.item_type !== 'formula').length === 0 && (
                <p className="text-center py-6 text-gray-400 text-sm">채점 항목을 추가하거나 AI로 생성하세요.</p>
              ),
              children: evalItems.map((item, idx) => {
                if (item.item_type === 'formula') return null;
                const isChecked = evalChecked.has(idx);
                return (
                  <CriteriaItemCard
                    key={idx}
                    checked={isChecked}
                    title={item.name}
                    instruction={evalMetaPrompts[idx] || ''}
                    result={item.rubric}
                    score={item.score}
                    draggable
                    dragActive={draggedItem?.kind === 'scoring' && draggedItem.index === idx}
                    dragOver={dragOverItem?.kind === 'scoring' && dragOverItem.index === idx && draggedItem?.index !== idx}
                    onDragStart={(event) => startItemDrag('scoring', idx, event)}
                    onDragEnd={finishItemDrag}
                    onDragOver={(event) => {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = 'move';
                      setDragOverItem({ kind: 'scoring', index: idx });
                    }}
                    onDrop={(event) => dropItem('scoring', idx, event)}
                    titlePlaceholder="채점 항목명 (예: 코드 완성도)"
                    instructionPlaceholder="채점 기준 내용 생성을 위한 지시사항을 입력하세요. (예: 코드 완성도 기준으로 4단계로 나눠줘)"
                    resultPlaceholder="루브릭 내용 (예: A(10점): 코드가 완벽히 동작하고 예외 처리가 됨, B(8점): ...)"
                    resultLabel="채점 기준 내용"
                    onCheckedChange={(checked) => {
                      const next = new Set(evalChecked);
                      if (checked) next.add(idx); else next.delete(idx);
                      setEvalChecked(next);
                    }}
                    onTitleChange={(value) => updateEvalItem(idx, 'name', value)}
                    onInstructionChange={(value) => {
                      setEvalMetaPrompts(p => ({ ...p, [idx]: value }));
                      setIsDirty(true);
                    }}
                    instructionDisabled={!aiEnabled}
                    showCheckbox={false}
                    showInstruction={false}
                    onResultChange={(value) => updateEvalItem(idx, 'rubric', value)}
                    onScoreChange={(value) => updateEvalItem(idx, 'score', value)}
                    onRemove={() => removeEvalItem(idx)}
                  />
                );
              }),
            }}
          />
        </Section>
      )}

      {selectedDomain && activeTab === 'records' && (
        <Section className="h-full min-h-0">
          <DomainCriteriaPanel
            top={(() => {
              const commonIdx = commentsItems.findIndex(item => item.type === '공통');
              if (commonIdx < 0) return null;
              const commonItem = commentsItems[commonIdx];
              return (
                <div className="space-y-3 rounded-lg border border-purple-200 bg-purple-50 p-4 shadow-sm">
                  <div className="flex h-9 items-center gap-3">
                    <div className="w-24 text-sm font-semibold text-purple-800">공통</div>
                  </div>
                  <StableTextarea
                    className="textarea min-h-[96px] w-full resize-y bg-white text-sm leading-relaxed"
                    placeholder="모든 기록 기준에 공통으로 적용할 내용"
                    value={commonItem.prompt}
                    onChange={e => updateCommentsItem(commonIdx, 'prompt', e.target.value)}
                  />
                </div>
              );
            })()}
            prompt={{
              label: '기록 기준 항목 자동 생성',
              placeholder: '예: 보고서와 코드를 각각 기록하는 항목으로 구성',
              messages: domainAiChats.records,
              draft: domainAiDrafts.records,
              onDraftChange: (value) => setDomainAiDraft('records', value),
              onSend: () => handleDomainAiChatSend('records'),
              onGenerate: handleGenerateCommentsItems,
              onClearChat: () => clearDomainAiChat('records'),
              generating: generatingComments,
              chatting: chattingDomainAi === 'records',
              disabled: !aiEnabled,
            }}
            items={{
              title: '기록 기준 항목',
              addLabel: '항목 추가',
              generating: generatingComments,
              onAdd: addDomainCommentsItem,
              empty: commentsItems.filter(item => item.type !== '공통').length === 0 && (
                <p className="text-center py-6 text-gray-400 text-sm">활동 기록 항목을 추가하거나 AI로 생성하세요.</p>
              ),
              children: commentsItems.map((item, idx) => {
                if (item.type === '공통') return null;
                const isChecked = commentsChecked.has(idx);
                return (
                  <CriteriaItemCard
                    key={idx}
                    checked={isChecked}
                    title={item.title}
                    instruction={commentsMetaPrompts[idx] || ''}
                    result={item.prompt}
                    draggable
                    dragActive={draggedItem?.kind === 'records' && draggedItem.index === idx}
                    dragOver={dragOverItem?.kind === 'records' && dragOverItem.index === idx && draggedItem?.index !== idx}
                    onDragStart={(event) => startItemDrag('records', idx, event)}
                    onDragEnd={finishItemDrag}
                    onDragOver={(event) => {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = 'move';
                      setDragOverItem({ kind: 'records', index: idx });
                    }}
                    onDrop={(event) => dropItem('records', idx, event)}
                    titlePlaceholder="항목 이름 (예: 자료수집 및 분석)"
                    instructionPlaceholder="기록 기준 내용 생성을 위한 지시사항을 입력하세요. (예: 학생의 탐구 과정 중심으로 작성 기준 생성)"
                    resultPlaceholder="이 항목의 기록 작성 기준 (예: 학생이 제출한 산출물을 분석하여 성취수준을 평가하고...)"
                    resultLabel="기록 기준 내용"
                    onCheckedChange={(checked) => {
                      const next = new Set(commentsChecked);
                      if (checked) next.add(idx); else next.delete(idx);
                      setCommentsChecked(next);
                    }}
                    onTitleChange={(value) => updateCommentsItem(idx, 'title', value)}
                    onInstructionChange={(value) => {
                      setCommentsMetaPrompts(p => ({ ...p, [idx]: value }));
                      setIsDirty(true);
                    }}
                    instructionDisabled={!aiEnabled}
                    showCheckbox={false}
                    showInstruction={false}
                    onResultChange={(value) => updateCommentsItem(idx, 'prompt', value)}
                    onRemove={() => removeCommentsItem(idx)}
                  />
                );
              }),
            }}
          />
        </Section>
      )}

      {selectedDomain && activeTab === 'comments' && (
        <Section className="h-full min-h-0">
          <DomainCriteriaSplit
            left={(
              <DomainCriteriaPromptView
                prompt={{
                  label: '세특 기준 생성',
                  placeholder: '예: 학생의 탐구 과정과 성장, 과목 역량이 구체적으로 드러나게 작성해줘',
                  generateLabel: '세특 생성',
                  messages: subjectCommentsChat,
                  draft: subjectCommentsDraft,
                  onDraftChange: setSubjectCommentsDraft,
                  onSend: handleSubjectCommentsChatSend,
                  onGenerate: handleGenerateSubjectComments,
                  onClearChat: clearSubjectCommentsChat,
                  generating: generatingSubjectComments,
                  chatting: chattingSubjectComments,
                  disabled: !aiEnabled,
                }}
              />
            )}
            right={(
              <div className="flex h-full min-h-0 min-w-0 flex-col rounded-lg border border-purple-200 bg-purple-50 p-4 shadow-sm">
                <div className="mb-3 flex h-9 shrink-0 items-center gap-3">
                  <div className="w-24 text-sm font-semibold text-purple-800">공통</div>
                </div>
                <StableTextarea
                  className="textarea min-h-0 flex-1 resize-none bg-white text-sm leading-relaxed"
                  placeholder="생성된 세특 기준이 여기에 표시됩니다. 직접 수정할 수도 있습니다."
                  value={subjectCommentsPrompt}
                  onChange={e => updateSubjectCommentsPrompt(e.target.value)}
                />
              </div>
            )}
          />
        </Section>
      )}

      {selectedDomain && activeTab === 'assignment' && (
        <Section>
          <div className="grid grid-cols-[minmax(0,2fr)_minmax(280px,1fr)] gap-4">
            <div className="rounded-lg border border-gray-200 bg-white p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <FileText size={15} className="shrink-0 text-gray-500" />
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-gray-800">안내</h3>
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    className="btn-secondary h-9 py-0 text-xs"
                    onClick={async () => {
                      if (hasDesktopFileDialogs()) {
                        const files = await openFiles({ filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }] });
                        if (files?.length) handleAssignmentGuideUpload(filesToInputChangeEvent(files) as any);
                        return;
                      }
                      assignmentGuideFileRef.current?.click();
                    }}
                    disabled={assignmentUploading}
                  >
                    {assignmentUploading ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
                    MD 업로드
                  </button>
                  <button
                    type="button"
                    className="btn-secondary h-9 py-0 text-xs"
                    onClick={() => saveBlob(
                      `${assignmentConfig?.title || `${selectedSubject.subject} ${selectedDomain}`} 안내.md`,
                      new Blob([assignmentConfig?.resolved_guide_md ?? assignmentConfig?.guide_md ?? ''], { type: 'text/markdown;charset=utf-8' }),
                    ).catch((error) => alert(error.message))}
                    disabled={assignmentLoading}
                  >
                    <Download size={13} />
                    MD 다운로드
                  </button>
                  <button
                    className="btn-secondary h-9 py-0 text-xs"
                    onClick={() => { setGuideOriginal(assignmentConfig?.guide_md || ''); setGuideEditorOpen(true); }}
                  >
                    <Edit3 size={13} />
                    직접 작성
                  </button>
                  <button
                    type="button"
                    className="inline-flex h-9 items-center justify-center gap-1.5 rounded border border-red-200 bg-white px-3 text-xs font-medium text-red-500 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={assignmentLoading || assignmentUploading}
                    onClick={() => {
                      if (!confirm('안내문과 연결된 GitHub 링크를 삭제하시겠습니까?')) return;
                      saveAssignmentConfig({ guide_md: '', guide_url: '' })
                        .catch((error) => alert(error?.response?.data?.error || error.message));
                    }}
                  >
                    <Trash2 size={13} />
                    삭제
                  </button>
                  <input
                    ref={assignmentGuideFileRef}
                    type="file"
                    className="hidden"
                    accept=".md,.markdown,text/markdown,text/plain"
                    onChange={handleAssignmentGuideUpload}
                  />
                </div>
              </div>
              <div className="mb-3 flex gap-2">
                <input
                  className="input h-9 flex-1 text-xs"
                  type="url"
                  value={guideLinkDraft}
                  onChange={(event) => setGuideLinkDraft(event.target.value)}
                  placeholder="공개 GitHub Markdown 링크 (blob 또는 raw)"
                />
                <button
                  type="button"
                  className="btn-secondary h-9 w-24 shrink-0 justify-center px-2 py-0 text-xs"
                  disabled={assignmentLoading || assignmentUploading}
                  onClick={() => {
                    const guideUrl = guideLinkDraft.trim();
                    const refreshGuide = !!assignmentConfig?.guide_url && guideUrl === assignmentConfig.guide_url;
                    saveAssignmentConfig({ guide_url: guideUrl }, { refreshGuide })
                      .catch((error) => alert(error?.response?.data?.error || error.message));
                  }}
                >
                  {assignmentConfig?.guide_url && guideLinkDraft.trim() === assignmentConfig.guide_url
                    ? <RefreshCw size={13} />
                    : <Link2 size={13} />}
                  {assignmentConfig?.guide_url && guideLinkDraft.trim() === assignmentConfig.guide_url ? '새로고침' : '연결'}
                </button>
              </div>
              {assignmentConfig?.guide_fetch_error && (
                <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                  최신 안내문을 불러오지 못했습니다: {assignmentConfig.guide_fetch_error}
                </div>
              )}
              <div className="mb-2 text-[11px] text-gray-400">
                확인 일시: {formatRunTime(assignmentConfig?.guide_checked_at || assignmentConfig?.updated_at || '')}
              </div>
              {assignmentLoading ? (
                <div className="flex h-[42rem] items-center justify-center rounded-md border border-gray-200 bg-gray-50 text-gray-400">
                  <Loader2 size={20} className="animate-spin" />
                </div>
              ) : (
                <div
                  className="prose-preview h-[42rem] overflow-auto rounded-md border border-gray-200 bg-gray-50 p-5 text-sm leading-relaxed text-gray-800"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(assignmentConfig?.resolved_guide_md ?? assignmentConfig?.guide_md ?? '안내 사항을 입력하세요.') }}
                />
              )}
            </div>

            <div className="space-y-4">
              <div className="rounded-lg border border-gray-200 bg-white p-4">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold text-gray-800">배부 자료</h3>
                  </div>
                  <button
                    className="btn-secondary h-9 w-24 shrink-0 justify-center px-2 py-0 text-xs"
                    onClick={async () => {
                      if (hasDesktopFileDialogs()) {
                        const files = await openFiles({ multiple: true });
                        if (files?.length) handleAssignmentResourceUpload(filesToInputChangeEvent(files) as any);
                        return;
                      }
                      assignmentResourceFileRef.current?.click();
                    }}
                    disabled={assignmentUploading}
                  >
                    {assignmentUploading ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
                    업로드
                  </button>
                  <input
                    ref={assignmentResourceFileRef}
                    type="file"
                    className="hidden"
                    multiple
                    onChange={handleAssignmentResourceUpload}
                  />
                </div>
                <div className="mb-3 flex gap-2">
                  <input
                    className="input h-9 flex-1 text-xs"
                    type="url"
                    value={resourceLinkDraft}
                    onChange={(event) => setResourceLinkDraft(event.target.value)}
                    placeholder="공개 GitHub 파일 링크 (blob 또는 raw)"
                    onKeyDown={async (event) => {
                      if (event.key !== 'Enter' || !resourceLinkDraft.trim()) return;
                      event.preventDefault();
                      await addAssignmentResourceLink(resourceLinkDraft.trim());
                    }}
                  />
                  <button
                    type="button"
                    className="btn-secondary h-9 w-24 shrink-0 justify-center px-2 py-0 text-xs"
                    disabled={!resourceLinkDraft.trim() || assignmentUploading}
                    onClick={async () => {
                      await addAssignmentResourceLink(resourceLinkDraft.trim());
                    }}
                  >
                    {assignmentResources.some(resource => resource.source_url === resourceLinkDraft.trim())
                      ? <RefreshCw size={13} />
                      : <Link2 size={13} />}
                    {assignmentResources.some(resource => resource.source_url === resourceLinkDraft.trim()) ? '새로고침' : '연결'}
                  </button>
                </div>
                <div className="space-y-2">
                  {assignmentResources.map((resource) => (
                    <div key={resource.id} className="rounded-md border border-gray-200 bg-gray-50 p-2">
                      <div className="truncate text-xs font-medium text-gray-800" title={resource.filename}>{resource.filename}</div>
                      <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-gray-500">
                        <div>
                          <div>{resource.source_url ? 'GitHub 저장본' : formatBytes(Number(resource.size))}</div>
                          <div className="text-[10px] text-gray-400">확인 일시: {formatRunTime(resource.checked_at || resource.uploaded_at || '')}</div>
                        </div>
                        <div className="flex gap-1">
                          <button
                            className="inline-flex h-7 w-7 items-center justify-center rounded border border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
                            onClick={() => setViewingResource(resource)}
                            title="미리보기"
                          >
                            <Eye size={13} />
                          </button>
                          {resource.source_url ? (
                            <button
                              type="button"
                              className="inline-flex h-7 w-7 items-center justify-center rounded border border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
                              onClick={() => window.open(resource.source_url, '_blank', 'noopener,noreferrer')}
                              title="GitHub 원본 열기"
                            >
                              <ExternalLink size={13} />
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="inline-flex h-7 w-7 items-center justify-center rounded border border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
                              onClick={() => downloadUrl(
                                assignmentConfigsApi.resourceFileUrl(resource.id),
                                resource.filename,
                              ).catch((error) => alert(error.message))}
                              title="다운로드"
                            >
                              <Download size={13} />
                            </button>
                          )}
                          <button
                            className="inline-flex h-7 w-7 items-center justify-center rounded border border-red-200 bg-white text-red-500 hover:bg-red-50"
                            onClick={() => deleteAssignmentResource(resource.id)}
                            title="삭제"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                  {assignmentResources.length === 0 && (
                    <div className="rounded-md border border-dashed border-gray-200 py-8 text-center text-xs text-gray-400">
                      업로드된 배부 자료가 없습니다.
                    </div>
                  )}
                </div>
              </div>

              <Suspense fallback={null}>
                <ArtifactPreviewModal
                  artifact={viewingResource
                    ? { id: viewingResource.id, filename: viewingResource.filename, source: 'resource' }
                    : null}
                  onClose={() => setViewingResource(null)}
                />
              </Suspense>

              <div className="rounded-lg border border-gray-200 bg-white p-4">
                <h3 className="mb-3 text-sm font-semibold text-gray-800">제출 파일 설정</h3>
                <div className="space-y-3">
                  <div>
                    <div className="rounded-md border border-gray-300 bg-white p-2">
                      <div className="space-y-1">
                        {assignmentExtensionRules.length > 0 && (
                          <div className="grid grid-cols-[minmax(100px,1.5fr)_80px_64px_90px_70px] gap-1 px-2 pb-1 text-[11px] font-medium text-gray-400">
                            <span className="text-center">내용</span>
                            <span className="text-center">확장자</span>
                            <span className="text-center">필수</span>
                            <span className="text-center">최대 용량</span>
                            <span className="text-center">파일 수</span>
                          </div>
                        )}
                        {assignmentExtensionRules.map((rule, index) => (
                          <div key={rule.id} className="grid grid-cols-[minmax(100px,1.5fr)_80px_64px_90px_70px] items-center gap-1 rounded border border-gray-200 bg-gray-50 px-2 py-1.5">
                            <input
                              className="input h-7 min-w-0 px-1.5 py-0 text-xs"
                              defaultValue={rule.name}
                              onBlur={(e) => {
                                const next = [...assignmentExtensionRules];
                                next[index] = { ...rule, name: e.target.value.trim() || rule.extension };
                                updateAssignmentExtensionRules(next);
                              }}
                              placeholder="제출 내용"
                            />
                            <div className="flex justify-center">
                              <div className="relative group">
                                <span className={`px-2 py-0.5 text-[11px] font-bold rounded border whitespace-nowrap ${extBadgeClass(rule.extension)}`}>
                                  {rule.extension.toUpperCase()}
                                </span>
                                <button
                                  type="button"
                                  className="absolute -top-1.5 -right-1.5 hidden group-hover:flex items-center justify-center w-3.5 h-3.5 rounded-full bg-red-500 text-white"
                                  onClick={() => updateAssignmentExtensionRules(assignmentExtensionRules.filter((_, ruleIndex) => ruleIndex !== index))}
                                  title="삭제"
                                >
                                  <X size={8} />
                                </button>
                              </div>
                            </div>
                            <div className="flex justify-center">
                              <input
                                className="h-4 w-4 accent-blue-600"
                                type="checkbox"
                                checked={rule.required}
                                onChange={(e) => {
                                  const next = [...assignmentExtensionRules];
                                  next[index] = { ...rule, required: e.target.checked };
                                  updateAssignmentExtensionRules(next);
                                }}
                                aria-label={`${rule.name} 필수 제출`}
                              />
                            </div>
                            <div className="flex items-center justify-center gap-1">
                              <input
                                className="input h-7 w-14 px-1.5 py-0 text-center text-xs"
                                type="number"
                                min={1}
                                value={rule.max_file_size_mb}
                                onChange={(e) => {
                                  const next = [...assignmentExtensionRules];
                                  next[index] = { ...rule, max_file_size_mb: Number(e.target.value) };
                                  updateAssignmentExtensionRules(next);
                                }}
                              />
                              <span className="text-[11px] text-gray-500">MB</span>
                            </div>
                            <div className="flex items-center justify-center gap-1">
                              <input
                                className="input h-7 w-12 px-1.5 py-0 text-center text-xs"
                                type="number"
                                min={1}
                                value={rule.max_files}
                                onChange={(e) => {
                                  const next = [...assignmentExtensionRules];
                                  next[index] = { ...rule, max_files: Number(e.target.value) };
                                  updateAssignmentExtensionRules(next);
                                }}
                              />
                              <span className="text-[11px] text-gray-500">개</span>
                            </div>
                          </div>
                        ))}
                        {assignmentExtensionRules.length === 0 && (
                          <div className="rounded border border-dashed border-gray-200 px-2 py-3 text-xs text-gray-400">
                            제출 내용과 확장자를 추가하면 학생 화면에 항목별 업로드 버튼이 표시됩니다. 같은 확장자도 서로 다른 내용으로 여러 번 추가할 수 있습니다.
                          </div>
                        )}
                      </div>
                      <div className="mt-2 grid grid-cols-[minmax(0,1fr)_90px_32px] gap-2">
                        <input
                          className="input h-8 px-2 py-0 text-xs"
                          value={contentDraft}
                          onChange={(e) => setContentDraft(e.target.value)}
                          placeholder="내용 (예: 원본 데이터)"
                        />
                        <input
                          className="input h-8 px-2 py-0 text-xs"
                          value={extensionDraft}
                          onChange={(e) => setExtensionDraft(e.target.value.replace(/[.,\s]/g, '').toLowerCase())}
                          onKeyDown={(e) => {
                            if (e.key !== 'Enter') return;
                            e.preventDefault();
                            const next = extensionDraft.trim().replace(/^\./, '').toLowerCase();
                            const name = contentDraft.trim();
                            if (!name || !next) return;
                            updateAssignmentExtensionRules([...assignmentExtensionRules, { id: crypto.randomUUID(), name, extension: next, required: true, max_file_size_mb: 50, max_files: 1 }]);
                            setContentDraft('');
                            setExtensionDraft('');
                          }}
                          placeholder="pdf"
                        />
                        <button
                          type="button"
                          className="btn-secondary h-8 py-0 text-xs"
                          onClick={() => {
                            const next = extensionDraft.trim().replace(/^\./, '').toLowerCase();
                            const name = contentDraft.trim();
                            if (!name || !next) return;
                            updateAssignmentExtensionRules([...assignmentExtensionRules, { id: crypto.randomUUID(), name, extension: next, required: true, max_file_size_mb: 50, max_files: 1 }]);
                            setContentDraft('');
                            setExtensionDraft('');
                          }}
                        >
                          <Plus size={13} />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="rounded-lg border border-gray-200 bg-white p-4">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-gray-800">실시 기록</h3>
                  <span className="text-[11px] text-gray-400">{assignmentHistory.length}회</span>
                </div>
                {assignmentHistoryLoading ? (
                  <div className="flex justify-center py-8 text-gray-400"><Loader2 size={18} className="animate-spin" /></div>
                ) : assignmentHistory.length > 0 ? (
                  <div className="max-h-72 space-y-1.5 overflow-auto pr-1">
                    {assignmentHistory.map(run => (
                      <button
                        key={run.id}
                        type="button"
                        className="block w-full rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-left hover:border-blue-300 hover:bg-blue-50"
                        onClick={() => openRunDetail(run)}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-xs font-semibold text-gray-800">{run.room}</span>
                          <span className={`shrink-0 text-[10px] font-semibold ${Number(run.is_open) ? 'text-emerald-600' : 'text-gray-400'}`}>
                            {Number(run.is_open) ? '진행 중' : '종료'}
                          </span>
                        </div>
                        <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-gray-500">
                          <span>{formatRunTime(run.started_at, true)}</span>
                          <span className="shrink-0">대상 {run.target_count} · 제출 {run.submitted_student_count} · 파일 {run.accepted_file_count}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-md border border-dashed border-gray-200 py-7 text-center text-xs text-gray-400">
                    아직 실시 기록이 없습니다.
                  </div>
                )}
              </div>

            </div>
          </div>

          {selectedRunSummary && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
              onClick={() => { setSelectedRunSummary(null); setSelectedRunDetail(null); }}
            >
              <div
                className="flex h-[84vh] w-[min(1120px,calc(100vw-3rem))] flex-col overflow-hidden rounded-lg bg-white shadow-xl"
                onClick={event => event.stopPropagation()}
              >
                <div className="flex shrink-0 items-center justify-between border-b border-gray-200 px-5 py-3">
                  <div>
                    <h3 className="text-sm font-semibold text-gray-900">실시 상세 기록</h3>
                    <p className="mt-0.5 text-xs text-gray-500">{selectedRunSummary.room} · {formatRunTime(selectedRunSummary.started_at)}</p>
                  </div>
                  <button
                    type="button"
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100"
                    onClick={() => { setSelectedRunSummary(null); setSelectedRunDetail(null); }}
                    title="닫기"
                  >
                    <X size={17} />
                  </button>
                </div>

                {runDetailLoading || !selectedRunDetail ? (
                  <div className="flex flex-1 items-center justify-center text-gray-400"><Loader2 size={22} className="animate-spin" /></div>
                ) : (
                  <div className="min-h-0 flex-1 overflow-auto p-5">
                    <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
                      {[
                        ['상태', Number(selectedRunSummary.is_open) ? '진행 중' : '종료'],
                        ['대상', `${selectedRunSummary.target_count}명`],
                        ['결시', `${selectedRunSummary.absent_count}명`],
                        ['제출 학생', `${selectedRunSummary.submitted_student_count}명`],
                        ['파일', `${selectedRunSummary.accepted_file_count}개`],
                        ['제출 시도', `${selectedRunSummary.submission_event_count}회`],
                        ['교사 확인', `${selectedRunSummary.checked_student_count}명`],
                      ].map(([label, value]) => (
                        <div key={label} className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2">
                          <div className="text-[10px] text-gray-400">{label}</div>
                          <div className="mt-0.5 text-xs font-semibold text-gray-800">{value}</div>
                        </div>
                      ))}
                    </div>

                    <div className="mb-5">
                      <h4 className="mb-2 text-xs font-semibold text-gray-700">대상 학생</h4>
                      <div className="overflow-hidden rounded-md border border-gray-200">
                        <table className="w-full text-xs">
                          <thead className="bg-gray-50 text-gray-500">
                            <tr><th className="px-3 py-2 text-left">학생</th><th className="px-3 py-2 text-left">상태</th><th className="px-3 py-2 text-left">최근 제출</th><th className="px-3 py-2 text-left">파일</th><th className="px-3 py-2 text-center">현재 파일</th><th className="px-3 py-2 text-center">확인</th></tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100">
                            {selectedRunDetail.students.map(student => {
                              const submissions = submissionsForStudent(selectedRunDetail, student);
                              const latest = submissions[0];
                              const acceptedFiles = submissions.filter(item => item.status === 'accepted').length;
                              return (
                                <tr key={student.id} className={Number(student.is_absent) ? 'bg-red-50/50' : ''}>
                                  <td className="px-3 py-2 whitespace-nowrap">{student.class_num}반 {student.seat_num}번 {student.name}</td>
                                  <td className="px-3 py-2 whitespace-nowrap">{Number(student.is_absent) ? <span className="text-red-500">결시</span> : runSubmissionLabel(latest)}</td>
                                  <td className="px-3 py-2 whitespace-nowrap text-gray-500">{latest ? formatRunTime(latest.submitted_at) : '-'}</td>
                                  <td className="max-w-72 px-3 py-2 text-gray-600">
                                    {acceptedFiles > 0 ? submissions.filter(item => item.status === 'accepted').map(item => (
                                      <div key={item.id} className="truncate" title={`${item.submission_slot_name}: ${item.original_filename}`}>
                                        <span className="text-gray-400">{item.submission_slot_name || '파일'}:</span>{' '}
                                        {item.original_filename}
                                      </div>
                                    )) : '-'}
                                  </td>
                                  <td className="px-3 py-2 text-center">{acceptedFiles}</td>
                                  <td className="px-3 py-2 text-center">{latest && Number(latest.teacher_checked) ? '확인' : '-'}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>

                    <div>
                      <h4 className="mb-2 text-xs font-semibold text-gray-700">현재 제출 파일</h4>
                      {selectedRunDetail.submissions.length > 0 ? (
                        <div className="overflow-hidden rounded-md border border-gray-200">
                          <table className="w-full text-xs">
                            <thead className="bg-gray-50 text-gray-500">
                              <tr><th className="px-3 py-2 text-left">시간</th><th className="px-3 py-2 text-left">학생</th><th className="px-3 py-2 text-left">내용</th><th className="px-3 py-2 text-left">결과</th><th className="px-3 py-2 text-left">파일</th><th className="px-3 py-2 text-left">IP</th><th className="px-3 py-2 text-left">비고</th></tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100">
                              {selectedRunDetail.submissions.map(submission => (
                                <tr key={submission.id}>
                                  <td className="px-3 py-2 whitespace-nowrap text-gray-500">{formatRunTime(submission.submitted_at)}</td>
                                  <td className="px-3 py-2 whitespace-nowrap">{submission.class_num}반 {submission.seat_num}번 {submission.name}</td>
                                  <td className="px-3 py-2 whitespace-nowrap text-gray-500">{submission.submission_slot_name || '-'}</td>
                                  <td className="px-3 py-2 whitespace-nowrap">{runSubmissionLabel(submission)}</td>
                                  <td className="max-w-56 truncate px-3 py-2" title={submission.original_filename}>{submission.status === 'accepted' ? submission.original_filename : '-'}</td>
                                  <td className="px-3 py-2 whitespace-nowrap text-gray-500">{submission.ip_address || '-'}</td>
                                  <td className="max-w-64 truncate px-3 py-2 text-gray-500" title={submission.reject_reason || ''}>{submission.reject_reason || (Number(submission.teacher_checked) ? '교사 확인' : '-')}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <div className="rounded-md border border-dashed border-gray-200 py-6 text-center text-xs text-gray-400">현재 제출 파일이 없습니다.</div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {guideEditorOpen && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6">
              <div className="flex h-[82vh] w-[min(980px,calc(100vw-3rem))] flex-col rounded-lg bg-white shadow-xl">
                <div className="flex shrink-0 items-center justify-between border-b border-gray-200 px-4 py-3">
                  <div>
                    <h3 className="text-sm font-semibold text-gray-800">안내 사항 직접 작성</h3>
                  </div>
                  <div className="flex gap-2">
                    <button
                      className="btn-secondary py-1 text-xs"
                      onClick={() => { updateAssignmentConfig({ guide_md: guideOriginal }); setGuideEditorOpen(false); }}
                    >
                      <X size={13} />
                      닫기
                    </button>
                    <button
                      className="btn-primary py-1 text-xs"
                      onClick={async () => {
                        const ok = await saveAssignmentConfig();
                        if (ok) setGuideEditorOpen(false);
                      }}
                    >
                      <Save size={13} />
                      저장
                    </button>
                  </div>
                </div>
                <div className="grid min-h-0 flex-1 grid-cols-2 gap-0">
                  <div className="min-h-0 border-r border-gray-200 p-4">
                    <StableTextarea
                      className="textarea h-full w-full font-mono text-xs leading-relaxed"
                      value={assignmentConfig?.guide_md || ''}
                      onChange={(e) => updateAssignmentConfig({ guide_md: e.target.value, guide_url: '', resolved_guide_md: e.target.value, guide_fetch_error: '' })}
                      placeholder={'# 수행평가 안내\n\n| 항목 | 내용 |\n| --- | --- |\n| 제출물 | 보고서 |\n| 형식 | PDF |\n'}
                    />
                  </div>
                  <div className="min-h-0 p-4">
                    <div
                      className="prose-preview h-full overflow-auto rounded-md border border-gray-200 bg-gray-50 p-4 text-sm leading-relaxed text-gray-800"
                      dangerouslySetInnerHTML={{ __html: renderMarkdown(assignmentConfig?.guide_md || '안내문을 입력하세요.') }}
                    />
                  </div>
                </div>
              </div>
            </div>
          )}
        </Section>
      )}

      </div>
    </div>
  );
}
