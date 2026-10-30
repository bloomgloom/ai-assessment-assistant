import { ReactNode, useMemo } from 'react';
import { X } from 'lucide-react';

export interface BulkImportResultItem {
  path: string;
  status: string;
  studentId?: number;
  student?: string;
  classNum?: number;
  seatNum?: number;
  studentName?: string;
  date?: string;
  filename?: string;
  reason?: string;
}

interface Props {
  title: string;
  message: string;
  stats: Array<{ label: string; value: number }>;
  results: BulkImportResultItem[];
  onClose: () => void;
  groupLabel?: (key: string, items: BulkImportResultItem[]) => ReactNode;
}

export function BulkImportResultDialog({ title, message, stats, results, onClose, groupLabel }: Props) {
  const hasSeparatedStudentColumns = results.some(item => item.classNum !== undefined || item.seatNum !== undefined || item.studentName);
  const statusLabel = (status: string) => ({
    uploaded: '등록', unmatched: '미매칭', conflict: '충돌', read_error: '오류',
    added: '새 파일', updated: '기존 파일 업데이트', unchanged: '변경 없음',
    date_missing: '날짜 칸 없음', reflection: '성찰',
  } as Record<string, string>)[status] || status;
  const groups = useMemo(() => {
    const map = new Map<string, BulkImportResultItem[]>();
    for (const result of results) {
      const key = ['unmatched', 'conflict', 'read_error', 'date_missing'].includes(result.status)
        ? '연결 안 됨'
        : (result.date || '변동 파일');
      map.set(key, [...(map.get(key) || []), result]);
    }
    return [...map.entries()];
  }, [results]);
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6">
    <div className="flex max-h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg bg-white shadow-xl">
      <div className="flex items-center justify-between border-b px-5 py-4"><div><h3 className="font-bold">{title}</h3><p className="text-sm text-gray-600 mt-1">{message}</p></div><button onClick={onClose}><X size={20}/></button></div>
      <div className="flex flex-wrap gap-2 border-b p-4">{stats.map(stat => <div key={stat.label} className="rounded border bg-gray-50 px-3 py-2 text-sm"><span className="text-gray-500">{stat.label}</span> <strong>{stat.value}</strong></div>)}</div>
      <div className="flex-1 overflow-auto p-4 space-y-3">{groups.map(([key,items]) => <details key={key} open={key !== '연결 안 됨'} className="rounded border"><summary className="cursor-pointer bg-gray-50 px-4 py-2 font-medium">{groupLabel ? groupLabel(key,items) : `${key} — ${items.length}개`}</summary><table className="w-full table-fixed text-xs"><thead><tr className="border-t bg-gray-50">{hasSeparatedStudentColumns ? <><th className="w-12 p-2">반</th><th className="w-12 p-2">번호</th><th className="w-20 p-2">이름</th></> : <th className="w-24 p-2">학생</th>}<th className="w-28 p-2">결과</th><th className="p-2">등록 파일/경로</th><th className="p-2">설명</th></tr></thead><tbody>{items.map((item,index) => <tr key={`${item.path}-${index}`} className="border-t">{hasSeparatedStudentColumns ? <><td className="p-2 text-center">{item.classNum ?? '-'}</td><td className="p-2 text-center">{item.seatNum ?? '-'}</td><td className="p-2 text-center">{item.studentName || '-'}</td></> : <td className="p-2 text-center">{item.student || '-'}</td>}<td className="p-2 text-center">{statusLabel(item.status)}</td><td className="p-2 break-all">{item.filename || item.path}</td><td className="p-2 text-gray-600">{item.reason || ''}</td></tr>)}</tbody></table></details>)}</div>
      <div className="border-t p-4 text-right"><button className="btn-primary" onClick={onClose}>닫기</button></div>
    </div>
  </div>;
}
