import type { ReactNode } from 'react';
import { Loader2, Upload } from 'lucide-react';
import { hasDesktopFileDialogs, openFiles } from '../../lib/desktopFiles';

export interface CompactArtifactFile {
  id: number;
  filename: string;
}

export function artifactExtension(filename: string): string {
  return filename.split('.').pop()?.toLowerCase() || '';
}

export function artifactExtensionLabel(filename: string): string {
  return (filename.split('.').pop() || 'FILE').toUpperCase();
}

export function artifactBadgeClass(filename: string): string {
  switch (artifactExtension(filename)) {
    case 'py': return 'bg-blue-100 text-blue-700 border-blue-300';
    case 'c':
    case 'cpp':
    case 'h': return 'bg-purple-100 text-purple-700 border-purple-300';
    case 'pdf': return 'bg-red-100 text-red-700 border-red-300';
    case 'html': return 'bg-orange-100 text-orange-700 border-orange-300';
    case 'hwpx': return 'bg-teal-100 text-teal-700 border-teal-300';
    case 'csv': return 'bg-emerald-100 text-emerald-700 border-emerald-300';
    case 'ipynb': return 'bg-indigo-100 text-indigo-700 border-indigo-300';
    case 'java': return 'bg-red-100 text-red-800 border-red-300';
    case 'js':
    case 'ts':
    case 'jsx':
    case 'tsx': return 'bg-yellow-100 text-yellow-800 border-yellow-300';
    case 'json': return 'bg-gray-100 text-gray-700 border-gray-300';
    case 'sql': return 'bg-green-100 text-green-700 border-green-300';
    default: return 'bg-gray-100 text-gray-500 border-gray-300';
  }
}

export function CompactArtifactBadge({ file, onClick, title }: { file: CompactArtifactFile; onClick?: () => void; title?: string }) {
  return <button
    type="button"
    className={`whitespace-nowrap rounded border px-2 py-0.5 text-[11px] font-bold ${onClick ? 'cursor-pointer' : 'cursor-default'} ${artifactBadgeClass(file.filename)}`}
    onClick={onClick}
    title={title || file.filename}
  >{artifactExtensionLabel(file.filename)}</button>;
}

export function CompactArtifactCell<TFile extends CompactArtifactFile>({
  files,
  renderFile,
  fileKey,
  onPreview,
  onUpload,
  uploading = false,
  pending = false,
}: {
  files: TFile[];
  renderFile?: (file: TFile) => ReactNode;
  fileKey?: (file: TFile) => string | number;
  onPreview?: (file: TFile) => void;
  onUpload?: (files: File[]) => void | Promise<void>;
  uploading?: boolean;
  pending?: boolean;
}) {
  const chooseFiles = async () => {
    const selected = await openFiles({ multiple: true });
    if (selected?.length) await onUpload?.(selected);
  };

  return <div className={`flex min-h-8 flex-wrap items-center justify-center gap-1.5 rounded ${pending ? 'bg-amber-50' : ''}`}>
    {files.map(file => <div key={fileKey ? fileKey(file) : file.id}>{renderFile ? renderFile(file) : <CompactArtifactBadge file={file} onClick={onPreview ? () => onPreview(file) : undefined}/>}</div>)}
    {onUpload && (hasDesktopFileDialogs() ? <button
      type="button"
      className={`flex h-6 w-6 items-center justify-center rounded border border-dashed ${uploading ? 'border-gray-300 text-gray-300' : 'border-blue-300 text-blue-500 hover:bg-blue-50'}`}
      onClick={() => void chooseFiles()}
      disabled={uploading}
      title="산출물 업로드"
    >{uploading ? <Loader2 size={12} className="animate-spin"/> : <Upload size={12}/>}</button> : <label
      className={`flex h-6 w-6 items-center justify-center rounded border border-dashed ${uploading ? 'border-gray-300 text-gray-300' : 'cursor-pointer border-blue-300 text-blue-500 hover:bg-blue-50'}`}
      title="산출물 업로드"
    >
      {uploading ? <Loader2 size={12} className="animate-spin"/> : <Upload size={12}/>}<input type="file" className="hidden" multiple disabled={uploading} onChange={event => { const selected = Array.from(event.target.files || []); event.target.value = ''; if (selected.length) void onUpload(selected); }}/>
    </label>)}
  </div>;
}
