import { useState } from 'react';
import { FolderOpen, Link2Off } from 'lucide-react';
import { lessonPlansApi, type AcademicSubjectScope } from '../../lib/api';
import { openDirectory } from '../../lib/desktopFiles';

export interface ArtifactSourceFolderState {
  sourceFolder: string;
  exists: boolean;
  missingSourceFiles: string[];
}

export function ArtifactSourceFolderField({ scope, value, onChange, disabled = false }: {
  scope: AcademicSubjectScope;
  value: string;
  onChange?: (state: ArtifactSourceFolderState) => void;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);

  const chooseFolder = async () => {
    const folder = await openDirectory();
    if (folder === null) return alert('산출물 원본 폴더 지정은 데스크톱 앱에서 사용할 수 있습니다.');
    if (!folder) return;
    setBusy(true);
    try {
      const { data } = await lessonPlansApi.setArtifactSourceFolder(scope, folder);
      const state = data as ArtifactSourceFolderState;
      onChange?.(state);
    } catch (error: any) {
      alert(error?.response?.data?.error || '산출물 원본 폴더를 지정하지 못했습니다.');
    } finally { setBusy(false); }
  };

  const clearFolder = async () => {
    if (!value || !confirm('산출물 원본 폴더 링크를 해제하시겠습니까? 원본 파일은 삭제되지 않습니다.')) return;
    setBusy(true);
    try {
      const { data } = await lessonPlansApi.clearArtifactSourceFolder(scope);
      const state = data as ArtifactSourceFolderState;
      onChange?.(state);
    } catch (error: any) {
      alert(error?.response?.data?.error || '산출물 원본 폴더 링크를 해제하지 못했습니다.');
    } finally { setBusy(false); }
  };

  return <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
    <div className="mb-2 text-xs font-semibold text-gray-700">산출물 원본 폴더</div>
    <div className="flex min-w-0 items-center gap-2">
      <input className="input min-w-0 flex-1 bg-white text-xs" readOnly value={value} placeholder="폴더를 지정하지 않았습니다." title={value || undefined}/>
      <button type="button" className="btn-secondary shrink-0" onClick={() => void chooseFolder()} disabled={disabled || busy}>
        <FolderOpen size={14}/> 폴더 지정
      </button>
      <button type="button" className="btn-secondary shrink-0 border-red-200 text-red-600 hover:bg-red-50" onClick={() => void clearFolder()} disabled={disabled || busy || !value}>
        <Link2Off size={14}/> 링크 해제
      </button>
    </div>
  </div>;
}
