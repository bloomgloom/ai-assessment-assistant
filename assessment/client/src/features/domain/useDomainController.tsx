import { useState, useEffect, useCallback, useRef } from 'react';
import { criteriaApi, aiApi, assignmentConfigsApi } from '../../lib/api';
import { saveBlob } from '../../lib/desktopFiles';
import { parseFirstJson } from '../../lib/json';
import { useAiAction } from '../../hooks/useAiAction';
import {
  AiPromptRow,
  AiChatMessage,
  AssignmentClassSnapshot,
  AssignmentConfig,
  AssignmentResource,
  EvalItem,
  CommentsItem,
  StandardRef,
  SubjectDomainRow,
  SubjectItem,
} from './types';
import {
  DOMAIN_GUIDE_KEY,
  DOMAIN_SELECTION_KEY,
  DomainTab,
  SUBJECT_COMPREHENSIVE_DOMAIN,
} from './constants';
import { useDomainDomainsUpload } from './useDomainDomainsUpload';
import { useDomainTree } from './useDomainTree';
import { useRecordsUnsavedStore } from '../../stores/recordsUnsavedStore';

function domainSelectionPayload(sub: SubjectItem, domain: string | null) {
  return {
    year: sub.year,
    semester: sub.semester,
    grade: sub.grade,
    subject: sub.subject,
    domain,
  };
}

function promptsToRecord(items: AiPromptRow[]) {
  return Object.fromEntries(items.map(item => [item.prompt_key, item.prompt])) as Record<string, string>;
}

function compactPromptRows(rows: AiPromptRow[]) {
  return rows.filter(item => item.prompt_key && item.prompt.trim());
}

function createDefaultCommentsItem(sortOrder = 0): CommentsItem {
  return { type: '항목', title: '기록', prompt: '', extensions: '', sort_order: sortOrder };
}

function createDefaultCommentsCommonItem(): CommentsItem {
  return { type: '공통', title: '공통', prompt: '', extensions: '', sort_order: -1 };
}

type DomainAiChatKind = 'standards' | 'scoring' | 'records';

const DOMAIN_AI_CHAT_KINDS: DomainAiChatKind[] = ['standards', 'scoring', 'records'];

function domainAiChatPromptKey(kind: DomainAiChatKind) {
  return `chat:${kind}`;
}

function messagesToPrompt(messages: AiChatMessage[], fallback: string) {
  if (messages.length === 0) return fallback;
  return messages
    .map(message => `${message.role === 'user' ? '사용자' : 'AI'}: ${message.content}`)
    .join('\n\n');
}

function parseSavedDomainAiChat(value?: string): AiChatMessage[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((message): message is AiChatMessage =>
        !!message &&
        typeof message === 'object' &&
        (message.role === 'user' || message.role === 'assistant') &&
        typeof message.content === 'string',
      )
      .map(message => ({ role: message.role, content: message.content }));
  } catch {
    return [];
  }
}

export function useDomainController() {
  const [subjects, setSubjects] = useState<SubjectItem[]>([]);

  const [selectedSubject, setSelectedSubject] = useState<SubjectItem | null>(null);
  const [selectedDomain, setSelectedDomain] = useState<string | null>(null);
  const [isCustomDomain, setIsCustomDomain] = useState<boolean>(false);

  const [commentsItems, setCommentsItems] = useState<CommentsItem[]>([]);
  const [evalItems, setEvalItems] = useState<EvalItem[]>([]);

  const [allSubjectDomains, setAllSubjectDomains] = useState<SubjectDomainRow[]>([]);
  const [standardRefs, setStandardRefs] = useState<StandardRef[]>([]);
  const [achievementStandards, setAchievementStandards] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);
  const [uploadingConfig, setUploadingConfig] = useState(false);
  const [showGuide, setShowGuide] = useState(() => localStorage.getItem(DOMAIN_GUIDE_KEY) !== '1');
  const domainsFileRef = useRef<HTMLInputElement>(null);
  const configFileRef = useRef<HTMLInputElement>(null);
  const assignmentGuideFileRef = useRef<HTMLInputElement>(null);
  const assignmentResourceFileRef = useRef<HTMLInputElement>(null);

  const [evalMetaPrompts, setEvalMetaPrompts] = useState<Record<number, string>>({});
  const [commentsMetaPrompts, setCommentsMetaPrompts] = useState<Record<number, string>>({});
  const [evalChecked, setEvalChecked] = useState<Set<number>>(new Set());
  const [commentsChecked, setCommentsChecked] = useState<Set<number>>(new Set());
  const [standardsMetaPrompt, setStandardsMetaPrompt] = useState<string>('');
  const [subjectDomainsMetaPrompt, setSubjectDomainsMetaPrompt] = useState<string>('');
  const [subjectCommentsPrompt, setSubjectCommentsPrompt] = useState<string>('');
  const [subjectCommentsChat, setSubjectCommentsChat] = useState<AiChatMessage[]>([]);
  const [subjectCommentsDraft, setSubjectCommentsDraft] = useState('');
  const [chattingSubjectComments, setChattingSubjectComments] = useState(false);
  const [generatingSubjectComments, setGeneratingSubjectComments] = useState(false);
  const [domainAiChats, setDomainAiChats] = useState<Record<DomainAiChatKind, AiChatMessage[]>>({
    standards: [],
    scoring: [],
    records: [],
  });
  const [domainAiDrafts, setDomainAiDrafts] = useState<Record<DomainAiChatKind, string>>({
    standards: '',
    scoring: '',
    records: '',
  });
  const [chattingDomainAi, setChattingDomainAi] = useState<DomainAiChatKind | null>(null);
  const [generatingStandards, setGeneratingStandards] = useState(false);
  const [generatingSubjectDomains, setGeneratingSubjectDomains] = useState(false);
  const [generatingEval, setGeneratingEval] = useState(false);
  const [generatingComments, setGeneratingComments] = useState(false);
  const [activeTab, setActiveTab] = useState<DomainTab>('standards');
  const [assignmentConfig, setAssignmentConfig] = useState<AssignmentConfig | null>(null);
  const [assignmentResources, setAssignmentResources] = useState<AssignmentResource[]>([]);
  const [assignmentClasses, setAssignmentClasses] = useState<AssignmentClassSnapshot[]>([]);
  const [assignmentLoading, setAssignmentLoading] = useState(false);
  const [assignmentUploading, setAssignmentUploading] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const setHasUnsavedChanges = useRecordsUnsavedStore(state => state.setHasUnsavedChanges);
  const runAiAction = useAiAction();
  const domainRestoredRef = useRef(false);

  useEffect(() => {
    setHasUnsavedChanges(isDirty);
    return () => setHasUnsavedChanges(false);
  }, [isDirty, setHasUnsavedChanges]);

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

  const loadSubjects = useCallback(async () => {
    const r = await criteriaApi.getSubjects();
    setSubjects(r.data);
    return r.data as SubjectItem[];
  }, []);
  const domainsUpload = useDomainDomainsUpload({
    inputRef: domainsFileRef,
    reloadSubjects: async () => { await loadSubjects(); },
  });

  useEffect(() => { loadSubjects(); }, [loadSubjects]);

  const loadAssignment = useCallback(async (sub: SubjectItem, domainName: string) => {
    setAssignmentLoading(true);
    try {
      const r = await assignmentConfigsApi.getConfig({
        year: sub.year,
        semester: sub.semester,
        grade: sub.grade,
        subject: sub.subject,
        domainName,
      });
      setAssignmentConfig(r.data.config);
      setAssignmentResources(r.data.resources || []);
      setAssignmentClasses(r.data.classes || []);
    } catch {
      setAssignmentConfig(null);
      setAssignmentResources([]);
      setAssignmentClasses([]);
    } finally {
      setAssignmentLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab !== 'assignment' || !selectedSubject || !selectedDomain || isDirty) return;
    void loadAssignment(selectedSubject, selectedDomain);
  }, [activeTab, selectedSubject, selectedDomain, loadAssignment]);

  const loadSubjectComments = useCallback(async (sub: SubjectItem) => {
    try {
      const commentsRes = await criteriaApi.getComments(
        sub.year,
        sub.semester,
        sub.grade,
        sub.subject,
        SUBJECT_COMPREHENSIVE_DOMAIN
      );
      const items = commentsRes.data as CommentsItem[];
      const criterion = items.find(item => item.type === '세특') ?? items.find(item => item.type === '종합');
      setSubjectCommentsPrompt(criterion?.prompt || '');
      let savedChat = '';
      try { savedChat = JSON.parse(criterion?.extensions || '{}').chat || ''; } catch { /* ignore */ }
      setSubjectCommentsChat(parseSavedDomainAiChat(savedChat));
      setSubjectCommentsDraft('');
    } catch {
      setSubjectCommentsPrompt('');
      setSubjectCommentsChat([]);
      setSubjectCommentsDraft('');
    }
    setChattingSubjectComments(false);
  }, []);

  const loadCriteria = useCallback(async (sub: SubjectItem, domainName: string, isCustom: boolean) => {
    setIsDirty(false);
    setDomainAiChats({ standards: [], scoring: [], records: [] });
    setDomainAiDrafts({ standards: '', scoring: '', records: '' });
    setChattingDomainAi(null);
    await loadSubjectComments(sub);
    const sr = await criteriaApi.getComments(sub.year, sub.semester, sub.grade, sub.subject, domainName);
    const allItems = sr.data as CommentsItem[];

    // '성취기준' 타입은 standardRefs로 분리, '활동공통' 타입은 공통 기준으로 분리
    const refs: StandardRef[] = allItems
      .filter(i => i.type === '성취기준')
      .map(i => { try { return JSON.parse(i.extensions || '{}'); } catch { return { domain_name_ref: '', code: '', content: '' }; } });
    setStandardRefs(refs);
    const editableComments = allItems
      .filter(i => i.type !== '성취기준' && i.type !== '활동공통')
      .map(item => item.type === '공통' ? { ...item, title: '공통' } : item);
    const hasCommonItem = editableComments.some(i => i.type === '공통');
    const hasRecordItem = editableComments.some(i => i.type === '항목');
    const domainComments = domainName !== SUBJECT_COMPREHENSIVE_DOMAIN
      ? [
        ...(hasCommonItem ? [] : [createDefaultCommentsCommonItem()]),
        ...editableComments,
        ...(hasRecordItem ? [] : [createDefaultCommentsItem(editableComments.length + 1)]),
      ]
      : editableComments;
    setCommentsItems(domainComments);

    // 성취기준 관리 데이터 로드 (과목/영역 자동 생성 모두 성취기준을 참조)
    try {
      const stdRes = await criteriaApi.getStandards(sub.year, sub.semester, sub.grade, sub.subject);
      setAchievementStandards(stdRes.data);
    } catch { setAchievementStandards([]); }

    if (!isCustom && domainName !== SUBJECT_COMPREHENSIVE_DOMAIN) {
      const er = await criteriaApi.getEval(sub.year, sub.semester, sub.grade, sub.subject, domainName);
      let loaded = er.data as EvalItem[];
      loaded.sort((a, b) => a.sort_order - b.sort_order);
      if (!loaded.find(i => i.item_type === 'formula')) {
        loaded.unshift({ name: '합계', score: '0', item_type: 'formula', rubric: '', sort_order: -1 });
      }
      setEvalItems(loaded);

    } else {
      setEvalItems([]);
    }

    try {
      const promptRes = await criteriaApi.getAiPrompts(sub.year, sub.semester, sub.grade, sub.subject, domainName);
      const savedPrompts = promptsToRecord(promptRes.data as AiPromptRow[]);
      setSubjectDomainsMetaPrompt(savedPrompts.subject_domains || '');
      setStandardsMetaPrompt(savedPrompts.standards || '');
      setEvalMetaPrompts(Object.fromEntries(
        Object.entries(savedPrompts)
          .filter(([key]) => key === 'eval_items' || key.startsWith('eval_item:'))
          .map(([key, value]) => [key === 'eval_items' ? -1 : Number(key.slice('eval_item:'.length)), value])
      ));
      setCommentsMetaPrompts(Object.fromEntries(
        Object.entries(savedPrompts)
          .filter(([key]) => key === 'comments_items' || key.startsWith('comments_item:'))
          .map(([key, value]) => [key === 'comments_items' ? -1 : Number(key.slice('comments_item:'.length)), value])
      ));
      setDomainAiChats({
        standards: parseSavedDomainAiChat(savedPrompts[domainAiChatPromptKey('standards')]),
        scoring: parseSavedDomainAiChat(savedPrompts[domainAiChatPromptKey('scoring')]),
        records: parseSavedDomainAiChat(savedPrompts[domainAiChatPromptKey('records')]),
      });
    } catch {
      setSubjectDomainsMetaPrompt('');
      setStandardsMetaPrompt('');
      setEvalMetaPrompts({});
      setCommentsMetaPrompts({});
      setDomainAiChats({ standards: [], scoring: [], records: [] });
    }
    if (domainName !== SUBJECT_COMPREHENSIVE_DOMAIN) {
      await loadAssignment(sub, domainName);
    } else {
      setAssignmentConfig(null);
      setAssignmentResources([]);
      setAssignmentClasses([]);
    }
  }, [loadAssignment, loadSubjectComments]);

  const handleSelectDomain = useCallback((sub: SubjectItem, domain: string, isCustom: boolean) => {
    if (isDirty && !confirm('저장되지 않은 변경 사항이 있습니다. 이동하시겠습니까?')) return;
    setSelectedSubject(sub);
    setSelectedDomain(domain);
    setIsCustomDomain(isCustom);
    setAllSubjectDomains([]);
    setEvalChecked(new Set());
    setCommentsChecked(new Set());
    setActiveTab('standards');
    loadCriteria(sub, domain, isCustom);
    localStorage.setItem(DOMAIN_SELECTION_KEY, JSON.stringify(domainSelectionPayload(sub, domain)));
  }, [isDirty, loadCriteria]);

  const handleSelectSubject = useCallback(async (sub: SubjectItem) => {
    if (isDirty && !confirm('저장되지 않은 변경 사항이 있습니다. 이동하시겠습니까?')) return;
    setSelectedSubject(sub);
    setSelectedDomain(null);
    setIsCustomDomain(true);
    setCommentsChecked(new Set());
    setActiveTab('ratio');
    loadCriteria(sub, SUBJECT_COMPREHENSIVE_DOMAIN, true);
    const dr = await criteriaApi.getSubjectDomains(sub.year, sub.semester, sub.grade, sub.subject);
    setAllSubjectDomains(dr.data);
    localStorage.setItem(DOMAIN_SELECTION_KEY, JSON.stringify(domainSelectionPayload(sub, null)));
  }, [isDirty, loadCriteria]);

  useEffect(() => {
    if (!selectedSubject || subjects.length === 0) return;
    const fresh = subjects.find(s =>
      s.year === selectedSubject.year &&
      s.semester === selectedSubject.semester &&
      s.grade === selectedSubject.grade &&
      s.subject === selectedSubject.subject
    );
    if (!fresh) return;
    if (fresh === selectedSubject) return;
    setSelectedSubject(fresh);
  }, [subjects, selectedSubject]);

  // 마지막 선택 복원
  useEffect(() => {
    if (domainRestoredRef.current || subjects.length === 0) return;
    domainRestoredRef.current = true;
    const saved = localStorage.getItem(DOMAIN_SELECTION_KEY);
    if (!saved) return;
    try {
      const { classId, year, semester, grade, subject, domain } = JSON.parse(saved);
      const sub = subjects.find(s =>
        year !== undefined
          ? s.year === year && s.semester === semester && s.grade === grade && s.subject === subject
          : s.class_id === classId
      );
      if (!sub) return;
      if (domain) {
        const isCustom = sub.customDomains.some((d: any) => d.name === domain);
        handleSelectDomain(sub, domain, isCustom);
      } else {
        handleSelectSubject(sub);
      }
    } catch { /* ignore */ }
  }, [subjects, handleSelectDomain, handleSelectSubject]);

  const handleSave = async (): Promise<boolean> => {
    if (!selectedSubject) return false;
    if (!selectedDomain && subjectAssessmentRatioError) {
      alert(subjectAssessmentRatioError);
      return false;
    }
    const domainToSave = selectedDomain || SUBJECT_COMPREHENSIVE_DOMAIN;
    setSaving(true);
    try {
      if (!selectedDomain) {
        await criteriaApi.bulkSaveSubjectDomains(
          selectedSubject.year,
          selectedSubject.semester,
          selectedSubject.grade,
          selectedSubject.subject,
          allSubjectDomains
        );
        await loadSubjects();
      }

      if (selectedDomain) {
        // standardRefs를 '성취기준' 타입 아이템으로 변환 후 앞에 붙임
        const refItems: CommentsItem[] = standardRefs.map((r, i) => ({
          type: '성취기준',
          title: r.code,
          prompt: '',
          extensions: JSON.stringify(r),
          sort_order: i,
        }));
        const sItems = [
          ...refItems,
          ...commentsItems.map((item, i) => ({ ...item, sort_order: refItems.length + i })),
        ];
        await criteriaApi.bulkSaveComments(selectedSubject.year, selectedSubject.semester, selectedSubject.grade, selectedSubject.subject, domainToSave, sItems);
      }

      await criteriaApi.bulkSaveComments(
        selectedSubject.year,
        selectedSubject.semester,
        selectedSubject.grade,
        selectedSubject.subject,
        SUBJECT_COMPREHENSIVE_DOMAIN,
        [{
          type: '세특',
          title: '세특',
          prompt: subjectCommentsPrompt,
          extensions: JSON.stringify({ chat: JSON.stringify(subjectCommentsChat) }),
          sort_order: 0,
        }]
      );

      const aiPromptRows = compactPromptRows([
        ...(!selectedDomain ? [{ prompt_key: 'subject_domains', prompt: subjectDomainsMetaPrompt }] : []),
        ...(selectedDomain ? [{ prompt_key: 'standards', prompt: standardsMetaPrompt }] : []),
        ...(selectedDomain ? Object.entries(evalMetaPrompts).map(([key, prompt]) => ({
          prompt_key: Number(key) === -1 ? 'eval_items' : `eval_item:${key}`,
          prompt,
        })) : []),
        ...(selectedDomain ? Object.entries(commentsMetaPrompts).map(([key, prompt]) => ({
          prompt_key: Number(key) === -1 ? 'comments_items' : `comments_item:${key}`,
          prompt,
        })) : []),
        ...(selectedDomain ? DOMAIN_AI_CHAT_KINDS.map(kind => ({
          prompt_key: domainAiChatPromptKey(kind),
          prompt: JSON.stringify(domainAiChats[kind]),
        })) : []),
      ]);
      await criteriaApi.bulkSaveAiPrompts(
        selectedSubject.year,
        selectedSubject.semester,
        selectedSubject.grade,
        selectedSubject.subject,
        domainToSave,
        aiPromptRows
      );

      if (selectedDomain && !isCustomDomain) {
        const eItems = evalItems.map((item, j) => ({ ...item, sort_order: item.item_type === 'formula' ? -1 : j }));
        await criteriaApi.bulkSaveEval(selectedSubject.year, selectedSubject.semester, selectedSubject.grade, selectedSubject.subject, selectedDomain, eItems);
      }
      if (selectedDomain && assignmentConfig) {
        await assignmentConfigsApi.saveConfig({
          year: selectedSubject.year,
          semester: selectedSubject.semester,
          grade: selectedSubject.grade,
          subject: selectedSubject.subject,
          domainName: selectedDomain,
          title: assignmentConfig.title || `${selectedSubject.subject} ${selectedDomain}`,
          guide_md: assignmentConfig.guide_md || '',
          guide_url: assignmentConfig.guide_url || '',
          allowed_extensions: assignmentConfig.allowed_extensions || '',
          max_file_size_mb: Number(assignmentConfig.max_file_size_mb) || 50,
          max_files: Number(assignmentConfig.max_files) || 1,
        });
        await loadAssignment(selectedSubject, selectedDomain);
      }
      alert('저장되었습니다.');
      setIsDirty(false);
      return true;
    } catch (e) {
      alert('저장 실패');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const hideGuide = () => {
    localStorage.setItem(DOMAIN_GUIDE_KEY, '1');
    setShowGuide(false);
  };

  const clearDomainSelection = () => {
    setSelectedSubject(null);
    setSelectedDomain(null);
    setAllSubjectDomains([]);
    setStandardRefs([]);
    setCommentsItems([]);
    setEvalItems([]);
    setAchievementStandards([]);
    setAssignmentConfig(null);
    setAssignmentResources([]);
    setAssignmentClasses([]);
    localStorage.removeItem(DOMAIN_SELECTION_KEY);
  };

  const updateAssignmentConfig = (patch: Partial<AssignmentConfig>) => {
    setAssignmentConfig(prev => prev ? { ...prev, ...patch } : prev);
    setIsDirty(true);
  };

  const saveAssignmentConfig = async (overrides: Partial<AssignmentConfig> = {}) => {
    if (!selectedSubject || !selectedDomain || !assignmentConfig) return true;
    const nextConfig = { ...assignmentConfig, ...overrides };
    await assignmentConfigsApi.saveConfig({
      year: selectedSubject.year,
      semester: selectedSubject.semester,
      grade: selectedSubject.grade,
      subject: selectedSubject.subject,
      domainName: selectedDomain,
      title: `${selectedSubject.subject} ${selectedDomain}`,
      guide_md: nextConfig.guide_md || '',
      guide_url: nextConfig.guide_url || '',
      allowed_extensions: nextConfig.allowed_extensions || '',
      max_file_size_mb: Number(nextConfig.max_file_size_mb) || 50,
      max_files: Number(nextConfig.max_files) || 1,
    });
    await loadAssignment(selectedSubject, selectedDomain);
    setIsDirty(false);
    return true;
  };

  const handleAssignmentGuideUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!selectedSubject || !selectedDomain || !e.target.files?.length) return;
    setAssignmentUploading(true);
    try {
      const r = await assignmentConfigsApi.uploadGuideMd({
        year: selectedSubject.year,
        semester: selectedSubject.semester,
        grade: selectedSubject.grade,
        subject: selectedSubject.subject,
        domainName: selectedDomain,
      }, e.target.files[0]);
      setAssignmentConfig(prev => prev ? { ...prev, guide_md: r.data.guide_md || '', guide_url: '', resolved_guide_md: r.data.guide_md || '', guide_fetch_error: '' } : prev);
      setIsDirty(true);
    } catch (err: any) {
      alert(`Markdown 업로드 실패: ${err?.response?.data?.error || err.message || String(err)}`);
    } finally {
      setAssignmentUploading(false);
      e.target.value = '';
    }
  };

  const handleAssignmentResourceUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!selectedSubject || !selectedDomain || !e.target.files?.length) return;
    setAssignmentUploading(true);
    try {
      await saveAssignmentConfig();
      await assignmentConfigsApi.uploadResources({
        year: selectedSubject.year,
        semester: selectedSubject.semester,
        grade: selectedSubject.grade,
        subject: selectedSubject.subject,
        domainName: selectedDomain,
      }, e.target.files);
      await loadAssignment(selectedSubject, selectedDomain);
    } catch (err: any) {
      alert(`자료 업로드 실패: ${err?.response?.data?.error || err.message || String(err)}`);
    } finally {
      setAssignmentUploading(false);
      e.target.value = '';
    }
  };

  const addAssignmentResourceLink = async (url: string, title = '') => {
    if (!selectedSubject || !selectedDomain) return false;
    setAssignmentUploading(true);
    try {
      const existing = assignmentResources.find(resource => resource.source_url === url);
      if (existing) {
        await assignmentConfigsApi.refreshResourceLink(existing.id);
      } else {
        await assignmentConfigsApi.addResourceLink({
          year: selectedSubject.year,
          semester: selectedSubject.semester,
          grade: selectedSubject.grade,
          subject: selectedSubject.subject,
          domainName: selectedDomain,
          url,
          title,
        });
      }
      await loadAssignment(selectedSubject, selectedDomain);
      return true;
    } catch (err: any) {
      alert(`GitHub 자료 연결 실패: ${err?.response?.data?.error || err.message || String(err)}`);
      return false;
    } finally {
      setAssignmentUploading(false);
    }
  };

  const deleteAssignmentResource = async (id: number) => {
    if (!confirm('자료 파일을 삭제하시겠습니까?')) return;
    await saveAssignmentConfig();
    await assignmentConfigsApi.deleteResource(id);
    if (selectedSubject && selectedDomain) await loadAssignment(selectedSubject, selectedDomain);
  };

  const getDownloadFilename = (disposition: string, fallback: string) => {
    const utf8Match = disposition.match(/filename\*=UTF-8''(.+)/i);
    const plainMatch = disposition.match(/filename="?([^";]+)"?/i);
    return utf8Match ? decodeURIComponent(utf8Match[1]) : plainMatch ? plainMatch[1] : fallback;
  };

  const handleDownloadConfig = async () => {
    if (!selectedSubject) return;
    try {
      const r = selectedDomain
        ? await criteriaApi.exportDomainConfig(
          selectedSubject.year,
          selectedSubject.semester,
          selectedSubject.grade,
          selectedSubject.subject,
          selectedDomain
        )
        : await criteriaApi.exportSubjectConfig(
          selectedSubject.year,
          selectedSubject.semester,
          selectedSubject.grade,
          selectedSubject.subject
        );
      await saveBlob(
        getDownloadFilename(
          r.headers['content-disposition'] || '',
          selectedDomain
            ? `${selectedSubject.year}_${selectedSubject.subject}_${selectedDomain}_기준.xlsx`
            : `${selectedSubject.year}_${selectedSubject.subject}_평가영역.xlsx`
        ),
        r.data
      );
    } catch {
      alert('기준 다운로드 실패');
    }
  };

  const handleUploadConfig = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files?.length) return;
    const file = e.target.files[0];
    const domainName = selectedSubject ? selectedDomain || SUBJECT_COMPREHENSIVE_DOMAIN : SUBJECT_COMPREHENSIVE_DOMAIN;
    const confirmMessage = selectedSubject && !selectedDomain
      ? '현재 과목의 평가 영역 목록을 업로드한 엑셀 내용으로 덮어씁니다. 계속하시겠습니까?'
      : selectedSubject
        ? '현재 영역의 기준과 세특 기준을 업로드한 엑셀 내용으로 덮어씁니다. 계속하시겠습니까?'
      : '엑셀 파일의 기본정보에 있는 과목/영역으로 작업 내용을 업로드합니다. 계속하시겠습니까?';
    if (!confirm(confirmMessage)) {
      e.target.value = '';
      return;
    }
    setUploadingConfig(true);
    try {
      const r = selectedSubject && !selectedDomain
        ? await criteriaApi.importSubjectConfig(
          selectedSubject.year,
          selectedSubject.semester,
          selectedSubject.grade,
          selectedSubject.subject,
          file
        )
        : selectedSubject
          ? await criteriaApi.importDomainConfig(
          selectedSubject.year,
          selectedSubject.semester,
          selectedSubject.grade,
          selectedSubject.subject,
          domainName,
          file
        )
          : await criteriaApi.importDomainConfigFile(file);
      const imported = r.data as {
        kind?: 'subject' | 'domain';
        year: number;
        semester: number;
        grade: number;
        subject: string;
        domainName?: string;
        domains?: number;
        standards?: number;
        eval?: number;
        comments?: number;
        comprehensive?: number;
        prompts?: number;
      };
      const refreshedSubjects = await loadSubjects();
      const targetSubject = refreshedSubjects.find(sub =>
        sub.year === imported.year &&
        sub.semester === imported.semester &&
        sub.grade === imported.grade &&
        sub.subject === imported.subject
      );
      if (targetSubject) {
        if (imported.kind === 'subject') {
          await handleSelectSubject(targetSubject);
        } else {
          const importedDomain = imported.domainName || domainName;
          if (importedDomain === SUBJECT_COMPREHENSIVE_DOMAIN) {
            await handleSelectSubject(targetSubject);
          } else {
            const custom = targetSubject.customDomains.some(d => d.name === importedDomain);
            handleSelectDomain(targetSubject, importedDomain, custom);
          }
        }
      } else if (selectedSubject) {
        await loadCriteria(selectedSubject, domainName, isCustomDomain || !selectedDomain);
      }
      if (imported.kind === 'subject') {
        alert(`업로드 완료: 평가 영역 ${imported.domains ?? 0}개, AI 요청 ${imported.prompts ?? 0}개`);
      } else {
        alert(`업로드 완료: 성취 기준 ${imported.standards ?? 0}개, 채점 기준 ${imported.eval ?? 0}개, 기록 기준 ${imported.comments ?? 0}개, 세특 기준 ${imported.comprehensive ?? 0}개, AI 요청 ${imported.prompts ?? 0}개`);
      }
    } catch (err: any) {
      alert(`기준 업로드 실패: ${err?.response?.data?.error || err.message || String(err)}`);
    } finally {
      setUploadingConfig(false);
      if (configFileRef.current) configFileRef.current.value = '';
    }
  };

  const domainTree = useDomainTree({
    subjects,
    selectedSubject,
    selectedDomain,
    onSelectDomain: handleSelectDomain,
    onSelectSubject: handleSelectSubject,
    onClearSelection: clearDomainSelection,
    reloadSubjects: async () => { await loadSubjects(); },
  });

  const subjectHasUploadedFile = !!selectedSubject?.has_source;
  const subjectAssessmentRows = allSubjectDomains.filter(row => row.eval_type === '지필' || row.eval_type === '수행');
  const subjectAssessmentRatioTotal = subjectAssessmentRows.reduce((sum, row) => sum + (Number(row.ratio) || 0), 0);
  const subjectAssessmentRatioInvalid = !subjectHasUploadedFile && subjectAssessmentRows.length > 0 && subjectAssessmentRatioTotal !== 100;
  const subjectAssessmentRatioError = subjectAssessmentRatioInvalid
    ? `지필/수행 반영비율 합계가 ${subjectAssessmentRatioTotal}%입니다. 합계가 100%가 되도록 수정하세요.`
    : null;
  const isLockedSubjectDomainRow = (row: SubjectDomainRow) => !!row.source_filename;
  const normalizeSubjectDomainRow = (row: SubjectDomainRow): SubjectDomainRow => ({
    ...row,
    eval_type: subjectHasUploadedFile ? '기록' : row.eval_type,
    reflected: subjectHasUploadedFile || row.eval_type === '기록' ? 'X' : 'O',
    ratio: subjectHasUploadedFile || row.eval_type === '기록' ? 0 : (row.ratio === '' ? '' : Number(row.ratio)),
    max_score: subjectHasUploadedFile || row.eval_type === '기록' ? 0 : (row.max_score === '' ? '' : Number(row.max_score)),
  });
  const updateSubjectDomainRow = (idx: number, patch: Partial<SubjectDomainRow>) => {
    setAllSubjectDomains(prev => prev.map((row, i) => {
      if (i !== idx || isLockedSubjectDomainRow(row)) return row;
      const next = normalizeSubjectDomainRow({ ...row, ...patch });
      return next;
    }));
    setIsDirty(true);
  };
  const addSubjectDomainRow = () => {
    const next: SubjectDomainRow = normalizeSubjectDomainRow({
      id: `new-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      eval_type: subjectHasUploadedFile ? '기록' : '수행',
      name: '',
      reflected: subjectHasUploadedFile ? 'X' : 'O',
      ratio: 0,
      max_score: 0,
      source_filename: '',
    });
    setAllSubjectDomains(prev => [...prev, next]);
    setIsDirty(true);
  };
  const removeSubjectDomainRow = (idx: number) => {
    setAllSubjectDomains(prev => prev.filter((row, i) => i !== idx || isLockedSubjectDomainRow(row)));
    setIsDirty(true);
  };

  const updateCommentsItem = (idx: number, field: keyof CommentsItem, value: string) => {
    setCommentsItems(p => p.map((item, i) => i === idx ? { ...item, [field]: value } : item));
    setIsDirty(true);
  };
  const removeCommentsItem = (idx: number) => {
    setCommentsItems(p => p.filter((_, i) => i !== idx));
    setIsDirty(true);
  };

  const addDomainCommentsItem = () => {
    setCommentsItems(p => [...p, createDefaultCommentsItem(p.length)]);
    setIsDirty(true);
  };

  const moveIndexedState = <T,>(
    values: Record<number, T>,
    from: number,
    to: number,
    length: number,
  ) => {
    const order = Array.from({ length }, (_, index) => index);
    const [moved] = order.splice(from, 1);
    order.splice(to, 0, moved);
    return Object.fromEntries(
      order.flatMap((oldIndex, newIndex) =>
        values[oldIndex] === undefined ? [] : [[newIndex, values[oldIndex]]]
      )
    ) as Record<number, T>;
  };

  const moveCheckedState = (values: Set<number>, from: number, to: number, length: number) => {
    const order = Array.from({ length }, (_, index) => index);
    const [moved] = order.splice(from, 1);
    order.splice(to, 0, moved);
    const oldToNew = new Map(order.map((oldIndex, newIndex) => [oldIndex, newIndex]));
    return new Set([...values].map(index => oldToNew.get(index)).filter((index): index is number => index !== undefined));
  };

  const moveCommentsItem = (from: number, to: number) => {
    if (from === to) return;
    const length = commentsItems.length;
    setCommentsItems(prev => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
    setCommentsMetaPrompts(values => moveIndexedState(values, from, to, length));
    setCommentsChecked(values => moveCheckedState(values, from, to, length));
    setIsDirty(true);
  };

  const runAiJsonArrayGeneration = async <T,>({
    title,
    errorMessage,
    setLoading,
    prompt,
    systemPrompt,
    outputSchema,
    onGenerated,
    emptyMessage,
  }: {
    title: string;
    errorMessage: string;
    setLoading: (loading: boolean) => void;
    prompt: string;
    systemPrompt: string;
    outputSchema: Record<string, unknown>;
    onGenerated: (items: T[]) => void;
    emptyMessage?: string;
  }) => {
    await runAiAction({
      title,
      errorMessage,
      setLoading,
    }, async ({ signal }) => {
      const res = await aiApi.generatePrompt({ prompt, systemPrompt, outputSchema }, signal);
      const parsed = parseFirstJson<{ items?: T[] }>(res.data.result, 'object');
      const items = parsed.items;
      if (!Array.isArray(items)) throw new Error('AI 응답의 items가 배열이 아닙니다.');
      if (items.length === 0) {
        if (emptyMessage) alert(emptyMessage);
        return;
      }
      onGenerated(items);
      setIsDirty(true);
    });
  };

  const setDomainAiDraft = (kind: DomainAiChatKind, value: string) => {
    setDomainAiDrafts(prev => ({ ...prev, [kind]: value }));
  };

  const setDomainAiFallbackPrompt = (kind: DomainAiChatKind, value: string) => {
    if (kind === 'standards') setStandardsMetaPrompt(value);
    if (kind === 'scoring') setEvalMetaPrompts(prev => ({ ...prev, [-1]: value }));
    if (kind === 'records') setCommentsMetaPrompts(prev => ({ ...prev, [-1]: value }));
    setIsDirty(true);
  };

  const getDomainAiFallbackPrompt = (kind: DomainAiChatKind) => {
    if (kind === 'standards') return standardsMetaPrompt;
    if (kind === 'scoring') return evalMetaPrompts[-1] || '';
    return commentsMetaPrompts[-1] || '';
  };

  const buildCurrentStandardsItemsContext = () => {
    const items = standardRefs
      .filter(item => item.code || item.content)
      .map(item => `  - ${item.code || '(코드 없음)'}${item.domain_name_ref ? ` [${item.domain_name_ref}]` : ''}${item.content ? `: ${item.content}` : ''}`);
    return items.length > 0 ? `현재 성취 기준 항목:\n${items.join('\n')}` : '';
  };

  const buildCurrentScoringItemsContext = () => {
    const items = evalItems
      .filter(item => item.item_type === 'llm' && (item.name || item.score || item.rubric))
      .map(item => `  - ${item.name || '(항목명 없음)'}(${item.score || '?'}점)${item.rubric ? `: ${item.rubric}` : ''}`);
    const common = evalItems.find(item => item.item_type === 'formula');
    const parts: string[] = [];
    if (common && (common.score || common.rubric)) {
      parts.push(`  공통(${common.score || '0'}점): ${common.rubric || '(내용 없음)'}`);
    }
    if (items.length > 0) parts.push(...items);
    return parts.length > 0 ? `현재 채점 기준 항목:\n${parts.join('\n')}` : '';
  };

  const buildCurrentRecordsItemsContext = () => {
    const items = commentsItems
      .filter(item => item.type !== '공통' && (item.title || item.prompt))
      .map(item => `  - ${item.title || '(항목명 없음)'}${item.prompt ? `: ${item.prompt}` : ''}`);
    const common = commentsItems.find(item => item.type === '공통');
    const parts: string[] = [];
    if (common?.prompt?.trim()) parts.push(`  공통: ${common.prompt.trim()}`);
    if (items.length > 0) parts.push(...items);
    return parts.length > 0 ? `현재 기록 기준 항목:\n${parts.join('\n')}` : '';
  };

  const buildCurrentGeneratedCriteriaContext = (kind: DomainAiChatKind) => {
    if (kind === 'standards') return buildCurrentStandardsItemsContext();
    if (kind === 'scoring') return buildCurrentScoringItemsContext();
    return buildCurrentRecordsItemsContext();
  };

  const buildDomainAiBaseContext = (kind: DomainAiChatKind) => {
    const stdCtx = buildStandardsContext();
    const actCtx = buildActivityContext();
    const currentCriteriaCtx = buildCurrentGeneratedCriteriaContext(kind);
    const parts = [
      `과목: ${selectedSubject?.subject || ''}`,
      `영역: ${selectedDomain || ''}`,
      stdCtx && kind !== 'standards' ? `성취 기준:\n${stdCtx}` : '',
      actCtx && kind === 'records' ? actCtx : '',
      currentCriteriaCtx,
    ].filter(Boolean);
    return parts.join('\n\n');
  };

  const handleDomainAiChatSend = async (kind: DomainAiChatKind) => {
    const content = domainAiDrafts[kind].trim();
    if (!content) return;
    const nextMessages: AiChatMessage[] = [...domainAiChats[kind], { role: 'user', content }];
    setDomainAiChats(prev => ({ ...prev, [kind]: nextMessages }));
    setDomainAiDraft(kind, '');
    setDomainAiFallbackPrompt(kind, messagesToPrompt(nextMessages, content));
    setChattingDomainAi(kind);
    try {
      const label = kind === 'standards' ? '성취 기준' : kind === 'scoring' ? '채점 기준' : '기록 기준';
      const systemPrompt = `당신은 ${label} 생성을 돕는 교육 평가 설계 AI입니다. 사용자의 요구를 구체화하고, 부족한 조건이 있으면 짧게 확인 질문을 하세요. 최종 JSON은 생성 버튼을 눌렀을 때 만들 예정이므로 지금은 대화 응답만 하세요.`;
      const prompt = [
        buildDomainAiBaseContext(kind),
        `대화 기록:\n${messagesToPrompt(nextMessages, content)}`,
      ].filter(Boolean).join('\n\n');
      const res = await aiApi.generatePrompt({ prompt, systemPrompt });
      const assistantMessage: AiChatMessage = { role: 'assistant', content: String(res.data.result || '').trim() };
      const withAssistant = [...nextMessages, assistantMessage];
      setDomainAiChats(prev => ({ ...prev, [kind]: withAssistant }));
      setDomainAiFallbackPrompt(kind, messagesToPrompt(withAssistant, content));
    } catch (e: unknown) {
      const msg =
        e && typeof e === 'object' && 'response' in e
          ? ((e as { response?: { data?: { error?: string } } }).response?.data?.error ?? String(e))
          : String(e);
      alert(`채팅 응답 생성 실패: ${msg}`);
    } finally {
      setChattingDomainAi(null);
    }
  };

  const clearDomainAiChat = (kind: DomainAiChatKind) => {
    setDomainAiChats(prev => ({ ...prev, [kind]: [] }));
    setDomainAiDraft(kind, '');
    if (kind === 'standards') setStandardsMetaPrompt('');
    if (kind === 'scoring') setEvalMetaPrompts(prev => ({ ...prev, [-1]: '' }));
    if (kind === 'records') setCommentsMetaPrompts(prev => ({ ...prev, [-1]: '' }));
    setIsDirty(true);
  };

  const handleGenerateSubjectDomains = async () => {
    if (!selectedSubject) return;
    const existingRows = allSubjectDomains.map(row => ({
      eval_type: row.eval_type,
      name: row.name,
      reflected: row.reflected,
      ratio: row.ratio,
      max_score: row.max_score,
      locked: !!row.source_filename,
    }));
    const standardsContext = achievementStandards.length > 0
      ? Array.from(
        new Map(achievementStandards.map((s: any) => [s.code, s])).values()
      ).map((s: any) => `${s.domain_name ? `[${s.domain_name}] ` : ''}${s.code} ${String(s.content || '').replace(s.code, '').trim()}`)
        .join('\n')
      : '';
    const systemPrompt = subjectHasUploadedFile
      ? '당신은 평가 영역 구성 AI입니다. 업로드 원본 행은 수정할 수 없으므로 세특 전용 기록 영역만 생성하세요.'
      : '당신은 평가 영역 구성 AI입니다. 과목 성취기준을 참고해 지필/수행/기록 영역을 생성하세요. 지필/수행 행의 ratio 합계는 반드시 100이 되게 하고 reflected는 O로 하세요. 기록 행은 reflected를 X로 하세요.';
    const prompt = [
      `과목: ${selectedSubject.subject}`,
      subjectHasUploadedFile ? '조건: 파일 업로드 과목이므로 새 행은 기록 영역만 가능' : '조건: 지필/수행 반영비율 합계는 100',
      standardsContext ? `과목 성취기준:\n${standardsContext}` : '',
      subjectDomainsMetaPrompt.trim() ? `추가 요청: ${subjectDomainsMetaPrompt.trim()}` : '',
      `현재 행: ${JSON.stringify(existingRows)}`,
    ].filter(Boolean).join('\n');
    await runAiJsonArrayGeneration<any>({
      title: '반영비율/만점관리 생성 중',
      errorMessage: '반영비율/만점관리 생성에 실패했습니다.',
      setLoading: setGeneratingSubjectDomains,
      prompt,
      systemPrompt,
      outputSchema: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                eval_type: { type: 'string', enum: subjectHasUploadedFile ? ['기록'] : ['지필', '수행', '기록'] },
                name: { type: 'string' },
                reflected: { type: 'string', enum: subjectHasUploadedFile ? ['X'] : ['O', 'X'] },
                ratio: { type: 'number' },
                max_score: { type: 'number' },
              },
              required: ['eval_type', 'name', 'reflected', 'ratio', 'max_score'],
              additionalProperties: false,
            },
          },
        },
        required: ['items'],
        additionalProperties: false,
      },
      emptyMessage: '생성된 행이 없습니다.',
      onGenerated: (parsed) => {
      const generated = parsed
        .filter((row: any) => row && row.name)
        .map((row: any, idx: number) => normalizeSubjectDomainRow({
          id: `ai-${Date.now()}-${idx}`,
          eval_type: subjectHasUploadedFile ? '기록' : (['지필', '수행', '기록'].includes(row.eval_type) ? row.eval_type : '수행'),
          name: String(row.name || ''),
          reflected: row.eval_type === '기록' || subjectHasUploadedFile ? 'X' : 'O',
          ratio: Number(row.ratio) || 0,
          max_score: Number(row.max_score) || 0,
          source_filename: '',
        }));
      if (generated.length === 0) return alert('생성된 행이 없습니다.');
      setAllSubjectDomains(prev => [
        ...prev.filter(row => isLockedSubjectDomainRow(row)),
        ...generated,
      ]);
      },
    });
  };

  // 성취기준 참조 헬퍼
  const addStandardRef = () => {
    setStandardRefs(p => [...p, { domain_name_ref: '', code: '', content: '' }]);
    setIsDirty(true);
  };
  const removeStandardRef = (idx: number) => {
    setStandardRefs(p => p.filter((_, i) => i !== idx));
    setIsDirty(true);
  };
  const updateStandardRefDomain = (idx: number, domain: string) => {
    setStandardRefs(p => p.map((r, i) => i === idx ? { ...r, domain_name_ref: domain, code: '', content: '', level: '' } : r));
    setIsDirty(true);
  };
  const updateStandardRefCode = (idx: number, code: string) => {
    // 항상 A 레벨 행을 우선 참조
    const candidates = achievementStandards.filter(s => s.code === code);
    const std = candidates.find(s => s.level === 'A') ?? candidates[0];
    setStandardRefs(p => p.map((r, i) => i === idx ? { ...r, code, content: std?.content || '' } : r));
    setIsDirty(true);
  };

  // 성취기준 데이터 보조
  const uniqueStandardDomains = [...new Set(achievementStandards.map(s => s.domain_name))];
  const uniqueCodesForDomain = (domain: string) => {
    const seen = new Set<string>();
    return achievementStandards.filter(s => s.domain_name === domain && !seen.has(s.code) && seen.add(s.code));
  };
  const updateSubjectCommentsPrompt = (prompt: string) => {
    setSubjectCommentsPrompt(prompt);
    setIsDirty(true);
  };

  const addEvalItem = () => {
    setEvalItems(p => [...p, { name: '', score: '2', item_type: 'llm', rubric: '', sort_order: p.length }]);
    setIsDirty(true);
  };
  const updateEvalItem = (idx: number, field: keyof EvalItem, value: string) => {
    setEvalItems(p => p.map((item, i) => i === idx ? { ...item, [field]: value } : item));
    setIsDirty(true);
  };
  const removeEvalItem = (idx: number) => {
    setEvalItems(p => p.filter((item, i) => i !== idx || item.item_type === 'formula'));
    setIsDirty(true);
  };
  const moveEvalItem = (from: number, to: number) => {
    if (from === to) return;
    if (evalItems[from]?.item_type === 'formula' || evalItems[to]?.item_type === 'formula') return;
    const length = evalItems.length;
    setEvalItems(prev => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
    setEvalMetaPrompts(values => moveIndexedState(values, from, to, length));
    setEvalChecked(values => moveCheckedState(values, from, to, length));
    setIsDirty(true);
  };

  const handleGenerateStandards = async () => {
    if (achievementStandards.length === 0) return alert('성취기준을 먼저 업로드하세요.');
    await runAiJsonArrayGeneration<string>({
      title: '성취 기준 선택 중',
      errorMessage: '생성 실패: 다시 시도해주세요.',
      setLoading: setGeneratingStandards,
      systemPrompt: '당신은 교육과정 성취기준 선택 AI입니다. 주어진 성취기준 목록에서 적합한 성취기준의 code를 선택하세요.',
      outputSchema: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: { type: 'string' },
          },
        },
        required: ['items'],
        additionalProperties: false,
      },
      prompt: (() => {
      // 코드 기준으로 중복 제거
      const uniqueStandards: any[] = Array.from(
        new Map(achievementStandards.map((s: any) => [s.code, s])).values()
      );
      const stdList = uniqueStandards.map((s: any) =>
        `{"code":"${s.code}","domain":"${s.domain_name}","content":${JSON.stringify(s.content)}}`
      ).join('\n');
      const base = `과목: ${selectedSubject?.subject}\n영역: ${selectedDomain}`;
      const chatContext = messagesToPrompt(domainAiChats.standards, standardsMetaPrompt);
      const extra = chatContext.trim() ? `\n대화 맥락 및 추가 요청:\n${chatContext.trim()}` : '\n위 과목과 영역에 가장 관련성 높은 성취기준을 2~4개 선택해주세요.';
      return `${base}${extra}\n\n사용 가능한 성취기준 목록:\n${stdList}`;
      })(),
      emptyMessage: '선택된 성취기준이 없습니다. 다시 시도해보세요.',
      onGenerated: (codes) => {
      const uniqueStandards: any[] = Array.from(
        new Map(achievementStandards.map((s: any) => [s.code, s])).values()
      );
      const selected = uniqueStandards.filter((s: any) => codes.includes(s.code));
      if (selected.length === 0) return alert('선택된 성취기준이 없습니다. 다시 시도해보세요.');
      setStandardRefs(selected.map((s: any) => ({
        domain_name_ref: s.domain_name,
        code: s.code,
        content: s.content,
      })));
      },
    });
  };

  const handleSubjectCommentsChatSend = async () => {
    const content = subjectCommentsDraft.trim();
    if (!content || !selectedSubject) return;
    const nextMessages: AiChatMessage[] = [...subjectCommentsChat, { role: 'user', content }];
    setSubjectCommentsChat(nextMessages);
    setSubjectCommentsDraft('');
    setChattingSubjectComments(true);
    setIsDirty(true);
    try {
      const prompt = [
        `과목: ${selectedSubject.subject}`,
        subjectCommentsPrompt.trim() ? `현재 세특 기준:\n${subjectCommentsPrompt.trim()}` : '',
        `대화 기록:\n${messagesToPrompt(nextMessages, content)}`,
      ].filter(Boolean).join('\n\n');
      const systemPrompt = '당신은 과목 세특 작성 기준 설계를 돕는 교육 AI입니다. 사용자의 요구를 구체화하고, 부족한 조건이 있으면 짧게 확인 질문을 하세요. 최종 기준은 생성 버튼을 눌렀을 때 만들 예정이므로 지금은 대화 응답만 하세요.';
      const res = await aiApi.generatePrompt({ prompt, systemPrompt });
      setSubjectCommentsChat(messages => [
        ...messages,
        { role: 'assistant', content: String(res.data.result || '').trim() },
      ]);
    } catch (e: unknown) {
      const msg =
        e && typeof e === 'object' && 'response' in e
          ? ((e as { response?: { data?: { error?: string } } }).response?.data?.error ?? String(e))
          : String(e);
      alert(`채팅 응답 생성 실패: ${msg}`);
    } finally {
      setChattingSubjectComments(false);
    }
  };

  const clearSubjectCommentsChat = () => {
    setSubjectCommentsChat([]);
    setSubjectCommentsDraft('');
    setIsDirty(true);
  };

  const handleGenerateSubjectComments = async () => {
    if (!selectedSubject) return;
    await runAiAction({
      title: '세특 기준 생성 중',
      errorMessage: '세특 기준 생성에 실패했습니다.',
      setLoading: setGeneratingSubjectComments,
    }, async ({ signal }) => {
      const systemPrompt = '당신은 과목 세특 작성 기준 생성 AI입니다. 과목과 대화 내용을 바탕으로 학생별 세특을 작성할 때 적용할 하나의 통합 지시 프롬프트를 작성하세요. 개별 항목이나 번호 목록으로 나누지 말고, 부가 설명 없이 기준 내용만 반환하세요.';
      const prompt = [
        `과목: ${selectedSubject.subject}`,
        subjectCommentsPrompt.trim() ? `현재 세특 기준:\n${subjectCommentsPrompt.trim()}` : '',
        subjectCommentsChat.length > 0 ? `대화 기록:\n${messagesToPrompt(subjectCommentsChat, '')}` : '',
        subjectCommentsChat.length === 0 ? '학생의 과목 활동 전체를 종합하여 구체적이고 근거 중심으로 작성할 수 있는 세특 기준을 생성해주세요.' : '',
      ].filter(Boolean).join('\n\n');
      const res = await aiApi.generatePrompt({ prompt, systemPrompt }, signal);
      updateSubjectCommentsPrompt(res.data.result.trim());
    });
  };

  // 성취 기준 컨텍스트 문자열 빌더
  const buildStandardsContext = () =>
    standardRefs.filter(r => r.content).map(r => `[${r.code}] ${r.content}`).join('\n');

  // 채점 기준 컨텍스트 빌더
  const buildActivityContext = () => {
    const parts: string[] = [];
    const formulaRubric = evalItems.find(i => i.item_type === 'formula')?.rubric?.trim();
    const itemRubrics = evalItems
      .filter(i => i.item_type === 'llm' && (i.name || i.rubric))
      .map(i => `  - ${i.name}(${i.score}점)${i.rubric ? `: ${i.rubric}` : ''}`)
      .join('\n');
    if (formulaRubric || itemRubrics) {
      const scoringParts: string[] = [];
      if (formulaRubric) scoringParts.push(`  공통: ${formulaRubric}`);
      if (itemRubrics) scoringParts.push(itemRubrics);
      parts.push(`채점 기준:\n${scoringParts.join('\n')}`);
    }
    return parts.join('\n\n');
  };

  // 채점 항목 목록 AI 생성
  const handleGenerateEvalItems = async () => {
    const formulaItem = evalItems.find(i => i.item_type === 'formula');
    const stdCtx = buildStandardsContext();
    const base = `과목: ${selectedSubject?.subject}\n영역: ${selectedDomain}`;
    const stdPart = stdCtx ? `\n\n성취 기준:\n${stdCtx}` : '';
    const maxScore = currentMaxScore > 0 ? `${currentMaxScore}점` : '미설정';
    const baseScore = formulaItem ? `${formulaItem.score}점` : '0점';
    const chatContext = messagesToPrompt(domainAiChats.scoring, evalMetaPrompts[-1] || '');
    const extra = chatContext.trim() ? `\n\n대화 맥락 및 추가 요청:\n${chatContext.trim()}` : '';
    await runAiJsonArrayGeneration<any>({
      title: '채점 항목 생성 중',
      errorMessage: '생성 실패',
      setLoading: setGeneratingEval,
      systemPrompt: '당신은 채점 기준 생성 AI입니다. 과목·영역·성취기준을 참고하여 공통 채점 기준 1개와 항목별 채점 기준을 생성하세요. item 배점 합계는 만점에서 기본점수를 뺀 값이어야 합니다.',
      outputSchema: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['common', 'item'] },
                title: { type: 'string' },
                score: { type: 'string' },
                rubric: { type: 'string' },
              },
              required: ['type', 'title', 'score', 'rubric'],
              additionalProperties: false,
            },
          },
        },
        required: ['items'],
        additionalProperties: false,
      },
      prompt: `${base}\n만점: ${maxScore}, 기본점수: ${baseScore}${stdPart}${extra}`,
      onGenerated: (newItems) => {
      setEvalItems(prev => {
        const fItems = prev.filter(i => i.item_type === 'formula');
        const generatedCommon = newItems.find((item: any) => item?.type === 'common');
        const common = fItems[0] || { name: '공통', score: '0', item_type: 'formula' as const, rubric: '', sort_order: -1 };
        const nextCommon = {
          ...common,
          name: '공통',
          score: String(generatedCommon?.score ?? common.score ?? '0'),
          rubric: String(generatedCommon?.rubric ?? generatedCommon?.content ?? common.rubric ?? ''),
        };
        const itemRows = newItems.filter((item: any) => item?.type !== 'common');
        return [nextCommon, ...itemRows.map((item: any, j: number) => ({
          name: item.title || item.name || '',
          score: String(item.score ?? '2'),
          rubric: item.rubric || item.content || '',
          item_type: 'llm' as const,
          sort_order: j,
        }))];
      });
      },
    });
  };

  // 채점 항목 루브릭 AI 생성 (소제목 옆 버튼 - 선택/전체 항목)
  const handleGenerateEvalRubrics = async () => {
    const llmIndices = evalItems.map((_, i) => i).filter(i => evalItems[i].item_type !== 'formula');
    const targets = evalChecked.size > 0 ? llmIndices.filter(i => evalChecked.has(i)) : llmIndices;
    if (targets.length === 0) return;
    const targetLabel = evalChecked.size > 0 ? `선택한 ${evalChecked.size}개` : `전체 ${targets.length}개`;
    if (!confirm(`${targetLabel} 채점 루브릭을 AI로 생성하시겠습니까?`)) return;
    await runAiAction({
      title: '채점 루브릭 생성 중',
      errorMessage: '생성 실패',
      setLoading: setGeneratingEval,
      initialProgress: { progress: 0, message: `0/${targets.length} 완료` },
    }, async ({ signal, setProgress }) => {
      const stdCtx = buildStandardsContext();
      const base = `과목: ${selectedSubject?.subject}\n영역: ${selectedDomain}`;
      const stdPart = stdCtx ? `\n\n성취 기준:\n${stdCtx}` : '';
      const systemPrompt = `당신은 채점 기준 생성 AI입니다. 과목·영역·성취기준·항목명·배점을 참고하여 채점 루브릭(기준 내용)을 생성하세요. 루브릭 내용만 반환하고 부가 설명은 하지 마세요.`;
      for (let i = 0; i < targets.length; i++) {
        if (signal.aborted) break;
        const idx = targets[i];
        const item = evalItems[idx];
        const extra = evalMetaPrompts[idx]?.trim() ? `\n추가 요청: ${evalMetaPrompts[idx]}` : '';
        const prompt = `${base}\n항목명: ${item.name || '(미입력)'}\n배점: ${item.score || '?'}점${stdPart}${extra}`;
        const res = await aiApi.generatePrompt({ prompt, systemPrompt }, signal);
        updateEvalItem(idx, 'rubric', res.data.result.trim());
        setProgress(((i + 1) / targets.length) * 100, `${i + 1}/${targets.length} 완료`);
      }
    });
  };

  // 활동 기록 항목 목록 AI 생성
  const handleGenerateCommentsItems = async () => {
    const stdCtx = buildStandardsContext();
    const actCtx = buildActivityContext();
    const base = `과목: ${selectedSubject?.subject}\n영역: ${selectedDomain}`;
    const stdPart = stdCtx ? `\n\n성취 기준:\n${stdCtx}` : '';
    const actPart = actCtx ? `\n\n${actCtx}` : '';
    const chatContext = messagesToPrompt(domainAiChats.records, commentsMetaPrompts[-1] || '');
    const extra = chatContext.trim() ? `\n\n대화 맥락 및 추가 요청:\n${chatContext.trim()}` : '';
    await runAiJsonArrayGeneration<any>({
      title: '기록 기준 항목 생성 중',
      errorMessage: '생성 실패',
      setLoading: setGeneratingComments,
      systemPrompt: '당신은 기록 기준 생성 AI입니다. 과목·영역·성취기준·채점기준을 참고하여 공통 기록 기준 1개와 항목별 기록 기준을 생성하세요.',
      outputSchema: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['common', 'item'] },
                title: { type: 'string' },
                prompt: { type: 'string' },
              },
              required: ['type', 'title', 'prompt'],
              additionalProperties: false,
            },
          },
        },
        required: ['items'],
        additionalProperties: false,
      },
      prompt: `${base}${stdPart}${actPart}${extra}`,
      onGenerated: (newItems) => {
      const generatedCommon = newItems.find((item: any) => item?.type === 'common');
      const common = {
        ...createDefaultCommentsCommonItem(),
        title: '공통',
        prompt: generatedCommon?.prompt || generatedCommon?.content || '',
      };
      const itemRows = newItems.filter((item: any) => item?.type !== 'common');
      setCommentsItems([
        common,
        ...itemRows.map((item: any, j: number) => ({
          title: item.title || '',
          prompt: item.prompt || item.content || '',
          type: '항목',
          extensions: '',
          sort_order: j,
        })),
      ]);
      },
    });
  };

  // 활동 기록 항목 기준 AI 생성 (소제목 옆 버튼 - 선택/전체 항목)
  const handleGenerateCommentsCriteria = async () => {
    const targets = commentsChecked.size > 0
      ? commentsItems.map((_, i) => i).filter(i => commentsChecked.has(i))
      : commentsItems.map((_, i) => i);
    if (targets.length === 0) return;
    const targetLabel = commentsChecked.size > 0 ? `선택한 ${commentsChecked.size}개` : `전체 ${targets.length}개`;
    if (!confirm(`${targetLabel} 기록 작성 기준을 AI로 생성하시겠습니까?`)) return;
    await runAiAction({
      title: '기록 작성 기준 생성 중',
      errorMessage: '생성 실패',
      setLoading: setGeneratingComments,
      initialProgress: { progress: 0, message: `0/${targets.length} 완료` },
    }, async ({ signal, setProgress }) => {
      const stdCtx = buildStandardsContext();
      const actCtx = buildActivityContext();
      const base = `과목: ${selectedSubject?.subject}\n영역: ${selectedDomain}`;
      const stdPart = stdCtx ? `\n\n성취 기준:\n${stdCtx}` : '';
      const actPart = actCtx ? `\n\n${actCtx}` : '';
      const systemPrompt = `당신은 기록 기준 생성 AI입니다. 과목·영역·성취기준·채점기준·항목명을 참고하여 활동 기록 작성 지시사항을 생성하세요. 지시사항 내용만 반환하고 부가 설명은 하지 마세요.`;
      for (let i = 0; i < targets.length; i++) {
        if (signal.aborted) break;
        const idx = targets[i];
        const item = commentsItems[idx];
        const extra = commentsMetaPrompts[idx]?.trim() ? `\n\n추가 요청: ${commentsMetaPrompts[idx]}` : '';
        const prompt = `${base}\n항목명: ${item.title || '(미입력)'}${stdPart}${actPart}${extra}`;
        const res = await aiApi.generatePrompt({ prompt, systemPrompt }, signal);
        updateCommentsItem(idx, 'prompt', res.data.result.trim());
        setProgress(((i + 1) / targets.length) * 100, `${i + 1}/${targets.length} 완료`);
      }
    });
  };

  // 계산 로직
  const calculateTotal = () => {
    let total = 0;
    let base = 0;
    evalItems.forEach(item => {
      if (item.item_type === 'formula') {
        base = Number(item.score) || 0;
      } else if (item.item_type === 'llm') {
        total += Number(item.score) || 0;
      }
    });
    return total + base;
  };

  const currentMaxScore = selectedSubject?.fixedDomains.find(d => d.name === selectedDomain)?.max_score || 0;
  const calculatedScore = calculateTotal();
  const isScoreMismatch = !isCustomDomain && currentMaxScore > 0 && calculatedScore !== currentMaxScore;

  return {
    selectedSubject,
    selectedDomain,
    isCustomDomain,
    activeTab,
    setActiveTab,
    domainsFileRef,
    configFileRef,
    assignmentGuideFileRef,
    assignmentResourceFileRef,
    uploadingDomains: domainsUpload.uploading,
    uploadingConfig,
    uploadMessage: domainsUpload.message,
    uploadError: domainsUpload.error,
    showGuide,
    hideGuide,
    domainTree,
    saving,
    handleSave,
    handleDomainsUpload: domainsUpload.handleUpload,
    handleUploadConfig,
    handleDownloadConfig,
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
  };
}
