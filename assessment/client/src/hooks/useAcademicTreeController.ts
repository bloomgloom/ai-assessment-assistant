import { Dispatch, SetStateAction, useMemo, useRef, useState } from 'react';
import {
  AcademicTreeNode,
  createAcademicDraftNode,
  createAcademicTreeAnchorScope,
  createAcademicTreeScopePatch,
  findAcademicTreeNodeByKey,
  mergeAcademicDraftNodes,
  removeAcademicDraftSubtree,
} from '../components/common/academicTree';
import { TreeEditingItem } from '../components/common/TreeNodeView';

type EditingTreeItem = TreeEditingItem & { mode: 'add' | 'edit' };

export interface AcademicTreeControllerHelpers<TSubject> {
  removeDraftSubtree: (key: string) => void;
  setDraftNodes: Dispatch<SetStateAction<AcademicTreeNode<TSubject>[]>>;
}

interface AcademicTreeAction<TSubject> {
  title: string;
  icon: 'download' | 'file' | 'link' | 'trash';
  variant?: 'neutral' | 'blue' | 'red' | 'green' | 'purple';
  visible?: 'always' | 'hover' | 'hidden';
  onClick: (node: AcademicTreeNode<TSubject>) => void;
}

interface AcademicTreeSubjectDownloadAction<TSubject> {
  title?: string;
  visible?: (subject: TSubject, node: AcademicTreeNode<TSubject>) => boolean;
  onDownload: (subject: TSubject, node: AcademicTreeNode<TSubject>) => void;
}

type AcademicTreeAnchorScope = { year: number; semester: number; grade: number; subject: string };
type AcademicTreeScopePatch = { year?: number; semester?: number; grade?: number; subject?: string; domainName?: string };
type AcademicTreeCommitMode = 'add' | 'edit';

interface UseAcademicTreeControllerOptions<TSubject> {
  tree: AcademicTreeNode<TSubject>[];
  draftKeyPrefix?: string;
  selected?: (node: AcademicTreeNode<TSubject>) => boolean;
  clickable?: (node: AcademicTreeNode<TSubject>) => boolean;
  onSelect?: (node: AcademicTreeNode<TSubject>) => void;
  canAdd?: (node: AcademicTreeNode<TSubject>) => boolean;
  canDelete?: (node: AcademicTreeNode<TSubject>) => boolean;
  onDeletePersisted?: (node: AcademicTreeNode<TSubject>, helpers: AcademicTreeControllerHelpers<TSubject>) => Promise<void> | void;
  deleteSubject?: (subject: TSubject, node: AcademicTreeNode<TSubject>, helpers: AcademicTreeControllerHelpers<TSubject>) => Promise<unknown> | unknown;
  deleteScope?: (node: AcademicTreeNode<TSubject>, helpers: AcademicTreeControllerHelpers<TSubject>) => Promise<unknown> | unknown;
  createAnchor?: (scope: AcademicTreeAnchorScope, node: AcademicTreeNode<TSubject>) => Promise<unknown> | unknown;
  createSubject?: (scope: AcademicTreeAnchorScope, node: AcademicTreeNode<TSubject>) => Promise<unknown> | unknown;
  createDomain?: (node: AcademicTreeNode<TSubject>, value: string) => Promise<unknown> | unknown;
  updateScope?: (node: AcademicTreeNode<TSubject>, patch: AcademicTreeScopePatch) => Promise<unknown> | unknown;
  onAfterCommit?: (event: { mode: AcademicTreeCommitMode; node: AcademicTreeNode<TSubject> }) => Promise<void> | void;
  getCommitErrorMessage?: (error: unknown, node: AcademicTreeNode<TSubject>, mode: AcademicTreeCommitMode) => string | undefined;
  subjectDownloadAction?: AcademicTreeSubjectDownloadAction<TSubject>;
  actions?: (node: AcademicTreeNode<TSubject>) => AcademicTreeAction<TSubject>[];
}

export function useAcademicTreeController<TSubject>({
  tree,
  draftKeyPrefix = 'draft',
  selected,
  clickable,
  onSelect,
  canAdd = (node) => node.kind !== 'subject' && node.kind !== 'domain',
  canDelete = (node) => node.kind !== 'domain',
  onDeletePersisted,
  deleteSubject,
  deleteScope,
  createAnchor,
  createSubject,
  createDomain,
  updateScope,
  onAfterCommit,
  getCommitErrorMessage,
  subjectDownloadAction,
  actions,
}: UseAcademicTreeControllerOptions<TSubject>) {
  const [draftNodes, setDraftNodes] = useState<AcademicTreeNode<TSubject>[]>([]);
  const [editing, setEditing] = useState<EditingTreeItem | null>(null);
  const committingRef = useRef(false);
  const visibleTree = useMemo(() => mergeAcademicDraftNodes(tree, draftNodes), [tree, draftNodes]);

  const removeDraftSubtree = (key: string) => {
    setDraftNodes(prev => removeAcademicDraftSubtree(prev, key));
  };
  const helpers: AcademicTreeControllerHelpers<TSubject> = { removeDraftSubtree, setDraftNodes };

  const addNode = (node?: AcademicTreeNode<TSubject>) => {
    const draft = createAcademicDraftNode(node, draftKeyPrefix);
    setDraftNodes(prev => [...prev, draft]);
    setEditing({ key: draft.key, mode: 'add', value: '' });
  };

  const commitErrorMessage = (error: unknown, node: AcademicTreeNode<TSubject>, mode: AcademicTreeCommitMode) => {
    const responseError = error && typeof error === 'object' && 'response' in error
      ? (error as any).response?.data?.error
      : undefined;
    return getCommitErrorMessage?.(error, node, mode) || responseError || '저장에 실패했습니다.';
  };

  const commitAddNode = async (node: AcademicTreeNode<TSubject>, value: string): Promise<boolean> => {
    const trimmed = value.trim();
    if (!trimmed) {
      removeDraftSubtree(node.key);
      return true;
    }

    try {
      if (node.kind === 'domain') {
        if (!createDomain) return false;
        await createDomain(node, trimmed);
      } else {
        const scope = createAcademicTreeAnchorScope(node, trimmed);
        if (!scope) return false;
        if (node.kind === 'subject' && createSubject) {
          await createSubject(scope, node);
        } else {
          if (!createAnchor) return false;
          await createAnchor(scope, node);
        }
      }
      removeDraftSubtree(node.key);
      await onAfterCommit?.({ mode: 'add', node });
      return true;
    } catch (error) {
      alert(commitErrorMessage(error, node, 'add'));
      return false;
    }
  };

  const commitEditNode = async (node: AcademicTreeNode<TSubject>, value: string): Promise<boolean> => {
    const trimmed = value.trim();
    if (!trimmed) return false;
    if (node.isDraft) return commitAddNode(node, trimmed);

    const patch = createAcademicTreeScopePatch(node, trimmed);
    if (!patch || !updateScope) return false;

    try {
      await updateScope(node, patch);
      await onAfterCommit?.({ mode: 'edit', node });
      return true;
    } catch (error) {
      alert(commitErrorMessage(error, node, 'edit'));
      return false;
    }
  };

  const commitEditing = async () => {
    if (!editing || committingRef.current) return;
    committingRef.current = true;
    try {
      const current = editing;
      const node = findAcademicTreeNodeByKey(visibleTree, current.key);
      if (!node) {
        setEditing(null);
        return;
      }
      const ok = current.mode === 'add'
        ? await commitAddNode(node, current.value)
        : await commitEditNode(node, current.value);
      if (ok !== false) setEditing(null);
      else setEditing(current);
    } finally {
      committingRef.current = false;
    }
  };

  const cancelEditing = () => {
    if (editing?.mode === 'add') removeDraftSubtree(editing.key);
    setEditing(null);
  };

  const deleteNode = async (node: AcademicTreeNode<TSubject>) => {
    if (node.isDraft) {
      removeDraftSubtree(node.key);
      return;
    }
    if (node.kind === 'subject' && node.subject && deleteSubject) {
      await deleteSubject(node.subject, node, helpers);
      return;
    }
    if (deleteScope) {
      await deleteScope(node, helpers);
      return;
    }
    await onDeletePersisted?.(node, helpers);
  };

  const nodeActions = (node: AcademicTreeNode<TSubject>) => {
    const items: AcademicTreeAction<TSubject>[] = [];
    if (
      node.kind === 'subject' &&
      node.subject &&
      subjectDownloadAction &&
      (subjectDownloadAction.visible?.(node.subject, node) ?? true)
    ) {
      items.push({
        title: subjectDownloadAction.title || '원본 파일 다운로드',
        icon: 'download',
        variant: 'blue',
        onClick: () => subjectDownloadAction.onDownload(node.subject!, node),
      });
    }
    return [...items, ...(actions?.(node) || [])];
  };

  return {
    visibleTree,
    draftNodes,
    setDraftNodes,
    editing,
    removeDraftSubtree,
    addNode,
    nodeConfig: {
      editing,
      selected,
      clickable,
      onSelect,
      canAdd,
      onAdd: addNode,
      canDelete,
      onDelete: deleteNode,
      actions: nodeActions,
      onEditChange: (value: string) => setEditing(prev => prev ? { ...prev, value } : prev),
      onEditCommit: commitEditing,
      onEditCancel: cancelEditing,
    },
  };
}
