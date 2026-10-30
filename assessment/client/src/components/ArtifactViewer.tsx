import { lazy, Suspense, useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { artifactsApi, assignmentConfigsApi } from '../lib/api';
import { downloadUrl } from '../lib/desktopFiles';
import { X, Loader2, Download } from 'lucide-react';
import { artifactExtension, CompactArtifactBadge, CompactArtifactCell } from './common/CompactArtifactCell';

const ArtifactPreviewModal = lazy(() => import('./ArtifactPreviewModal'));
const ArtifactPreviewContent = lazy(() => import('./ArtifactPreviewContent'));

interface Artifact {
  id: number;
  filename: string;
  filepath?: string;
  mime_type: string;
  domain: string;
  uploaded_at: string;
  source?: 'artifact' | 'assignment';
}

function isCodeFile(f: string) { return ['js','jsx','ts','tsx','py','c','cpp','h','java','css','sql','json','md','txt'].includes(artifactExtension(f)); }

function sortArtifacts(a: Artifact, b: Artifact) {
  const extCompare = artifactExtension(a.filename).localeCompare(artifactExtension(b.filename), 'ko');
  if (extCompare !== 0) return extCompare;
  return a.filename.localeCompare(b.filename, 'ko', { numeric: true });
}

interface ArtifactViewerProps {
  studentId: number;
  domain: string;
}

export default function ArtifactViewer({ studentId, domain }: ArtifactViewerProps) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [viewing, setViewing] = useState<Artifact | null>(null);
  const [uploading, setUploading] = useState(false);

  const loadArtifacts = async () => {
    const r = await artifactsApi.getByDomain(studentId, domain);
    setArtifacts([...r.data].sort(sortArtifacts));
  };

  useEffect(() => { loadArtifacts(); }, [studentId, domain]);

  const handleUpload = async (files: File[]) => {
    if (!files.length) return;
    setUploading(true);
    try {
      await artifactsApi.upload(studentId, domain, files);
      await loadArtifacts();
    } catch (err: any) {
      alert(`파일 업로드 실패: ${err?.response?.data?.error || err.message || String(err)}`);
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (artifact: Artifact) => {
    const message = artifact.source === 'assignment'
      ? '학생이 평가 실시에서 제출한 파일입니다. 제출 기록에서 제거하고 휴지통으로 이동하시겠습니까?'
      : '파일을 삭제하고 휴지통으로 이동하시겠습니까?';
    if (!confirm(message)) return;
    try {
      if (artifact.source === 'assignment') await assignmentConfigsApi.deleteSubmission(artifact.id);
      else await artifactsApi.delete(artifact.id);
      if (viewing?.id === artifact.id && viewing?.source === artifact.source) setViewing(null);
      await loadArtifacts();
    } catch (error: any) {
      alert(`파일 삭제 실패: ${error?.response?.data?.error || error.message || String(error)}`);
    }
  };

  return (
    <>
      <CompactArtifactCell files={artifacts} fileKey={a => `${a.source || 'artifact'}:${a.id}`} uploading={uploading} onUpload={handleUpload} renderFile={a => (
        <div key={`${a.source || 'artifact'}:${a.id}`} className="relative group">
          <CompactArtifactBadge file={a} onClick={() => setViewing(a)} title={a.filepath ? `${a.filename}\n저장 위치: ${a.filepath}` : a.filename}/>
          <button
            className="absolute -top-1.5 -right-1.5 hidden group-hover:flex items-center justify-center w-3.5 h-3.5 rounded-full bg-red-500 text-white"
            onClick={() => handleDelete(a)}
          >
            <X size={8} />
          </button>
        </div>
      )}/>

      <Suspense fallback={null}>
        <ArtifactPreviewModal artifact={viewing} onClose={() => setViewing(null)} />
      </Suspense>
    </>
  );
}

export function ArtifactStandalonePage() {
  const { id } = useParams();
  const artifactId = Number(id);
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [codeContent, setCodeContent] = useState('');
  const [pdfPages, setPdfPages] = useState(0);
  const [loadingCode, setLoadingCode] = useState(false);

  useEffect(() => {
    if (!artifactId) return;
    (async () => {
      const r = await artifactsApi.getOne(artifactId);
      setArtifact(r.data);
      if (isCodeFile(r.data.filename)) {
        setLoadingCode(true);
        try {
          setCodeContent(await (await fetch(artifactsApi.fileUrl(artifactId))).text());
        } finally {
          setLoadingCode(false);
        }
      }
    })();
  }, [artifactId]);

  if (!artifact) return <div className="h-screen flex items-center justify-center"><Loader2 className="animate-spin text-gray-400" /></div>;

  return (
    <div className="h-screen flex flex-col bg-white">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 shrink-0">
        <span className="min-w-0 flex-1 truncate font-medium text-sm text-gray-800">{artifact.filename}</span>
        <button
          type="button"
          onClick={() => downloadUrl(artifactsApi.fileUrl(artifact.id), artifact.filename).catch((error) => alert(error.message))}
          className="btn-secondary ml-2 shrink-0 text-xs py-1"
        >
          <Download size={13} /> 다운로드
        </button>
      </div>
      <Suspense fallback={<div className="flex flex-1 items-center justify-center"><Loader2 size={24} className="animate-spin text-gray-400" /></div>}>
        <ArtifactPreviewContent
          artifact={artifact}
          codeContent={codeContent}
          loadingCode={loadingCode}
          pdfPages={pdfPages}
          setPdfPages={setPdfPages}
        />
      </Suspense>
    </div>
  );
}
