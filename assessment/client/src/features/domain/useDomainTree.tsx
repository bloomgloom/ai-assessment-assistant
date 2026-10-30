import { useMemo } from 'react';
import { criteriaApi } from '../../lib/api';
import {
  AcademicTreeNode,
  buildAcademicTree,
  createAcademicParentPathDrafts,
} from '../../components/common/academicTree';
import { AcademicTreeControllerHelpers, useAcademicTreeController } from '../../hooks/useAcademicTreeController';
import { saveBlob } from '../../lib/desktopFiles';
import { openLessonJournalLinkDialog } from '../../components/common/LessonJournalLink';
import {
  DOMAIN_SOURCE_TYPE,
  DOMAIN_TREE_KEY_PREFIXES,
  DOMAIN_TREE_TEXT,
} from './constants';
import { SubjectItem } from './types';

type DomainTreeNode = AcademicTreeNode<SubjectItem>;

function downloadFilename(disposition: string, fallback: string) {
  const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  const plainMatch = disposition.match(/filename="?([^";]+)"?/i);
  return utf8Match ? decodeURIComponent(utf8Match[1]) : plainMatch ? plainMatch[1] : fallback;
}

interface UseDomainTreeOptions {
  subjects: SubjectItem[];
  selectedSubject: SubjectItem | null;
  selectedDomain: string | null;
  onSelectDomain: (subject: SubjectItem, domain: string, isCustom: boolean) => void;
  onSelectSubject: (subject: SubjectItem) => void;
  onClearSelection: () => void;
  reloadSubjects: () => Promise<void>;
}

function buildDomainTree(subjects: SubjectItem[]): DomainTreeNode[] {
  return buildAcademicTree(subjects, {
    keyPrefixes: DOMAIN_TREE_KEY_PREFIXES,
    getDomainEntries: ([sub]) => [
      ...sub.fixedDomains.map(domain => ({ name: domain.name, subject: sub, isCustom: false })),
      ...sub.customDomains.map(domain => ({ name: domain.name, subject: sub, isCustom: true })),
    ],
  });
}

function isSameSubject(a: SubjectItem | null, b: Pick<SubjectItem, 'year' | 'semester' | 'grade' | 'subject'>) {
  return !!a && a.year === b.year && a.semester === b.semester && a.grade === b.grade && a.subject === b.subject;
}

function preserveParentPath(
  sub: Pick<SubjectItem, 'year' | 'semester' | 'grade'>,
  helpers: AcademicTreeControllerHelpers<SubjectItem>,
) {
  const parents = createAcademicParentPathDrafts<SubjectItem>(DOMAIN_TREE_KEY_PREFIXES, sub);
  helpers.setDraftNodes(prev => {
    const keys = new Set(prev.map(node => node.key));
    return [...prev, ...parents.filter(node => !keys.has(node.key))];
  });
}

export function useDomainTree({
  subjects,
  selectedSubject,
  selectedDomain,
  onSelectDomain,
  onSelectSubject,
  onClearSelection,
  reloadSubjects,
}: UseDomainTreeOptions) {
  const tree = useMemo(() => buildDomainTree(subjects), [subjects]);
  const selectedDomainKey = selectedSubject && selectedDomain
    ? `${selectedSubject.year}-${selectedSubject.semester}-${selectedSubject.grade}-${selectedSubject.subject}-${selectedDomain}`
    : null;
  const selectedSubjectKey = selectedSubject
    ? `${selectedSubject.year}-${selectedSubject.semester}-${selectedSubject.grade}-${selectedSubject.subject}`
    : null;

  const isSelectedInScope = (node: DomainTreeNode) => {
    if (!selectedSubject || selectedSubject.year !== node.year) return false;
    if (node.semester !== undefined && selectedSubject.semester !== node.semester) return false;
    if (node.grade !== undefined && selectedSubject.grade !== node.grade) return false;
    if (node.subjectName !== undefined && selectedSubject.subject !== node.subjectName) return false;
    if (node.domainName !== undefined && selectedDomain !== node.domainName) return false;
    return true;
  };

  return useAcademicTreeController<SubjectItem>({
    tree,
    draftKeyPrefix: 'domain-draft',
    selected: (item) => {
      if (!item.subject) return false;
      if (item.kind === 'domain') {
        const key = `${item.subject.year}-${item.subject.semester}-${item.subject.grade}-${item.subject.subject}-${item.domainName}`;
        return selectedDomainKey === key;
      }
      if (item.kind === 'subject' && !selectedDomainKey) {
        const key = `${item.subject.year}-${item.subject.semester}-${item.subject.grade}-${item.subject.subject}`;
        return selectedSubjectKey === key;
      }
      return false;
    },
    clickable: (item) => (item.kind === 'subject' || item.kind === 'domain') && !!item.subject,
    onSelect: (item) => {
      if (!item.subject) return;
      if (item.kind === 'domain') onSelectDomain(item.subject, item.domainName!, !!item.isCustom);
      else if (item.kind === 'subject') onSelectSubject(item.subject);
    },
    deleteSubject: async (subject, _node, helpers) => {
      if (!confirm(DOMAIN_TREE_TEXT.deleteSubjectConfirm(subject.subject))) return;
      await criteriaApi.deleteSource(DOMAIN_SOURCE_TYPE, subject.year, subject.semester, subject.grade, subject.subject);
      preserveParentPath(subject, helpers);
      if (isSameSubject(selectedSubject, subject)) {
        onClearSelection();
      }
      await reloadSubjects();
    },
    deleteScope: async (node, helpers) => {
      if (!node.year) return;
      if (!confirm(DOMAIN_TREE_TEXT.deleteScopeConfirm(node.label))) return;
      await criteriaApi.deleteDomainsScope({
        year: node.year,
        semester: node.semester,
        grade: node.grade,
        subject: node.subjectName,
        domainName: node.domainName,
      });
      helpers.removeDraftSubtree(node.key);
      if (isSelectedInScope(node)) {
        onClearSelection();
      }
      await reloadSubjects();
    },
    createAnchor: (scope) => criteriaApi.createDomainsAnchor(scope.year, scope.semester, scope.grade, scope.subject),
    createDomain: (node, name) => {
      if (!node.subject) throw new Error(DOMAIN_TREE_TEXT.missingParentSubject);
      return criteriaApi.addCustomDomain({
        year: node.subject.year,
        semester: node.subject.semester,
        grade: node.subject.grade,
        subject: node.subject.subject,
        name,
      });
    },
    onAfterCommit: reloadSubjects,
    actions: node => node.kind === 'subject' && node.subject ? [
      {
        title: node.subject.has_lesson_source ? '수업 일지 엑셀 연결 관리' : '수업 일지 엑셀 연결',
        icon: 'link' as const,
        variant: node.subject.has_lesson_source ? 'blue' as const : 'neutral' as const,
        visible: 'hover' as const,
        onClick: () => openLessonJournalLinkDialog({
          year: node.subject!.year,
          semester: node.subject!.semester,
          grade: node.subject!.grade,
          subject: node.subject!.subject,
        }),
      },
      ...(node.subject.has_source ? [{
        title: '평가 영역 원본 파일 다운로드',
        icon: 'download' as const,
        variant: 'blue' as const,
        onClick: async () => {
          const subject = node.subject!;
          try {
            const response = await criteriaApi.downloadSource(
              DOMAIN_SOURCE_TYPE,
              subject.year,
              subject.semester,
              subject.grade,
              subject.subject,
            );
            await saveBlob(
              downloadFilename(
                response.headers['content-disposition'] || '',
                `${subject.year}_${subject.semester}_${subject.grade}_${subject.subject}_평가영역.xlsx`,
              ),
              response.data,
            );
          } catch (error: any) {
            const blob = error?.response?.data;
            let message = '평가 영역 원본 파일 다운로드에 실패했습니다.';
            if (blob instanceof Blob && blob.type.includes('application/json')) {
              try { message = JSON.parse(await blob.text())?.error || message; } catch {}
            }
            alert(message);
          }
        },
      }] : []),
    ] : [],
  });
}
