import { Award, BookOpen, CalendarRange, ClipboardCheck, Download, FileText, RefreshCw, Save, School, Sparkles, Upload } from 'lucide-react';
import { PageHeaderAction } from '../../components/common/PageHeaderActions';
import { PageTab } from '../../components/common/PageTabs';
import { DOMAIN_PAGE_TEXT, DOMAIN_TAB_TEXT, DomainTab } from './constants';
import { useDomainController } from './useDomainController';
import { useAiEnabled } from '../../hooks/useAiEnabled';
import { useRecordsUnsavedStore } from '../../stores/recordsUnsavedStore';
import { useEffect } from 'react';
import { subscribeLessonJournalLinkChanged } from '../../components/common/LessonJournalLink';

export function useDomainPage() {
  const domain = useDomainController();
  const aiEnabled = useAiEnabled();
  const hasUnsavedChanges = useRecordsUnsavedStore(state => state.hasUnsavedChanges);
  const lessonTab = ['lesson-plans', 'activity-records', 'activity-summary'].includes(domain.activeTab);
  useEffect(() => subscribeLessonJournalLinkChanged(() => { void domain.reloadSubjects(); }), [domain.reloadSubjects]);

  const domainTabs: PageTab<DomainTab>[] = [
    { ...DOMAIN_TAB_TEXT.domainTabs.standards, icon: <Award size={14} /> },
    ...(!domain.isCustomDomain ? [{ ...DOMAIN_TAB_TEXT.domainTabs.scoring, icon: <ClipboardCheck size={14} /> }] : []),
    {
      value: DOMAIN_TAB_TEXT.domainTabs.records.value,
      label: DOMAIN_TAB_TEXT.domainTabs.records.label,
      icon: <BookOpen size={14} />,
      color: domain.isCustomDomain ? DOMAIN_TAB_TEXT.domainTabs.records.customColor : DOMAIN_TAB_TEXT.domainTabs.records.color,
    },
    { ...DOMAIN_TAB_TEXT.domainTabs.comments, icon: <Sparkles size={14} /> },
    { ...DOMAIN_TAB_TEXT.domainTabs.assignment, icon: <FileText size={14} /> },
  ];
  const subjectTabs: PageTab<DomainTab>[] = [
    { ...DOMAIN_TAB_TEXT.subjectTabs.ratio, icon: <ClipboardCheck size={14} /> },
    { ...DOMAIN_TAB_TEXT.subjectTabs.lessonPlans, icon: <CalendarRange size={14} /> },
    { ...DOMAIN_TAB_TEXT.subjectTabs.activityRecords, icon: <BookOpen size={14} /> },
    { ...DOMAIN_TAB_TEXT.subjectTabs.activitySummary, icon: <Sparkles size={14} /> },
  ];
  const headerActions: PageHeaderAction[] = [
    ...(domain.selectedSubject && lessonTab ? [
      ...([{
        key: 'lesson-refresh', icon: <RefreshCw size={14} />,
        onClick: () => window.dispatchEvent(new Event('lesson-plan-refresh')),
        title: '새로고침', ariaLabel: '새로고침',
      }]),
      {
        key: 'lesson-save', variant: 'primary' as const, label: '저장', icon: <Save size={14} />,
        onClick: () => window.dispatchEvent(new Event('lesson-plan-save')),
        title: '저장', ariaLabel: '저장',
      },
      {
        key: 'lesson-download', variant: 'success' as const, icon: <Download size={14} />,
        onClick: () => window.dispatchEvent(new Event('lesson-plan-download')),
        title: '차시별 진도계획 다운로드', ariaLabel: '차시별 진도계획 다운로드',
      },
      {
        key: 'lesson-backup-upload', icon: <Upload size={14} />,
        onClick: () => window.dispatchEvent(new Event('lesson-plan-backup-upload')),
        title: '복원', ariaLabel: '수업 계획 복원',
      },
      {
        key: 'lesson-backup-download', icon: <Download size={14} />,
        onClick: () => window.dispatchEvent(new Event('lesson-plan-backup-download')),
        title: '백업', ariaLabel: '수업 계획 백업',
      },
    ] : []),
    ...(domain.selectedSubject && !lessonTab ? [{
      key: 'save',
      variant: 'primary' as const,
      label: domain.saving ? DOMAIN_PAGE_TEXT.savingLabel : DOMAIN_PAGE_TEXT.saveLabel,
      icon: <Save size={14} />,
      onClick: domain.handleSave,
      disabled: domain.saving,
      title: DOMAIN_PAGE_TEXT.saveLabel,
      ariaLabel: DOMAIN_PAGE_TEXT.saveLabel,
    }] : []),
    ...(!lessonTab ? [{
      key: 'upload-config',
      type: 'file',
      icon: <Upload size={14} />,
      inputRef: domain.configFileRef,
      accept: '.xlsx,.xls',
      onChange: domain.handleUploadConfig,
      loading: domain.uploadingConfig,
      disabled: domain.uploadingConfig,
      title: '복원',
      ariaLabel: '평가 영역 복원',
    } as PageHeaderAction] : []),
    ...(domain.selectedSubject && !lessonTab ? [{
      key: 'download-config',
      icon: <Download size={14} />,
      onClick: domain.handleDownloadConfig,
      title: '백업',
      ariaLabel: '평가 영역 백업',
    }] : []),
  ];

  return {
    sidebar: {
      title: DOMAIN_PAGE_TEXT.sidebarTitle,
      upload: {
        label: DOMAIN_PAGE_TEXT.uploadLabel,
        loading: domain.uploadingDomains,
        input: <input ref={domain.domainsFileRef} type="file" className="hidden" accept=".xlsx,.xls" onChange={domain.handleDomainsUpload} disabled={domain.uploadingDomains}/>,
      },
      notices: [
        {
          type: 'guide' as const,
          visible: domain.showGuide,
          title: DOMAIN_PAGE_TEXT.guideTitle,
          lines: [...DOMAIN_PAGE_TEXT.guideLines],
          onDismiss: domain.hideGuide,
        },
        { type: 'message' as const, visible: !!domain.uploadMessage, tone: 'success' as const, text: domain.uploadMessage },
        { type: 'message' as const, visible: !!domain.uploadError, tone: 'error' as const, text: domain.uploadError },
      ],
      tree: {
        nodes: domain.domainTree.visibleTree,
        empty: {
          icon: <School size={32} />,
          message: <>{DOMAIN_PAGE_TEXT.emptyTreeMessageLines[0]}<br />{DOMAIN_PAGE_TEXT.emptyTreeMessageLines[1]}</>,
          addYear: true,
          onAddYear: () => domain.domainTree.addNode(),
        },
        addYear: true,
        onAddYear: () => domain.domainTree.addNode(),
        node: domain.domainTree.nodeConfig,
      },
    },
    header: {
      eyebrow: domain.selectedSubject
        ? domain.selectedDomain
          ? `${domain.selectedSubject.year}학년도 ${domain.selectedSubject.semester}학기 ${domain.selectedSubject.grade}학년 > ${domain.selectedSubject.subject}`
          : `${domain.selectedSubject.year}학년도 ${domain.selectedSubject.semester}학기 ${domain.selectedSubject.grade}학년`
        : undefined,
      title: domain.selectedSubject
        ? domain.selectedDomain ? domain.selectedDomain : domain.selectedSubject.subject
        : DOMAIN_PAGE_TEXT.sidebarTitle,
      actions: headerActions,
    },
    tabs: domain.selectedSubject ? {
      value: domain.activeTab,
      tabs: domain.selectedDomain ? domainTabs : subjectTabs,
      onChange: (value: DomainTab) => {
        if (value !== domain.activeTab && hasUnsavedChanges && !confirm('저장되지 않은 변경 사항이 있습니다. 이동하시겠습니까?')) return;
        domain.setActiveTab(value);
      },
    } : undefined,
    contentProps: {
      selectedSubject: domain.selectedSubject,
      selectedDomain: domain.selectedDomain,
      activeTab: domain.activeTab,
      isCustomDomain: domain.isCustomDomain,
      subjectDomainsMetaPrompt: domain.subjectDomainsMetaPrompt,
      setSubjectDomainsMetaPrompt: domain.setSubjectDomainsMetaPrompt,
      generatingSubjectDomains: domain.generatingSubjectDomains,
      handleGenerateSubjectDomains: domain.handleGenerateSubjectDomains,
      subjectAssessmentRatioError: domain.subjectAssessmentRatioError,
      subjectAssessmentRatioInvalid: domain.subjectAssessmentRatioInvalid,
      allSubjectDomains: domain.allSubjectDomains,
      subjectHasUploadedFile: domain.subjectHasUploadedFile,
      isLockedSubjectDomainRow: domain.isLockedSubjectDomainRow,
      updateSubjectDomainRow: domain.updateSubjectDomainRow,
      removeSubjectDomainRow: domain.removeSubjectDomainRow,
      addSubjectDomainRow: domain.addSubjectDomainRow,
      achievementStandards: domain.achievementStandards,
      standardsMetaPrompt: domain.standardsMetaPrompt,
      setStandardsMetaPrompt: domain.setStandardsMetaPrompt,
      domainAiChats: domain.domainAiChats,
      domainAiDrafts: domain.domainAiDrafts,
      chattingDomainAi: domain.chattingDomainAi,
      setDomainAiDraft: domain.setDomainAiDraft,
      handleDomainAiChatSend: domain.handleDomainAiChatSend,
      clearDomainAiChat: domain.clearDomainAiChat,
      generatingStandards: domain.generatingStandards,
      handleGenerateStandards: domain.handleGenerateStandards,
      addStandardRef: domain.addStandardRef,
      standardRefs: domain.standardRefs,
      uniqueStandardDomains: domain.uniqueStandardDomains,
      uniqueCodesForDomain: domain.uniqueCodesForDomain,
      updateStandardRefDomain: domain.updateStandardRefDomain,
      updateStandardRefCode: domain.updateStandardRefCode,
      removeStandardRef: domain.removeStandardRef,
      evalItems: domain.evalItems,
      currentMaxScore: domain.currentMaxScore,
      calculatedScore: domain.calculatedScore,
      isScoreMismatch: domain.isScoreMismatch,
      updateEvalItem: domain.updateEvalItem,
      evalMetaPrompts: domain.evalMetaPrompts,
      setEvalMetaPrompts: domain.setEvalMetaPrompts,
      setIsDirty: domain.setIsDirty,
      handleGenerateEvalItems: domain.handleGenerateEvalItems,
      generatingEval: domain.generatingEval,
      handleGenerateEvalRubrics: domain.handleGenerateEvalRubrics,
      addEvalItem: domain.addEvalItem,
      evalChecked: domain.evalChecked,
      setEvalChecked: domain.setEvalChecked,
      removeEvalItem: domain.removeEvalItem,
      moveEvalItem: domain.moveEvalItem,
      commentsMetaPrompts: domain.commentsMetaPrompts,
      setCommentsMetaPrompts: domain.setCommentsMetaPrompts,
      handleGenerateCommentsItems: domain.handleGenerateCommentsItems,
      generatingComments: domain.generatingComments,
      handleGenerateCommentsCriteria: domain.handleGenerateCommentsCriteria,
      addDomainCommentsItem: domain.addDomainCommentsItem,
      commentsItems: domain.commentsItems,
      commentsChecked: domain.commentsChecked,
      setCommentsChecked: domain.setCommentsChecked,
      updateCommentsItem: domain.updateCommentsItem,
      removeCommentsItem: domain.removeCommentsItem,
      moveCommentsItem: domain.moveCommentsItem,
      subjectCommentsPrompt: domain.subjectCommentsPrompt,
      updateSubjectCommentsPrompt: domain.updateSubjectCommentsPrompt,
      subjectCommentsChat: domain.subjectCommentsChat,
      subjectCommentsDraft: domain.subjectCommentsDraft,
      setSubjectCommentsDraft: domain.setSubjectCommentsDraft,
      chattingSubjectComments: domain.chattingSubjectComments,
      generatingSubjectComments: domain.generatingSubjectComments,
      handleSubjectCommentsChatSend: domain.handleSubjectCommentsChatSend,
      handleGenerateSubjectComments: domain.handleGenerateSubjectComments,
      clearSubjectCommentsChat: domain.clearSubjectCommentsChat,
      aiEnabled,
      assignmentGuideFileRef: domain.assignmentGuideFileRef,
      assignmentResourceFileRef: domain.assignmentResourceFileRef,
      assignmentConfig: domain.assignmentConfig,
      assignmentResources: domain.assignmentResources,
      assignmentClasses: domain.assignmentClasses,
      assignmentLoading: domain.assignmentLoading,
      assignmentUploading: domain.assignmentUploading,
      updateAssignmentConfig: domain.updateAssignmentConfig,
      saveAssignmentConfig: domain.saveAssignmentConfig,
      handleAssignmentGuideUpload: domain.handleAssignmentGuideUpload,
      handleAssignmentResourceUpload: domain.handleAssignmentResourceUpload,
      addAssignmentResourceLink: domain.addAssignmentResourceLink,
      deleteAssignmentResource: domain.deleteAssignmentResource,
    },
  };
}
