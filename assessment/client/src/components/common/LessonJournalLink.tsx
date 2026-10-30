import { useEffect, useState } from 'react';
import { FileSpreadsheet, Link2Off, X } from 'lucide-react';
import { lessonPlansApi, type AcademicSubjectScope } from '../../lib/api';
import { openFilePath } from '../../lib/desktopFiles';

const OPEN_EVENT = 'lesson-journal-link-open';
const CHANGED_EVENT = 'lesson-journal-link-changed';

export interface LessonJournalLinkState {
  linked: boolean;
  filename: string;
  filepath: string;
}

interface LessonJournalLinkChangedDetail extends LessonJournalLinkState {
  scope: AcademicSubjectScope;
}

function stateFromSettings(settings: any): LessonJournalLinkState {
  const filepath = String(settings?.excel_path || settings?.source_filepath || '');
  const filename = String(settings?.source_filename || (filepath ? filepath.split(/[\\/]/).at(-1) : '') || '');
  return { linked: !!(filename || filepath), filename, filepath };
}

export function openLessonJournalLinkDialog(scope: AcademicSubjectScope) {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: scope }));
}

export function subscribeLessonJournalLinkChanged(listener: (detail: LessonJournalLinkChangedDetail) => void) {
  const handler = (event: Event) => listener((event as CustomEvent<LessonJournalLinkChangedDetail>).detail);
  window.addEventListener(CHANGED_EVENT, handler);
  return () => window.removeEventListener(CHANGED_EVENT, handler);
}

function publishChanged(scope: AcademicSubjectScope, state: LessonJournalLinkState) {
  window.dispatchEvent(new CustomEvent<LessonJournalLinkChangedDetail>(CHANGED_EVENT, { detail: { scope, ...state } }));
}

function LessonJournalLinkField({ scope, state, onChange, disabled = false }: {
  scope: AcademicSubjectScope;
  state: LessonJournalLinkState;
  onChange: (state: LessonJournalLinkState) => void;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);

  const chooseFile = async () => {
    const filepath = await openFilePath([{ name: '수업 일지 엑셀', extensions: ['xlsx', 'xls'] }]);
    if (filepath === null) return alert('수업 일지 엑셀 연결은 데스크톱 앱에서 사용할 수 있습니다.');
    if (!filepath) return;
    setBusy(true);
    try {
      const { data } = await lessonPlansApi.linkSourcePath(scope, filepath);
      const next = { linked: true, filename: String(data.filename || ''), filepath: String(data.filepath || filepath) };
      onChange(next);
      publishChanged(scope, next);
    } catch (error: any) {
      alert(error?.response?.data?.error || '수업 일지 엑셀을 연결하지 못했습니다.');
    } finally { setBusy(false); }
  };

  const unlink = async () => {
    if (!state.linked || !confirm('수업 일지 엑셀 링크를 해제하고 앱 편집으로 전환하시겠습니까? 원본 파일은 삭제되지 않습니다.')) return;
    setBusy(true);
    try {
      await lessonPlansApi.deleteSource(scope);
      const next = { linked: false, filename: '', filepath: '' };
      onChange(next);
      publishChanged(scope, next);
    } catch (error: any) {
      alert(error?.response?.data?.error || '수업 일지 엑셀 링크를 해제하지 못했습니다.');
    } finally { setBusy(false); }
  };

  return <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
    <div className="mb-2 text-xs font-semibold text-gray-700">수업 일지 엑셀</div>
    <div className="flex min-w-0 items-center gap-2">
      <input className="input min-w-0 flex-1 bg-white text-xs" readOnly value={state.filepath || state.filename} placeholder="연결된 파일이 없습니다." title={state.filepath || state.filename || undefined}/>
      <button type="button" className="btn-secondary shrink-0" onClick={() => void chooseFile()} disabled={disabled || busy}>
        <FileSpreadsheet size={14}/> 파일 지정
      </button>
      <button type="button" className="btn-secondary shrink-0 border-red-200 text-red-600 hover:bg-red-50" onClick={() => void unlink()} disabled={disabled || busy || !state.linked}>
        <Link2Off size={14}/> 링크 해제
      </button>
    </div>
  </div>;
}

export function LessonJournalLinkDialogHost() {
  const [scope, setScope] = useState<AcademicSubjectScope | null>(null);
  const [state, setState] = useState<LessonJournalLinkState>({ linked: false, filename: '', filepath: '' });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const handler = (event: Event) => {
      const nextScope = (event as CustomEvent<AcademicSubjectScope>).detail;
      setScope(nextScope);
      setState({ linked: false, filename: '', filepath: '' });
      setLoading(true);
      lessonPlansApi.getSettings(nextScope)
        .then(({ data }) => setState(stateFromSettings(data)))
        .catch((error: any) => {
          alert(error?.response?.data?.error || '수업 일지 엑셀 연결 정보를 불러오지 못했습니다.');
          setScope(null);
        })
        .finally(() => setLoading(false));
    };
    window.addEventListener(OPEN_EVENT, handler);
    return () => window.removeEventListener(OPEN_EVENT, handler);
  }, []);

  if (!scope) return null;
  return <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40 p-6" onClick={() => setScope(null)}>
    <div className="w-full max-w-2xl rounded-lg bg-white shadow-xl" onClick={event => event.stopPropagation()}>
      <div className="flex items-center justify-between border-b px-5 py-4">
        <div><h3 className="font-semibold text-gray-900">수업 일지 엑셀 연결</h3><p className="mt-1 text-xs text-gray-500">{scope.year}학년도 {scope.semester}학기 {scope.grade}학년 · {scope.subject}</p></div>
        <button type="button" className="rounded p-1 text-gray-400 hover:bg-gray-100" onClick={() => setScope(null)} title="닫기"><X size={18}/></button>
      </div>
      <div className="p-5"><LessonJournalLinkField scope={scope} state={state} onChange={setState} disabled={loading}/></div>
      <div className="flex justify-end border-t px-5 py-4"><button type="button" className="btn-secondary" onClick={() => setScope(null)}>닫기</button></div>
    </div>
  </div>;
}
