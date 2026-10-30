import { BookOpen, Download, Upload } from 'lucide-react';
import { CRITERIA_PAGE_TEXT } from './constants';
import { useCriteriaController } from './useCriteriaController';

export function useCriteriaPage() {
  const { fileRef, configFileRef, guide, criteria, standardsUpload, handleDownloadConfig, handleUploadConfig } = useCriteriaController();

  return {
    sidebar: {
      title: CRITERIA_PAGE_TEXT.sidebarTitle,
      upload: {
        label: CRITERIA_PAGE_TEXT.uploadLabel,
        loading: standardsUpload.uploading,
        input: (
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            accept=".xlsx,.xls"
            onChange={standardsUpload.handleUpload}
            disabled={standardsUpload.uploading}
          />
        ),
      },
      notices: [
        {
          type: 'guide' as const,
          visible: guide.visible,
          title: CRITERIA_PAGE_TEXT.guideTitle,
          lines: [...CRITERIA_PAGE_TEXT.guideLines],
          onDismiss: guide.dismiss,
        },
        { type: 'message' as const, visible: !!standardsUpload.message, tone: 'success' as const, text: standardsUpload.message },
        { type: 'message' as const, visible: !!standardsUpload.error, tone: 'error' as const, text: standardsUpload.error },
      ],
      tree: {
        nodes: criteria.tree.nodes,
        empty: {
          icon: <BookOpen size={32} />,
          message: CRITERIA_PAGE_TEXT.emptyTreeMessage,
          addYear: true,
          onAddYear: () => criteria.tree.addNode(),
        },
        addYear: true,
        onAddYear: () => criteria.tree.addNode(),
        node: criteria.tree.node,
      },
    },
    header: {
      eyebrow: criteria.selected ? `${criteria.selected.year}학년도 ${criteria.selected.semester}학기 ${criteria.selected.grade}학년 > ${criteria.selected.subject}` : undefined,
      title: criteria.selected ? criteria.selected.domain_name : CRITERIA_PAGE_TEXT.sidebarTitle,
      actions: [
        {
          key: 'upload-config',
          type: 'file' as const,
          icon: <Upload size={14} />,
          inputRef: configFileRef,
          accept: '.xlsx,.xls',
          onChange: handleUploadConfig,
          title: '복원',
          ariaLabel: '성취 기준 복원',
        },
        ...(criteria.selected ? [{
          key: 'download-config',
          icon: <Download size={14} />,
          onClick: handleDownloadConfig,
          title: '백업',
          ariaLabel: '성취 기준 백업',
        }] : []),
      ],
    },
    contentProps: {
      selected: !!criteria.selected,
      standards: criteria.standards,
    },
  };
}
