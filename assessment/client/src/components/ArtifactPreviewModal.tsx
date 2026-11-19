import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Download, Eye, Loader2, X } from 'lucide-react';
import { downloadUrl } from '../lib/desktopFiles';
import { artifactPreviewUrl } from '../lib/artifactPreview';
import { artifactFileUrl, PreviewArtifact } from './ArtifactPreviewContent';

const ArtifactPreviewContent = lazy(() => import('./ArtifactPreviewContent'));

const CODE_EXTS = new Set(['js', 'jsx', 'ts', 'tsx', 'py', 'c', 'cpp', 'h', 'java', 'css', 'sql', 'json', 'txt']);

function isCodeFile(filename: string) {
  return CODE_EXTS.has(filename.split('.').pop()?.toLowerCase() || '');
}

interface ArtifactPreviewModalProps {
  artifact: PreviewArtifact | null;
  onClose: () => void;
}

function useArtifactPreview(artifact: PreviewArtifact | null) {
  const [codeContent, setCodeContent] = useState('');
  const [loadingCode, setLoadingCode] = useState(false);
  const [pdfPages, setPdfPages] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setCodeContent('');
    setPdfPages(0);
    setLoadingCode(false);
    if (!artifact || !isCodeFile(artifact.filename)) return;

    setLoadingCode(true);
    fetch(artifactFileUrl(artifact))
      .then(response => {
        if (!response.ok) throw new Error('파일을 불러오지 못했습니다.');
        return response.text();
      })
      .then(content => {
        if (!cancelled) setCodeContent(content);
      })
      .catch(error => {
        if (!cancelled) setCodeContent(`파일을 불러오지 못했습니다: ${error.message}`);
      })
      .finally(() => {
        if (!cancelled) setLoadingCode(false);
      });

    return () => { cancelled = true; };
  }, [artifact]);

  return { codeContent, loadingCode, pdfPages, setPdfPages };
}

export default function ArtifactPreviewModal({ artifact, onClose }: ArtifactPreviewModalProps) {
  const preview = useArtifactPreview(artifact);

  useEffect(() => {
    if (!artifact) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [artifact, onClose]);

  if (!artifact) return null;

  const fileUrl = artifactFileUrl(artifact);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="flex h-[85vh] w-[85vw] min-w-0 flex-col overflow-hidden rounded-lg bg-white shadow-xl">
        <div className="flex shrink-0 items-center justify-between border-b border-gray-200 px-4 py-3">
          <div className="min-w-0 max-w-[60%]">
            <div className="truncate text-sm font-medium text-gray-800">{artifact.filename}</div>
            {artifact.filepath && (
              <div className="truncate text-[11px] text-gray-500" title={artifact.filepath}>
                저장 위치: {artifact.filepath}
              </div>
            )}
          </div>
          <div className="flex shrink-0 gap-2">
            <a
              href={artifactPreviewUrl(artifact)}
              target="_blank"
              rel="noopener noreferrer"
              onClick={onClose}
              className="btn-secondary inline-flex items-center gap-1 py-1 text-xs"
            >
              <Eye size={13} /> 새 탭
            </a>
            <button
              type="button"
              onClick={() => downloadUrl(fileUrl, artifact.filename).catch(error => alert(error.message))}
              className="btn-secondary inline-flex items-center gap-1 py-1 text-xs"
            >
              <Download size={13} /> 다운로드
            </button>
            <button type="button" className="btn-secondary inline-flex items-center gap-1 py-1 text-xs" onClick={onClose}>
              <X size={13} /> 닫기
            </button>
          </div>
        </div>
        <Suspense fallback={<div className="flex flex-1 items-center justify-center"><Loader2 size={24} className="animate-spin text-gray-400" /></div>}>
          <ArtifactPreviewContent
            artifact={artifact}
            {...preview}
          />
        </Suspense>
      </div>
    </div>
  );
}

export function ArtifactPreviewStandalonePage() {
  const { source, id } = useParams();
  const [searchParams] = useSearchParams();
  const filename = searchParams.get('filename') || '';
  const filepath = searchParams.get('filepath') || '';
  const artifact = useMemo<PreviewArtifact | null>(() => {
    if (!filename || !id || !['artifact', 'assignment', 'resource', 'activity'].includes(source || '')) return null;
    return {
      id: Number(id),
      filename,
      filepath: filepath || undefined,
      source: source as PreviewArtifact['source'],
    };
  }, [filename, filepath, id, source]);
  const preview = useArtifactPreview(artifact);

  useEffect(() => {
    if (!window.assessmentDesktop) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') window.close();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, []);

  if (!artifact || !Number.isFinite(artifact.id)) {
    return <div className="flex h-screen items-center justify-center text-sm text-gray-500">미리보기 파일 정보가 올바르지 않습니다.</div>;
  }

  const fileUrl = artifactFileUrl(artifact);
  return (
    <div className="flex h-screen w-full min-w-0 flex-1 flex-col overflow-hidden bg-white">
      <div className="flex w-full min-w-0 shrink-0 items-center justify-between border-b border-gray-200 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-gray-800">{artifact.filename}</div>
          {artifact.filepath && (
            <div className="truncate text-[11px] text-gray-500" title={artifact.filepath}>
              저장 위치: {artifact.filepath}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => downloadUrl(fileUrl, artifact.filename).catch(error => alert(error.message))}
          className="btn-secondary ml-2 inline-flex shrink-0 items-center gap-1 py-1 text-xs"
        >
          <Download size={13} /> 다운로드
        </button>
      </div>
      <Suspense fallback={<div className="flex flex-1 items-center justify-center"><Loader2 size={24} className="animate-spin text-gray-400" /></div>}>
        <ArtifactPreviewContent artifact={artifact} {...preview} />
      </Suspense>
    </div>
  );
}
