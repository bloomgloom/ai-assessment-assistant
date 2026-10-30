import { lazy, Suspense } from 'react';
import { File, Loader2 } from 'lucide-react';
import { activityApi, artifactsApi, assignmentConfigsApi } from '../lib/api';
import { downloadUrl } from '../lib/desktopFiles';

const CodeArtifactPreview = lazy(() => import('./preview/CodeArtifactPreview'));
const MarkdownArtifactPreview = lazy(() => import('./preview/MarkdownArtifactPreview'));
const PdfArtifactPreview = lazy(() => import('./preview/PdfArtifactPreview'));
const HwpxArtifactPreview = lazy(() => import('./preview/HwpxArtifactPreview'));
const CsvArtifactPreview = lazy(() => import('./preview/CsvArtifactPreview'));
const IpynbArtifactPreview = lazy(() => import('./preview/IpynbArtifactPreview'));

export interface PreviewArtifact {
  id: number;
  filename: string;
  filepath?: string;
  source?: 'artifact' | 'assignment' | 'resource' | 'activity';
}

interface ArtifactPreviewContentProps {
  artifact: PreviewArtifact;
  codeContent: string;
  loadingCode: boolean;
  pdfPages: number;
  setPdfPages: (n: number) => void;
}

function getExt(filename: string): string {
  return filename.split('.').pop()?.toLowerCase() || '';
}

function isMdFile(f: string) { return getExt(f) === 'md'; }
function isCodeFile(f: string) { return ['js','jsx','ts','tsx','py','c','cpp','h','java','css','sql','json','txt'].includes(getExt(f)); }
function isHtmlFile(f: string) { return getExt(f) === 'html'; }
function isPdfFile(f: string) { return getExt(f) === 'pdf'; }
function isHwpxFile(f: string) { return getExt(f) === 'hwpx'; }
function isCsvFile(f: string) { return getExt(f) === 'csv'; }
function isIpynbFile(f: string) { return getExt(f) === 'ipynb'; }

function PreviewFallback() {
  return (
    <div className="flex h-full items-center justify-center">
      <Loader2 size={24} className="animate-spin text-gray-400" />
    </div>
  );
}

export function artifactFileUrl(artifact: PreviewArtifact) {
  if (artifact.source === 'assignment') return assignmentConfigsApi.submissionFileUrl(artifact.id);
  if (artifact.source === 'resource') return assignmentConfigsApi.resourceFileUrl(artifact.id);
  if (artifact.source === 'activity') return activityApi.fileUrl(artifact.id);
  return artifactsApi.fileUrl(artifact.id);
}

export default function ArtifactPreviewContent({
  artifact,
  codeContent,
  loadingCode,
  pdfPages,
  setPdfPages,
}: ArtifactPreviewContentProps) {
  const fileUrl = artifactFileUrl(artifact);
  return (
    <div className="min-w-0 flex-1 overflow-hidden" style={{ textAlign: 'left' }}>
      {isPdfFile(artifact.filename) ? (
        <Suspense fallback={<PreviewFallback />}>
          <PdfArtifactPreview
            fileUrl={fileUrl}
            pdfPages={pdfPages}
            setPdfPages={setPdfPages}
          />
        </Suspense>
      ) : isHwpxFile(artifact.filename) ? (
        <Suspense fallback={<PreviewFallback />}>
          <HwpxArtifactPreview fileUrl={fileUrl} />
        </Suspense>
      ) : isCsvFile(artifact.filename) ? (
        <Suspense fallback={<PreviewFallback />}>
          <CsvArtifactPreview fileUrl={fileUrl} />
        </Suspense>
      ) : isIpynbFile(artifact.filename) ? (
        <Suspense fallback={<PreviewFallback />}>
          <IpynbArtifactPreview fileUrl={fileUrl} />
        </Suspense>
      ) : isHtmlFile(artifact.filename) ? (
        <iframe
          src={fileUrl}
          className="w-full h-full border-none bg-white"
          title="HTML Viewer"
          sandbox="allow-scripts allow-same-origin"
        />
      ) : isMdFile(artifact.filename) ? (
        <Suspense fallback={<PreviewFallback />}>
          <MarkdownArtifactPreview fileUrl={fileUrl} />
        </Suspense>
      ) : isCodeFile(artifact.filename) ? (
        <Suspense fallback={<PreviewFallback />}>
          <CodeArtifactPreview
            filename={artifact.filename}
            codeContent={codeContent}
            loadingCode={loadingCode}
          />
        </Suspense>
      ) : (
        <div className="flex flex-col items-center justify-center h-full gap-4 text-gray-500">
          <File size={48} className="text-gray-300" />
          <p>이 파일 형식은 뷰어에서 지원하지 않습니다.</p>
          <button
            type="button"
            className="btn-primary"
            onClick={() => downloadUrl(fileUrl, artifact.filename).catch((error) => alert(error.message))}
          >
            다운로드
          </button>
        </div>
      )}
    </div>
  );
}
