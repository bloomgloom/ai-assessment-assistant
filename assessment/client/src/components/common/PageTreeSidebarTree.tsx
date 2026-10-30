import { isValidElement, ReactNode } from 'react';
import { Download, FileSpreadsheet, Link2, Plus, Trash2 } from 'lucide-react';
import { TreeView } from './TreeView';
import { TreeEditingItem, TreeIconButton, TreeNodeLike, TreeNodeView } from './TreeNodeView';

interface PageTreeSidebarEmptyConfig {
  icon?: ReactNode;
  message: ReactNode;
  hint?: ReactNode;
  addYear?: boolean;
  onAddYear?: () => void;
}

export interface PageTreeSidebarTreeConfig<T> {
  nodes: T[];
  empty: ReactNode | PageTreeSidebarEmptyConfig;
  renderNode?: (node: T, index: number) => ReactNode;
  node?: PageTreeSidebarNodeConfig<T>;
  addYear?: boolean;
  onAddYear?: () => void;
  className?: string;
}

interface PageTreeSidebarNodeAction<T> {
  title: string;
  icon: 'download' | 'file' | 'link' | 'trash';
  variant?: 'neutral' | 'blue' | 'red' | 'green' | 'purple';
  visible?: 'always' | 'hover' | 'hidden';
  onClick: (node: T) => void;
}

interface PageTreeSidebarNodeConfig<T> {
  editing?: TreeEditingItem | null;
  selected?: (node: T) => boolean;
  clickable?: (node: T) => boolean;
  onSelect?: (node: T) => void;
  canAdd?: (node: T) => boolean;
  onAdd?: (node: T) => void;
  canDelete?: (node: T) => boolean;
  onDelete?: (node: T) => void;
  actions?: (node: T) => PageTreeSidebarNodeAction<T>[];
  onEditChange?: (value: string) => void;
  onEditCommit?: () => void;
  onEditCancel?: () => void;
  openStates?: Record<string, boolean>;
  onToggleOpen?: (key: string) => void;
}

export type PageTreeSidebarTreeContent<T> = ReactNode | PageTreeSidebarTreeConfig<T>;

interface PageTreeSidebarTreeProps<T> {
  tree: PageTreeSidebarTreeContent<T>;
}

function isTreeConfig<T>(tree: PageTreeSidebarTreeContent<T>): tree is PageTreeSidebarTreeConfig<T> {
  return !!tree && typeof tree === 'object' && !isValidElement(tree) && 'nodes' in tree && ('renderNode' in tree || 'node' in tree);
}

function isEmptyConfig(empty: ReactNode | PageTreeSidebarEmptyConfig): empty is PageTreeSidebarEmptyConfig {
  return !!empty && typeof empty === 'object' && !isValidElement(empty) && 'message' in empty;
}

function AddYearButton({ visible = false, onAddYear }: { visible?: boolean; onAddYear?: () => void }) {
  if (!onAddYear) return null;

  return (
    <button
      className={visible
        ? 'mt-4 flex w-full items-center justify-center rounded border border-dashed border-blue-200 py-1.5 text-blue-500 hover:bg-blue-50'
        : 'flex w-full items-center justify-center rounded border border-dashed border-transparent py-1 text-blue-500 opacity-0 transition hover:border-blue-200 hover:bg-blue-50 hover:opacity-100 group-hover/tree:opacity-100'}
      onClick={onAddYear}
      title="학년도 추가"
    >
      <Plus size={14} />
    </button>
  );
}

function renderEmpty(empty: ReactNode | PageTreeSidebarEmptyConfig) {
  if (!isEmptyConfig(empty)) return empty;

  return (
    <div className="text-center py-10 text-gray-400">
      {empty.icon && <div className="mx-auto mb-2 opacity-30 flex justify-center">{empty.icon}</div>}
      <p className="text-xs">{empty.message}</p>
      {empty.hint && <p className="text-xs mt-2 text-gray-300 leading-tight">{empty.hint}</p>}
      {empty.addYear && <AddYearButton visible onAddYear={empty.onAddYear} />}
    </div>
  );
}

function actionIcon(icon: PageTreeSidebarNodeAction<unknown>['icon']) {
  if (icon === 'download') return <Download size={13} />;
  if (icon === 'file') return <FileSpreadsheet size={13} />;
  if (icon === 'link') return <Link2 size={13} />;
  return <Trash2 size={13} />;
}

function renderNodeActions<T>(node: T, actions?: (node: T) => PageTreeSidebarNodeAction<T>[]) {
  const items = actions?.(node) || [];
  if (!items.length) return null;

  return (
    <>
      {items.map((action, index) => (
        <TreeIconButton
          key={`${action.title}-${index}`}
          title={action.title}
          onClick={() => action.onClick(node)}
          variant={action.variant}
          visible={action.visible}
        >
          {actionIcon(action.icon)}
        </TreeIconButton>
      ))}
    </>
  );
}

function renderTreeNode<T extends TreeNodeLike<T>>(nodeConfig: PageTreeSidebarNodeConfig<T>) {
  return (node: T, index: number) => (
    <TreeNodeView
      key={node.key || node.path || index}
      node={node}
      editing={nodeConfig.editing}
      selected={nodeConfig.selected}
      clickable={nodeConfig.clickable}
      onSelect={nodeConfig.onSelect}
      canAdd={nodeConfig.canAdd}
      onAdd={nodeConfig.onAdd}
      canDelete={nodeConfig.canDelete}
      onDelete={nodeConfig.onDelete}
      actions={(item) => renderNodeActions(item, nodeConfig.actions)}
      onEditChange={nodeConfig.onEditChange}
      onEditCommit={nodeConfig.onEditCommit}
      onEditCancel={nodeConfig.onEditCancel}
      openStates={nodeConfig.openStates}
      onToggleOpen={nodeConfig.onToggleOpen}
    />
  );
}

export function PageTreeSidebarTree<T extends TreeNodeLike<T>>({ tree }: PageTreeSidebarTreeProps<T>) {
  if (!isTreeConfig(tree)) return <>{tree}</>;
  const renderNode = tree.renderNode || (tree.node ? renderTreeNode(tree.node) : undefined);
  if (!renderNode) return null;

  return (
    <TreeView
      nodes={tree.nodes}
      empty={renderEmpty(tree.empty)}
      addYearButton={tree.addYear ? <AddYearButton onAddYear={tree.onAddYear} /> : undefined}
      className={tree.className}
    >
      {renderNode}
    </TreeView>
  );
}
