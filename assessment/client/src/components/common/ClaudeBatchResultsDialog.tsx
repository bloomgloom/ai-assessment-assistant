export interface ClaudeBatchResultJob {
  id: string;
  contentType: string;
  domains: string[];
  studentIds: number[];
  total: number;
  startedAt: number;
  providerBatchIds?: string[];
  lockedCells?: Array<{ contentType: string; domain: string; studentIds: number[] }>;
  status?: string;
  message?: string;
}

function startedAtLabel(value: number) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

export function ClaudeBatchResultsDialog({ title = 'Claude 배치 결과', subtitle, jobs, kindLabel, domainLabel, receivingId, onReceive, onClose }: {
  title?: string;
  subtitle: string;
  jobs: ClaudeBatchResultJob[];
  kindLabel: (job: ClaudeBatchResultJob) => string;
  domainLabel: (job: ClaudeBatchResultJob) => string;
  receivingId?: string;
  onReceive: (job: ClaudeBatchResultJob) => void | Promise<void>;
  onClose: () => void;
}) {
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
    <div className="w-full max-w-3xl rounded-lg border border-gray-200 bg-white shadow-xl" onClick={event => event.stopPropagation()}>
      <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
        <div><h3 className="text-sm font-semibold text-gray-900">{title}</h3><p className="mt-1 text-xs text-gray-500">{subtitle}</p></div>
        <button type="button" className="rounded px-2 py-1 text-sm text-gray-500 hover:bg-gray-100 hover:text-gray-700" onClick={onClose}>닫기</button>
      </div>
      <div className="max-h-[65vh] overflow-auto p-4">
        {!jobs.length ? <div className="py-10 text-center text-sm text-gray-400">남아있는 배치가 없습니다.</div> : <table className="w-full border-collapse text-sm">
          <thead><tr className="border-b bg-gray-50 text-xs font-semibold text-gray-600"><th className="px-3 py-2 text-center">종류</th><th className="px-3 py-2 text-center">영역</th><th className="px-3 py-2 text-center">인원 수</th><th className="px-3 py-2 text-center">상태</th><th className="px-3 py-2 text-center">요청 시각</th><th className="px-3 py-2 text-center">결과</th></tr></thead>
          <tbody>{jobs.map(job => {
            const requestPending = !job.providerBatchIds?.length;
            const stateLabel = requestPending ? '요청 중' : receivingId === job.id ? '확인 중' : '결과 대기';
            return <tr key={job.id} className="border-b last:border-b-0"><td className="px-3 py-2 text-center text-gray-800">{kindLabel(job)}</td><td className="px-3 py-2 text-center text-gray-600">{domainLabel(job)}</td><td className="px-3 py-2 text-center tabular-nums text-gray-600">{job.studentIds.length || job.total}</td><td className="px-3 py-2 text-center text-gray-600">{stateLabel}</td><td className="px-3 py-2 text-center text-gray-600">{startedAtLabel(job.startedAt)}</td><td className="px-3 py-2 text-center"><button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => void onReceive(job)} disabled={requestPending || receivingId === job.id}>{requestPending ? '요청 중' : receivingId === job.id ? '확인 중...' : '결과 받기'}</button></td></tr>;
          })}</tbody>
        </table>}
      </div>
    </div>
  </div>;
}
