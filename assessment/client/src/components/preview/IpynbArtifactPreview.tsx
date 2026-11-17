import { useEffect, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { oneDark } from '@codemirror/theme-one-dark';
import { python } from '@codemirror/lang-python';
import DOMPurify from 'dompurify';
import { AlertTriangle, Loader2, Play } from 'lucide-react';
import MarkdownIt from 'markdown-it';

const markdownRenderer = new MarkdownIt({ html: true, linkify: true, breaks: true, typographer: false });

interface NotebookCell {
  cell_type?: string;
  source?: string | string[];
  execution_count?: number | null;
  outputs?: NotebookOutput[];
}

interface NotebookOutput {
  output_type?: string;
  name?: string;
  text?: string | string[];
  data?: Record<string, string | string[]>;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

interface Notebook {
  cells?: NotebookCell[];
}

function normalizeText(value: unknown): string {
  if (Array.isArray(value)) return value.join('');
  return typeof value === 'string' ? value : '';
}

function renderOutput(output: NotebookOutput, index: number) {
  if (output.output_type === 'stream') {
    return (
      <pre key={index} className="whitespace-pre-wrap rounded border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-700">
        {normalizeText(output.text)}
      </pre>
    );
  }

  if (output.output_type === 'error') {
    const traceback = output.traceback?.join('\n') || `${output.ename || 'Error'}: ${output.evalue || ''}`;
    return (
      <pre key={index} className="whitespace-pre-wrap rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
        {traceback}
      </pre>
    );
  }

  const data = output.data || {};
  const imagePng = normalizeText(data['image/png']);
  if (imagePng) {
    return (
      <div key={index} className="rounded border border-gray-200 bg-white p-3">
        <img src={`data:image/png;base64,${imagePng.replace(/\s/g, '')}`} className="max-w-full" />
      </div>
    );
  }

  const textPlain = normalizeText(data['text/plain']);
  if (textPlain) {
    return (
      <pre key={index} className="whitespace-pre-wrap rounded border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-700">
        {textPlain}
      </pre>
    );
  }

  const html = normalizeText(data['text/html']);
  if (html) {
    return (
      <iframe
        key={index}
        title={`notebook-html-output-${index}`}
        sandbox=""
        srcDoc={`<!doctype html><meta charset="utf-8"><style>body{font-family:system-ui,sans-serif;font-size:12px;margin:0;color:#111}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:4px 6px}</style>${html}`}
        className="h-48 w-full rounded border border-gray-200 bg-white"
      />
    );
  }

  return null;
}

function renderMarkdown(source: string) {
  const html = DOMPurify.sanitize(markdownRenderer.render(source), {
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'meta', 'link'],
    FORBID_ATTR: ['style'],
  });
  return (
    <div
      className="prose-preview max-w-none text-sm leading-relaxed text-gray-800"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export default function IpynbArtifactPreview({ fileUrl }: { fileUrl: string }) {
  const [notebook, setNotebook] = useState<Notebook | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        setError('');
        const res = await fetch(fileUrl);
        if (!res.ok) throw new Error(`파일 로드 실패 (${res.status})`);
        const parsed = await res.json();
        if (active) setNotebook(parsed);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [fileUrl]);

  if (loading) return <div className="flex items-center justify-center h-full"><Loader2 size={24} className="animate-spin text-gray-400" /></div>;
  if (error) return <div className="p-4 text-red-500 text-center">노트북 렌더링 실패: {error}</div>;
  if (!notebook?.cells?.length) return <div className="p-4 text-gray-500 text-center">노트북 셀을 찾을 수 없습니다.</div>;

  return (
    <div className="h-full overflow-auto bg-gray-100 p-4">
      <div className="mx-auto max-w-5xl space-y-3">
        {notebook.cells.map((cell, idx) => {
          const source = normalizeText(cell.source);
          if (cell.cell_type === 'markdown') {
            return (
              <div key={idx} className="rounded border border-gray-200 bg-white px-4 py-3 shadow-sm">
                {renderMarkdown(source)}
              </div>
            );
          }

          if (cell.cell_type === 'code') {
            const outputs = cell.outputs || [];
            return (
              <div key={idx} className="overflow-hidden rounded border border-gray-300 bg-white shadow-sm">
                <div className="flex items-center gap-2 border-b border-gray-200 bg-gray-50 px-3 py-2 text-xs font-medium text-gray-600">
                  <Play size={13} />
                  <span>Code</span>
                  <span className="ml-auto font-mono text-gray-400">[{cell.execution_count ?? ' '}]</span>
                </div>
                <CodeMirror
                  value={source}
                  theme={oneDark}
                  extensions={[python()]}
                  readOnly
                  basicSetup={{ lineNumbers: true, foldGutter: true, tabSize: 4 }}
                  style={{ fontSize: 13 }}
                />
                {outputs.length > 0 && (
                  <div className="space-y-2 border-t border-gray-200 bg-white p-3">
                    {outputs.map((output, outputIdx) => renderOutput(output, outputIdx))}
                  </div>
                )}
              </div>
            );
          }

          return (
            <div key={idx} className="flex items-center gap-2 rounded border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
              <AlertTriangle size={16} />
              지원하지 않는 셀 타입: {cell.cell_type || 'unknown'}
            </div>
          );
        })}
      </div>
    </div>
  );
}
