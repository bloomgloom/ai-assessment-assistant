import { useEffect, useState } from 'react';
import { criteriaApi } from '../../lib/api';
import {
  AcademicTreeNode,
  buildAcademicTree,
  createAcademicParentPathDrafts,
} from '../../components/common/academicTree';
import { AcademicTreeControllerHelpers, useAcademicTreeController } from '../../hooks/useAcademicTreeController';
import { clearStoredSelection, saveStoredSelection, useStoredSelectionRestore } from '../../hooks/useStoredSelectionRestore';
import { saveBlob } from '../../lib/desktopFiles';
import {
  CRITERIA_SELECTION_KEY,
  CRITERIA_SOURCE_TYPE,
  CRITERIA_TREE_OPEN_STATES_KEY,
  CRITERIA_TREE_KEY_PREFIXES,
  CRITERIA_TREE_TEXT,
} from './constants';
import { CriteriaStandardRow, CriteriaSubjectItem } from './types';

type CriteriaTreeNode = AcademicTreeNode<CriteriaSubjectItem>;
type StoredCriteriaSelection = Pick<CriteriaSubjectItem, 'year' | 'semester' | 'grade' | 'subject' | 'domain_name'>;

function downloadFilename(disposition: string, fallback: string) {
  const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  const plainMatch = disposition.match(/filename="?([^";]+)"?/i);
  return utf8Match ? decodeURIComponent(utf8Match[1]) : plainMatch ? plainMatch[1] : fallback;
}

function buildCriteriaTree(items: CriteriaSubjectItem[]): CriteriaTreeNode[] {
  return buildAcademicTree(items, {
    keyPrefixes: CRITERIA_TREE_KEY_PREFIXES,
    getDomainEntries: (domains) => domains
      .filter(item => item.domain_name)
      .map(item => ({ name: item.domain_name, subject: item })),
  });
}

export function useCriteriaTree() {
  const [subjects, setSubjects] = useState<CriteriaSubjectItem[]>([]);
  const [tree, setTree] = useState<CriteriaTreeNode[]>([]);
  const [selected, setSelected] = useState<CriteriaSubjectItem | null>(null);
  const [standards, setStandards] = useState<CriteriaStandardRow[]>([]);

  const loadSubjects = async () => {
    const res = await criteriaApi.getStandardSubjects();
    setSubjects(res.data);
    setTree(buildCriteriaTree(res.data));
    return res.data as CriteriaSubjectItem[];
  };

  const loadStandards = async (subject: CriteriaSubjectItem) => {
    setSelected(subject);
    saveStoredSelection<StoredCriteriaSelection>(CRITERIA_SELECTION_KEY, {
      year: subject.year,
      semester: subject.semester,
      grade: subject.grade,
      subject: subject.subject,
      domain_name: subject.domain_name,
    });
    const res = await criteriaApi.getStandards(subject.year, subject.semester, subject.grade, subject.subject);
    setStandards(res.data.filter((row: CriteriaStandardRow) => row.domain_name === subject.domain_name));
  };

  const selectImported = async (target: StoredCriteriaSelection) => {
    const loaded = await loadSubjects();
    const item = loaded.find(s =>
      s.year === target.year &&
      s.semester === target.semester &&
      s.grade === target.grade &&
      s.subject === target.subject &&
      s.domain_name === target.domain_name
    );
    if (item) await loadStandards(item);
  };

  useEffect(() => { loadSubjects(); }, []);

  useStoredSelectionRestore<CriteriaSubjectItem, StoredCriteriaSelection>({
    storageKey: CRITERIA_SELECTION_KEY,
    items: subjects,
    findItem: (items, stored) => items.find(s =>
      s.year === stored.year && s.semester === stored.semester && s.grade === stored.grade &&
      s.subject === stored.subject && s.domain_name === stored.domain_name
    ),
    onRestore: loadStandards,
  });

  const isSameSubject = (a: CriteriaSubjectItem | null, b: Pick<CriteriaSubjectItem, 'year' | 'semester' | 'grade' | 'subject'>) =>
    !!a && a.year === b.year && a.semester === b.semester && a.grade === b.grade && a.subject === b.subject;

  const isSelectedInScope = (node: CriteriaTreeNode) => {
    if (!selected || selected.year !== node.year) return false;
    if (node.semester !== undefined && selected.semester !== node.semester) return false;
    if (node.grade !== undefined && selected.grade !== node.grade) return false;
    if (node.subjectName !== undefined && selected.subject !== node.subjectName) return false;
    if (node.domainName !== undefined && selected.domain_name !== node.domainName) return false;
    return true;
  };

  const clearSelection = () => {
    setSelected(null);
    setStandards([]);
    clearStoredSelection(CRITERIA_SELECTION_KEY);
  };

  const preserveParentPath = (
    sub: Pick<CriteriaSubjectItem, 'year' | 'semester' | 'grade'>,
    helpers: AcademicTreeControllerHelpers<CriteriaSubjectItem>,
  ) => {
    const parents = createAcademicParentPathDrafts<CriteriaSubjectItem>(CRITERIA_TREE_KEY_PREFIXES, sub);
    helpers.setDraftNodes(prev => {
      const keys = new Set(prev.map(node => node.key));
      return [...prev, ...parents.filter(node => !keys.has(node.key))];
    });
  };

  const selectedKey = selected
    ? `${selected.year}-${selected.semester}-${selected.grade}-${selected.subject}-${selected.domain_name}`
    : null;

  const criteriaTree = useAcademicTreeController<CriteriaSubjectItem>({
    tree,
    openStateStorageKey: CRITERIA_TREE_OPEN_STATES_KEY,
    draftKeyPrefix: 'draft',
    selected: (item) => {
      const sub = item.subject;
      const key = sub ? `${sub.year}-${sub.semester}-${sub.grade}-${sub.subject}-${item.domainName}` : '';
      return item.kind === 'domain' && !!sub && selectedKey === key;
    },
    clickable: (item) => item.kind === 'domain' && !!item.subject,
    onSelect: (item) => item.subject && loadStandards(item.subject),
    deleteSubject: async (subject, _node, helpers) => {
      if (!confirm(CRITERIA_TREE_TEXT.deleteSubjectConfirm(subject.subject))) return;
      await criteriaApi.deleteSource(CRITERIA_SOURCE_TYPE, subject.year, subject.semester, subject.grade, subject.subject);
      preserveParentPath(subject, helpers);
      if (isSameSubject(selected, subject)) clearSelection();
      await loadSubjects();
    },
    deleteScope: async (node, helpers) => {
      if (!node.year) return;
      if (!confirm(CRITERIA_TREE_TEXT.deleteScopeConfirm(node.label))) return;
      await criteriaApi.deleteStandardsScope({
        year: node.year,
        semester: node.semester,
        grade: node.grade,
        subject: node.subjectName,
        domainName: node.domainName,
      });
      helpers.removeDraftSubtree(node.key);
      if (isSelectedInScope(node)) clearSelection();
      await loadSubjects();
    },
    createAnchor: (scope) => criteriaApi.createStandardsAnchor(scope.year, scope.semester, scope.grade, ''),
    createSubject: (scope, node) => criteriaApi.seedStandardsFromCurriculum({
      year: scope.year,
      semester: scope.semester,
      grade: scope.grade,
      subject: scope.subject,
      credit: node.subject?.credit ?? 0,
    }),
    updateScope: (node, to) => {
      if (!node.year) throw new Error('수정할 학년도 정보가 없습니다.');
      return criteriaApi.updateStandardsScope({
        from: { year: node.year, semester: node.semester, grade: node.grade, subject: node.subjectName, domainName: node.domainName },
        to,
      });
    },
    onAfterCommit: async ({ mode }) => {
      if (mode === 'edit') {
        setSelected(null);
        setStandards([]);
      }
      await loadSubjects();
    },
    getCommitErrorMessage: (error, node) => {
      const responseError = error && typeof error === 'object' && 'response' in error
        ? (error as any).response?.data?.error
        : undefined;
      return responseError || (node.kind === 'subject' ? CRITERIA_TREE_TEXT.missingBuiltInStandards : undefined);
    },
    subjectDownloadAction: {
      visible: (subject) => !!subject.has_source,
      onDownload: async (subject) => {
        try {
          const response = await criteriaApi.downloadSource(
            CRITERIA_SOURCE_TYPE,
            subject.year,
            subject.semester,
            subject.grade,
            subject.subject,
          );
          await saveBlob(
            downloadFilename(
              response.headers['content-disposition'] || '',
              `${subject.year}_${subject.semester}_${subject.grade}_${subject.subject}_성취기준.xlsx`,
            ),
            response.data,
          );
        } catch (error: any) {
          const blob = error?.response?.data;
          let message = '성취 기준 원본 파일 다운로드에 실패했습니다.';
          if (blob instanceof Blob && blob.type.includes('application/json')) {
            try {
              message = JSON.parse(await blob.text())?.error || message;
            } catch {}
          }
          alert(message);
        }
      },
    },
  });

  return {
    selected,
    standards,
    reloadSubjects: loadSubjects,
    loadStandards,
    selectImported,
    clearSelection,
    tree: {
      nodes: criteriaTree.visibleTree,
      addNode: criteriaTree.addNode,
      node: criteriaTree.nodeConfig,
    },
  };
}
