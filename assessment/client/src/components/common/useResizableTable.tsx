import { useRef, useState } from 'react';

interface ResizableTableOptions {
  defaultRowHeight: number;
  minRowHeight?: number;
  getMinColumnWidth?: (key: string) => number;
}

export function useResizableTable<RowKey extends string | number>({
  defaultRowHeight,
  minRowHeight = defaultRowHeight,
  getMinColumnWidth = key => key.startsWith('_') ? 24 : 30,
}: ResizableTableOptions) {
  const tableRef = useRef<HTMLTableElement>(null);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const [rowHeights, setRowHeights] = useState<Record<string, number>>({});

  const columnWidth = (key: string, defaultWidth: number) => columnWidths[key] ?? defaultWidth;
  const rowHeight = (key: RowKey) => rowHeights[String(key)] ?? defaultRowHeight;

  const handleColumnResizeStart = (event: React.MouseEvent, key: string, defaultWidth: number) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = columnWidth(key, defaultWidth);
    const onMove = (moveEvent: MouseEvent) => setColumnWidths(current => ({
      ...current,
      [key]: Math.max(getMinColumnWidth(key), startWidth + moveEvent.clientX - startX),
    }));
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const handleRowResizeStart = (event: React.MouseEvent, key: RowKey, initialHeight = defaultRowHeight, minimumHeight = minRowHeight) => {
    event.preventDefault();
    event.stopPropagation();
    const startY = event.clientY;
    const startHeight = rowHeights[String(key)] ?? initialHeight;
    const onMove = (moveEvent: MouseEvent) => setRowHeights(current => ({
      ...current,
      [String(key)]: Math.max(minimumHeight, startHeight + moveEvent.clientY - startY),
    }));
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const handleRowAutoFit = (event: React.MouseEvent, key: RowKey) => {
    event.preventDefault();
    event.stopPropagation();
    const cell = event.currentTarget.closest('td');
    const field = cell?.querySelector<HTMLTextAreaElement>('textarea');
    if (!field) return;
    const previousHeight = field.style.height;
    field.style.height = 'auto';
    const borderHeight = field.offsetHeight - field.clientHeight;
    const fittedHeight = Math.max(minRowHeight, field.scrollHeight + borderHeight);
    field.style.height = previousHeight;
    setRowHeights(current => ({ ...current, [String(key)]: fittedHeight }));
  };

  const renderColumnResizeHandle = (key: string, defaultWidth: number) => (
    <div
      className="records-table-column-resize-handle absolute bottom-0 right-0 top-0 z-10 cursor-col-resize bg-transparent"
      onMouseDown={event => handleColumnResizeStart(event, key, defaultWidth)}
      title="드래그하여 열 너비 조절"
    />
  );

  const renderRowResizeHandle = (key: RowKey) => (
    <div
      className="records-table-row-resize-handle absolute inset-x-0 bottom-0 z-10 cursor-row-resize bg-transparent"
      onMouseDown={event => handleRowResizeStart(event, key)}
      onDoubleClick={event => handleRowAutoFit(event, key)}
      title="드래그하여 행 높이 조절 · 더블클릭하여 이 셀 내용에 맞춤"
    />
  );

  const renderCellResizeHandles = (rowKey: RowKey, columnKey: string, defaultWidth: number) => (
    <>
      {renderColumnResizeHandle(columnKey, defaultWidth)}
      {renderRowResizeHandle(rowKey)}
    </>
  );

  const handleKeyNavigation = (event: React.KeyboardEvent, rowIndex: number, columnIndex: number) => {
    if (event.key !== 'Tab' && event.key !== 'Enter') return;
    const cells = Array.from(
      tableRef.current?.querySelectorAll<HTMLElement>('[data-row][data-col]:not(:disabled)') ?? []
    ).sort((a, b) => {
      const rowDifference = Number(a.dataset.row ?? 0) - Number(b.dataset.row ?? 0);
      return rowDifference || Number(a.dataset.col ?? 0) - Number(b.dataset.col ?? 0);
    });
    if (!cells.length) return;
    let next: HTMLElement | undefined;
    if (event.key === 'Tab') {
      const currentIndex = cells.findIndex(cell => Number(cell.dataset.row) === rowIndex && Number(cell.dataset.col) === columnIndex);
      if (currentIndex < 0) return;
      next = cells[currentIndex + (event.shiftKey ? -1 : 1)];
    } else {
      const sameColumn = cells.filter(cell => Number(cell.dataset.col) === columnIndex);
      next = event.shiftKey
        ? sameColumn.reverse().find(cell => Number(cell.dataset.row) < rowIndex)
        : sameColumn.find(cell => Number(cell.dataset.row) > rowIndex);
    }
    if (!next) return;
    event.preventDefault();
    next.focus();
  };

  return {
    tableRef,
    columnWidths,
    rowHeights,
    columnWidth,
    rowHeight,
    handleColumnResizeStart,
    handleRowResizeStart,
    handleRowAutoFit,
    renderColumnResizeHandle,
    renderRowResizeHandle,
    renderCellResizeHandles,
    handleKeyNavigation,
  };
}
