import { ReactNode, SelectHTMLAttributes, useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import { hasDesktopFileDialogs, openDirectory, openFiles } from '../../lib/desktopFiles';

export interface HeaderViewOption<T extends string> {
  value: T;
  label: ReactNode;
  active: boolean;
  enabled?: boolean;
}

export function HeaderViewToggleGroup<T extends string>({ options, onToggle }: { options: HeaderViewOption<T>[]; onToggle: (value: T) => void }) {
  return <div className="flex shrink-0 gap-1 rounded border border-gray-200 bg-gray-100 p-1">
    {options.map(option => <button key={option.value} type="button" className={`whitespace-nowrap rounded px-3 py-1 text-xs font-medium transition-colors ${option.enabled === false ? 'cursor-not-allowed text-gray-400 opacity-40' : option.active ? 'bg-white text-blue-600 shadow' : 'text-gray-500 hover:text-gray-700'}`} disabled={option.enabled === false} onClick={() => onToggle(option.value)}>{option.label}</button>)}
  </div>;
}

export function HeaderFilterSelect(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`input w-[15rem] min-w-0 shrink bg-gray-50 px-2 py-1.5 text-xs font-medium text-gray-700 ${props.className || ''}`.trim()} />;
}

export function ExecutionModeMenu({ label, onImmediate, onBatch, disabled, batchDisabled = false, immediateTitle, batchTitle }: { label: string; onImmediate: () => void; onBatch: () => void; disabled?: boolean; batchDisabled?: boolean; immediateTitle?: string; batchTitle?: string }) {
  const [closed, setClosed] = useState(false);
  const run = (event: React.MouseEvent<HTMLButtonElement>, action: () => void) => {
    event.currentTarget.blur();
    setClosed(true);
    window.setTimeout(action, 0);
  };
  return <div className="group relative h-9" onMouseLeave={() => setClosed(false)}>
    <button type="button" className="btn-rainbow h-9 px-4 text-sm" disabled={disabled} aria-haspopup="menu" title={`${label} 방식 선택`} onFocus={() => setClosed(false)}>{label}</button>
    <div className={`absolute right-0 top-[calc(100%-1px)] z-50 min-w-full pt-1 transition-opacity ${closed ? 'invisible opacity-0' : 'invisible opacity-0 group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100'}`} role="menu">
      <div className="flex flex-col overflow-hidden rounded-md border border-gray-200 bg-white py-1 shadow-lg">
        <button type="button" className="whitespace-nowrap px-4 py-2 text-center text-xs text-gray-700 hover:bg-blue-50 hover:text-blue-700 disabled:text-gray-300" onClick={event => run(event, onImmediate)} disabled={disabled} title={immediateTitle} role="menuitem">즉시</button>
        <button type="button" className="whitespace-nowrap px-4 py-2 text-center text-xs text-gray-700 hover:bg-blue-50 hover:text-blue-700 disabled:text-gray-300" onClick={event => run(event, onBatch)} disabled={disabled || batchDisabled} title={batchTitle} role="menuitem">배치</button>
      </div>
    </div>
  </div>;
}

export function HeaderImportMenu({
  label,
  onZip,
  onFolder,
  disabled,
  loading,
}: {
  label?: string;
  onZip: (file: File) => void | Promise<void>;
  onFolder: (folderPath: string) => void | Promise<void>;
  disabled?: boolean;
  loading?: boolean;
}) {
  const [closed, setClosed] = useState(false);
  const zipInputRef = useRef<HTMLInputElement>(null);
  const run = (action: () => void | Promise<void>) => {
    setClosed(true);
    window.setTimeout(() => void action(), 0);
  };
  const chooseZip = async () => {
    if (hasDesktopFileDialogs()) {
      const files = await openFiles({ filters: [{ name: 'ZIP 파일', extensions: ['zip'] }] });
      if (files?.[0]) await onZip(files[0]);
      return;
    }
    zipInputRef.current?.click();
  };
  const chooseFolder = async () => {
    const folderPath = await openDirectory();
    if (folderPath === null) {
      alert('폴더 업로드는 데스크톱 앱에서 사용할 수 있습니다.');
      return;
    }
    if (folderPath) await onFolder(folderPath);
  };

  return <div className="group relative h-9" onMouseLeave={() => setClosed(false)}>
    <button type="button" className="btn-secondary h-9 border-blue-300 p-2 text-blue-600 hover:border-blue-400 hover:bg-blue-50 hover:text-blue-700" disabled={disabled || loading} aria-haspopup="menu" title={loading ? '업로드 중...' : '산출물 업로드'} aria-label={loading ? '업로드 중' : '산출물 업로드'} onFocus={() => setClosed(false)}>
      <Upload size={14}/>{label}
    </button>
    <div className={`absolute right-0 top-[calc(100%-1px)] z-50 min-w-full pt-1 transition-opacity ${closed ? 'invisible opacity-0' : 'invisible opacity-0 group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100'}`} role="menu">
      <div className="flex flex-col overflow-hidden rounded-md border border-gray-200 bg-white py-1 shadow-lg">
        <button type="button" className="whitespace-nowrap px-4 py-2 text-center text-xs text-gray-700 hover:bg-blue-50 hover:text-blue-700" disabled={disabled || loading} onClick={() => run(chooseZip)} role="menuitem">.zip</button>
        <button type="button" className="whitespace-nowrap px-4 py-2 text-center text-xs text-gray-700 hover:bg-blue-50 hover:text-blue-700" disabled={disabled || loading} onClick={() => run(chooseFolder)} role="menuitem">폴더</button>
      </div>
    </div>
    <input ref={zipInputRef} type="file" accept=".zip" className="hidden" onChange={event => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (file) void onZip(file);
    }}/>
  </div>;
}
