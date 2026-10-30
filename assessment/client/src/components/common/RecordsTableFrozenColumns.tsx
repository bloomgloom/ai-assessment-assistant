export const RECORDS_FROZEN_DEFAULT_WIDTHS = { chk: 32, cls: 32, num: 40, name: 64 } as const;
export type RecordsFrozenKey = keyof typeof RECORDS_FROZEN_DEFAULT_WIDTHS;

export function recordsFrozenLayout(widths: Record<string, number>) {
  const width = {
    chk: widths._chk ?? RECORDS_FROZEN_DEFAULT_WIDTHS.chk,
    cls: widths._cls ?? RECORDS_FROZEN_DEFAULT_WIDTHS.cls,
    num: widths._num ?? RECORDS_FROZEN_DEFAULT_WIDTHS.num,
    name: widths._name ?? RECORDS_FROZEN_DEFAULT_WIDTHS.name,
  };
  return { width, left: { chk: 0, cls: width.chk, num: width.chk + width.cls, name: width.chk + width.cls + width.num }, total: width.chk + width.cls + width.num + width.name, separatorShadow: '2px 0 5px rgba(0,0,0,0.08)' };
}

export function RecordsFrozenHeader({ layout, rowSpan = 2, allSelected, onToggleAll, onResize }: { layout: ReturnType<typeof recordsFrozenLayout>; rowSpan?: number; allSelected: boolean; onToggleAll: () => void; onResize: (event: React.MouseEvent, key: string, width: number) => void }) {
  const keys: Array<{ key: RecordsFrozenKey; label: string }> = [{ key: 'chk', label: '' }, { key: 'cls', label: '반' }, { key: 'num', label: '번호' }, { key: 'name', label: '이름' }];
  return <>{keys.map(({ key, label }) => <th key={key} rowSpan={rowSpan} className="relative sticky z-30 border-b border-r bg-gray-100 text-center font-semibold text-gray-600 select-none" style={{ left: layout.left[key], width: layout.width[key], minWidth: layout.width[key], ...(key === 'name' ? { boxShadow: layout.separatorShadow } : {}) }}>
    {key === 'chk' ? <div className="flex items-center justify-center py-3"><input type="checkbox" className="h-4 w-4 rounded border-gray-300" checked={allSelected} onChange={onToggleAll} title="전체 선택/해제"/></div> : label}
    <div className="records-table-column-resize-handle absolute bottom-0 right-0 top-0 z-10 cursor-col-resize bg-transparent" onMouseDown={event => onResize(event, `_${key}`, RECORDS_FROZEN_DEFAULT_WIDTHS[key])}/>
  </th>)}</>;
}

export function RecordsFrozenStudentCells<RowKey extends string | number>({ layout, rowKey, classNum, studentNum, name, selected, onToggle, renderResizeHandles }: { layout: ReturnType<typeof recordsFrozenLayout>; rowKey: RowKey; classNum: number; studentNum: number; name: string; selected: boolean; onToggle: () => void; renderResizeHandles: (rowKey: RowKey, columnKey: string, width: number) => React.ReactNode }) {
  return <>
    <td className="sticky z-10 border-r bg-white text-center" style={{ left: layout.left.chk, width: layout.width.chk, minWidth: layout.width.chk }}><div className="flex justify-center py-2"><input type="checkbox" className="h-4 w-4 rounded border-gray-300" checked={selected} onChange={onToggle}/></div>{renderResizeHandles(rowKey, '_chk', RECORDS_FROZEN_DEFAULT_WIDTHS.chk)}</td>
    <td className="sticky z-10 border-r bg-white px-1 py-2 text-center font-mono text-gray-500" style={{ left: layout.left.cls, width: layout.width.cls, minWidth: layout.width.cls }}>{classNum}{renderResizeHandles(rowKey, '_cls', RECORDS_FROZEN_DEFAULT_WIDTHS.cls)}</td>
    <td className="sticky z-10 border-r bg-white px-1 py-2 text-center font-mono text-gray-500" style={{ left: layout.left.num, width: layout.width.num, minWidth: layout.width.num }}>{studentNum}{renderResizeHandles(rowKey, '_num', RECORDS_FROZEN_DEFAULT_WIDTHS.num)}</td>
    <td className="sticky z-10 border-r bg-white px-1 py-2 text-center font-medium text-gray-800" style={{ left: layout.left.name, width: layout.width.name, minWidth: layout.width.name, boxShadow: layout.separatorShadow }}>{name}{renderResizeHandles(rowKey, '_name', RECORDS_FROZEN_DEFAULT_WIDTHS.name)}</td>
  </>;
}
