import { RefObject } from 'react';
import { Download, Save, Trash2, Upload } from 'lucide-react';
import { PageHeaderAction } from '../../components/common/PageHeaderActions';
import { ExecutionModeMenu, HeaderFilterSelect, HeaderImportMenu, HeaderViewToggleGroup } from '../../components/common/HeaderViewControls';
import { ClassItem } from './types';

interface UseRecordsHeaderOptions {
  selectedClass: ClassItem | null;
  selectedSubject: any;
  writtenExams: Array<{ domain_name: string }>;
  showScoring: boolean;
  showComments: boolean;
  showComprehensive: boolean;
  claudeBatchJobCount: number;
  canShowScoring: boolean;
  canShowComments: boolean;
  setShowScoring: (value: boolean) => void;
  setShowComments: (value: boolean) => void;
  setShowComprehensive: (value: boolean) => void;
  domainFilter: string;
  setDomainFilter: (value: string) => void;
  uploadingZip: boolean;
  handleBulkZipUpload: (file: File) => void;
  handleBulkFolderUpload: (folderPath: string) => void;
  handleGenerateSelected: () => void;
  handleStartClaudeBatch: () => void;
  handleOpenClaudeBatchResults: () => void;
  batchGenerating: boolean;
  handleBatchSpellcheck: () => void;
  handleStartClaudeSpellcheckBatch: () => void;
  spellcheckProgress: { completed: number; total: number } | null;
  spellcheckingCount: number;
  selectedStudentCount: number;
  handleExport: (type: 'comments' | 'scoring') => void;
  saving: boolean;
  handleSaveAll: () => void;
  deleting: boolean;
  handleDeleteContent: () => void;
  uploadingFullRecords: boolean;
  fullRecordsInputRef: RefObject<HTMLInputElement>;
  handleImportFullRecords: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleExportFullRecords: () => void;
  aiEnabled: boolean;
  claudeBatchAvailable: boolean;
}

export function useRecordsHeader({
  selectedClass,
  selectedSubject,
  writtenExams,
  showScoring,
  showComments,
  showComprehensive,
  claudeBatchJobCount,
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
  spellcheckingCount,
  selectedStudentCount,
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
  claudeBatchAvailable,
}: UseRecordsHeaderOptions) {
  const showDomainControls = showScoring || showComments;
  const invalidComprehensiveMix = showComprehensive && (showScoring || showComments);
  const showGenerationActions = (showScoring !== showComments || showComprehensive) && !invalidComprehensiveMix;
  const showSpellcheckAction = showComprehensive && !showScoring && !showComments;
  const generationLabel = showScoring ? '채점' : '작성';
  const toggleView = (target: 'scoring' | 'comments' | 'comprehensive') => {
    const nextScoring = target === 'scoring' ? !showScoring : showScoring;
    const nextComments = target === 'comments' ? !showComments : showComments;
    const nextComprehensive = target === 'comprehensive' ? !showComprehensive : showComprehensive;
    if (!nextScoring && !nextComments && !nextComprehensive) return;
    if (target === 'scoring') setShowScoring(nextScoring);
    if (target === 'comments') setShowComments(nextComments);
    if (target === 'comprehensive') setShowComprehensive(nextComprehensive);
  };

  const leading = selectedClass ? (
    <div className="flex min-w-0 items-center gap-2">
      <HeaderViewToggleGroup
        options={[
          { value: 'scoring', label: '채점', active: showScoring, enabled: canShowScoring },
          { value: 'comments', label: '기록', active: showComments, enabled: canShowComments },
          { value: 'comprehensive', label: '세특', active: showComprehensive },
        ]}
        onToggle={toggleView}
      />

      {showDomainControls && (
        <HeaderFilterSelect
          value={domainFilter}
          onChange={(e) => setDomainFilter(e.target.value)}
        >
          <option value="all">전체 영역 보기</option>
          {selectedSubject?.fixedDomains.map((d: any) => (
            <option key={d.name} value={d.name}>{d.name}</option>
          ))}
          {showScoring && writtenExams.map((d) => (
            <option key={`written-${d.domain_name}`} value={d.domain_name}>{d.domain_name} (지필)</option>
          ))}
          {showComments && selectedSubject?.customDomains.map((d: any) => (
            <option key={d.name} value={d.name}>{d.name} (기록)</option>
          ))}
        </HeaderFilterSelect>
      )}
    </div>
  ) : undefined;

  const restoreAction: PageHeaderAction = {
    key: 'import-full',
    type: 'file',
    icon: <Upload size={14} />,
    loading: uploadingFullRecords,
    inputRef: fullRecordsInputRef,
    accept: '.xlsx,.xls',
    onChange: handleImportFullRecords,
    disabled: uploadingFullRecords,
    title: '복원',
    ariaLabel: '채점 기록 복원',
  };

  const renderExecutionMenu = ({
    menuKey,
    label,
    onImmediate,
    onBatch,
    disabled,
    immediateTitle,
    batchTitle,
  }: {
    menuKey: string;
    label: string;
    onImmediate: () => void;
    onBatch: () => void;
    disabled: boolean;
    immediateTitle: string;
    batchTitle: string;
  }) => <ExecutionModeMenu
    key={menuKey}
    label={label}
    onImmediate={onImmediate}
    onBatch={onBatch}
    disabled={disabled}
    batchDisabled={!claudeBatchAvailable}
    immediateTitle={immediateTitle}
    batchTitle={claudeBatchAvailable ? batchTitle : 'Claude 공급자에서만 사용할 수 있습니다.'}
  />;

  const actions: PageHeaderAction[] = [
    ...(!selectedClass ? [restoreAction] : [
    ...(showDomainControls && domainFilter !== 'all' ? [{
      key: 'bulk-artifact-upload',
      type: 'custom' as const,
      render: () => <HeaderImportMenu loading={uploadingZip} disabled={uploadingZip} onZip={handleBulkZipUpload} onFolder={handleBulkFolderUpload}/>,
    }] : []),
    ...(showGenerationActions ? [{
      key: 'generation-actions',
      type: 'custom' as const,
      render: () => renderExecutionMenu({
        menuKey: 'generation',
        label: generationLabel,
        onImmediate: handleGenerateSelected,
        onBatch: handleStartClaudeBatch,
        disabled: batchGenerating || !aiEnabled,
        immediateTitle: `선택된 항목 ${generationLabel} 즉시 처리`,
        batchTitle: `선택된 항목 ${generationLabel} Claude 배치 처리`,
      }),
    }] : []),
    ...(showSpellcheckAction ? [{
      key: 'spellcheck-actions',
      type: 'custom' as const,
      render: () => renderExecutionMenu({
        menuKey: 'spellcheck',
        label: '교정',
        onImmediate: handleBatchSpellcheck,
        onBatch: handleStartClaudeSpellcheckBatch,
        disabled: !!spellcheckProgress || spellcheckingCount > 0 || !aiEnabled,
        immediateTitle: selectedStudentCount > 0 ? '선택한 행 즉시 교정' : '전체 행 즉시 교정',
        batchTitle: selectedStudentCount > 0 ? '선택한 행 Claude 배치 교정' : '전체 행 Claude 배치 교정',
      }),
    }] : []),
    ...(claudeBatchJobCount > 0 ? [{
      key: 'claude-batch-results',
      label: `결과 (${claudeBatchJobCount})`,
      onClick: handleOpenClaudeBatchResults,
      title: 'Claude 배치 결과 확인',
    }] : []),
    {
      key: 'save',
      variant: 'primary' as const,
      label: saving ? '저장 중...' : '저장',
      icon: <Save size={14} />,
      onClick: handleSaveAll,
      disabled: saving,
      title: '저장',
      ariaLabel: '저장',
    },
    {
      key: 'delete',
      variant: 'danger' as const,
      icon: <Trash2 size={14} />,
      onClick: handleDeleteContent,
      disabled: deleting || saving || batchGenerating,
      loading: deleting,
      title: '선택한 행의 내용 삭제',
      ariaLabel: '선택한 행의 내용 삭제',
    },
    ...((showScoring && !showComments && !showComprehensive) || (!showScoring && !showComments && showComprehensive) ? [{
      key: 'export-current',
      variant: 'success' as const,
      icon: <Download size={14} />,
      onClick: () => handleExport(showScoring ? 'scoring' : 'comments'),
      title: '현재 기록 다운로드',
      ariaLabel: '현재 기록 다운로드',
    }] : []),
    restoreAction,
    {
      key: 'export-full',
      icon: <Download size={14} />,
      onClick: handleExportFullRecords,
      title: '백업',
      ariaLabel: '채점 기록 백업',
    },
    ]),
  ];

  return { leading, actions };
}
