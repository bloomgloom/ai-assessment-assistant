import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

const MAX_PREVIEW_ROWS = 500;
const MAX_PREVIEW_COLUMNS = 100;
const MAX_CELL_CHARACTERS = 20_000;
const MAX_SCAN_BYTES = 8 * 1024 * 1024;
const ENCODING_PROBE_BYTES = 64 * 1024;

function detectCsvEncoding(bytes: Uint8Array): 'utf-8' | 'euc-kr' | 'utf-16le' {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';

  const sampleSize = Math.min(bytes.length, 4_096);
  let oddNulls = 0;
  for (let i = 1; i < sampleSize; i += 2) {
    if (bytes[i] === 0) oddNulls++;
  }
  if (sampleSize > 8 && oddNulls > sampleSize / 8) return 'utf-16le';

  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true });
    return 'utf-8';
  } catch {
    return 'euc-kr';
  }
}

function joinChunks(chunks: Uint8Array[], size: number) {
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function createCsvPreviewParser() {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let pendingQuote = false;
  let skipLf = false;
  let limited = false;

  const pushCell = () => {
    if (row.length < MAX_PREVIEW_COLUMNS) row.push(cell);
    else limited = true;
    cell = '';
  };

  const pushRow = () => {
    pushCell();
    if (row.some(value => value.trim() !== '')) rows.push(row);
    row = [];
    if (rows.length >= MAX_PREVIEW_ROWS + 1) limited = true;
    return rows.length >= MAX_PREVIEW_ROWS + 1;
  };

  const append = (value: string) => {
    if (row.length >= MAX_PREVIEW_COLUMNS) {
      limited = true;
      return;
    }
    if (cell.length < MAX_CELL_CHARACTERS) cell += value;
    else limited = true;
  };

  const write = (text: string) => {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];

      if (skipLf) {
        skipLf = false;
        if (ch === '\n') continue;
      }

      if (pendingQuote) {
        pendingQuote = false;
        if (ch === '"') {
          append('"');
          continue;
        }
        inQuotes = false;
      }

      if (inQuotes) {
        if (ch === '"') pendingQuote = true;
        else append(ch);
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        pushCell();
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r') skipLf = true;
        if (pushRow()) return true;
      } else {
        append(ch);
      }
    }
    return false;
  };

  const finish = () => {
    pendingQuote = false;
    if (cell.length > 0 || row.length > 0) pushRow();
  };

  return {
    rows,
    write,
    finish,
    wasLimited: () => limited,
  };
}

export default function CsvArtifactPreview({ fileUrl }: { fileUrl: string }) {
  const [rows, setRows] = useState<string[][]>([]);
  const [loading, setLoading] = useState(true);
  const [limited, setLimited] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    (async () => {
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      try {
        setRows([]);
        setLimited(false);
        setError('');
        setLoading(true);

        const response = await fetch(fileUrl, { signal: controller.signal });
        if (!response.ok) throw new Error(`파일 로드 실패 (${response.status})`);
        if (!response.body) throw new Error('이 환경에서는 CSV 스트리밍 미리보기를 지원하지 않습니다.');

        reader = response.body.getReader();
        const parser = createCsvPreviewParser();
        const probeChunks: Uint8Array[] = [];
        let probeSize = 0;
        let scannedBytes = 0;
        let decoder: TextDecoder | null = null;
        let stopped = false;
        let hitScanLimit = false;

        while (!stopped) {
          const { value, done } = await reader.read();
          if (done) break;

          const remaining = MAX_SCAN_BYTES - scannedBytes;
          if (remaining <= 0) {
            hitScanLimit = true;
            break;
          }
          const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
          scannedBytes += chunk.byteLength;
          if (chunk.byteLength < value.byteLength || scannedBytes >= MAX_SCAN_BYTES) hitScanLimit = true;

          if (!decoder) {
            probeChunks.push(chunk);
            probeSize += chunk.byteLength;
            if (probeSize < ENCODING_PROBE_BYTES && !hitScanLimit) continue;

            const probe = joinChunks(probeChunks, probeSize);
            decoder = new TextDecoder(detectCsvEncoding(probe));
            stopped = parser.write(decoder.decode(probe, { stream: true }));
          } else {
            stopped = parser.write(decoder.decode(chunk, { stream: true }));
          }

          if (hitScanLimit) break;
        }

        if (!decoder && probeSize > 0) {
          const probe = joinChunks(probeChunks, probeSize);
          decoder = new TextDecoder(detectCsvEncoding(probe));
          stopped = parser.write(decoder.decode(probe, { stream: true }));
        }
        if (decoder && !stopped && !hitScanLimit) parser.write(decoder.decode());
        parser.finish();

        if (stopped || hitScanLimit) await reader.cancel();
        if (active) {
          setRows([...parser.rows]);
          setLimited(stopped || hitScanLimit || parser.wasLimited());
        }
      } catch (reason) {
        if (active && !controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
      controller.abort();
    };
  }, [fileUrl]);

  const header = rows[0] || [];
  const body = rows.slice(1, MAX_PREVIEW_ROWS + 1);

  if (loading) return <div className="flex items-center justify-center h-full"><Loader2 size={24} className="animate-spin text-gray-400" /></div>;
  if (error) return <div className="p-4 text-red-500 text-center">CSV 렌더링 실패: {error}</div>;
  if (rows.length === 0) return <div className="p-4 text-gray-500 text-center">CSV 내용이 없습니다.</div>;

  return (
    <div className="flex h-full flex-col bg-gray-50">
      <div className="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
        CSV는 최대 {MAX_PREVIEW_ROWS.toLocaleString()}행, {MAX_PREVIEW_COLUMNS.toLocaleString()}열까지만 미리보기합니다.
        {limited && ' 파일의 나머지 내용은 다운로드하여 확인하세요.'}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <table className="min-w-full border-collapse bg-white text-xs shadow-sm">
          <thead className="sticky top-0 z-10 bg-gray-100">
            <tr>
              <th className="border border-gray-200 px-2 py-1 text-right font-semibold text-gray-500 w-12">#</th>
              {header.map((cell, idx) => (
                <th key={idx} className="border border-gray-200 px-2 py-1 text-left font-semibold text-gray-700 whitespace-pre-wrap">
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, rowIdx) => (
              <tr key={rowIdx} className="odd:bg-white even:bg-gray-50">
                <td className="border border-gray-200 px-2 py-1 text-right text-gray-400">{rowIdx + 1}</td>
                {Array.from({ length: Math.max(header.length, row.length) }).map((_, cellIdx) => (
                  <td key={cellIdx} className="border border-gray-200 px-2 py-1 text-gray-800 whitespace-pre-wrap align-top">
                    {row[cellIdx] || ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
