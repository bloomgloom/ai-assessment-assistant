import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle, Loader2, Save, Terminal } from 'lucide-react';
import { AiProgressOverlay } from '../../components/common/AiProgressOverlay';
import { startDisplaySleepPrevention, stopDisplaySleepPrevention } from '../../lib/displaySleepPrevention';

interface PythonRuntimeState {
  ready: boolean;
  installing: boolean;
  pythonPath: string;
  runtimeDir: string;
  requirements: string[];
  baseRequirements: string[];
  interrupted: boolean;
}

interface RuntimeEvent {
  type: 'progress' | 'committed' | 'done' | 'complete' | 'error';
  message?: string;
  error?: string;
  current?: number;
  total?: number;
  requirements?: string[];
  state?: PythonRuntimeState;
}

const requirementsText = (requirements: string[]) => requirements.join('\n');

export function PythonEnvironmentSettings() {
  const [state, setState] = useState<PythonRuntimeState | null>(null);
  const [requirements, setRequirements] = useState('');
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [progressMessage, setProgressMessage] = useState('Python 환경을 준비하고 있습니다.');
  const [progressCurrent, setProgressCurrent] = useState(0);
  const [progressTotal, setProgressTotal] = useState(0);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const loadState = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/settings/python-runtime', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || 'Python 환경 정보를 불러오지 못했습니다.');
      setState(data);
      setRequirements(requirementsText(data.requirements || []));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadState();
  }, []);

  const applyRequirements = async () => {
    setInstalling(true);
    setError('');
    setSaved(false);
    setProgressCurrent(0);
    setProgressTotal(0);
    setProgressMessage('Python 환경을 준비하고 있습니다.');
    (window as any).__pythonEnvironmentInstalling = true;
    await startDisplaySleepPrevention();

    let terminalError = '';
    try {
      const response = await fetch('/api/settings/python-runtime/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requirements }),
      });
      if (!response.ok || !response.body) {
        throw new Error(`Python 환경 요청에 실패했습니다. (${response.status})`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      const handleEvent = (event: RuntimeEvent) => {
        if (event.message) setProgressMessage(event.message);
        if (event.current !== undefined) setProgressCurrent(event.current);
        if (event.total !== undefined) setProgressTotal(event.total);
        if (event.requirements) setRequirements(requirementsText(event.requirements));
        if (event.state) {
          setState(event.state);
          setRequirements(requirementsText(event.state.requirements || []));
        }
        if (event.type === 'error') terminalError = event.error || 'Python 환경 적용에 실패했습니다.';
      };

      while (true) {
        const { value, done } = await reader.read();
        pending += decoder.decode(value, { stream: !done });
        const lines = pending.split('\n');
        pending = lines.pop() || '';
        for (const line of lines) {
          if (line.trim()) handleEvent(JSON.parse(line));
        }
        if (done) break;
      }
      if (pending.trim()) handleEvent(JSON.parse(pending));
      if (terminalError) throw new Error(terminalError);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      try {
        const response = await fetch('/api/settings/python-runtime', { cache: 'no-store' });
        const latest = await response.json();
        if (response.ok) {
          setState(latest);
          setRequirements(requirementsText(latest.requirements || []));
        }
      } catch {
        // 실패 후 상태 재조회는 보조 작업입니다.
      }
    } finally {
      (window as any).__pythonEnvironmentInstalling = false;
      await stopDisplaySleepPrevention();
      setInstalling(false);
    }
  };

  const progress = progressTotal > 0 ? Math.round((progressCurrent / progressTotal) * 100) : 0;

  return (
    <div className="space-y-6">
      <div className="card p-6 space-y-5">
        <div>
          <h3 className="text-sm font-semibold text-gray-800">Python 패키지</h3>
          <p className="mt-1 text-xs text-gray-500">앱 동작에 필요한 기본 패키지는 앱에 포함됩니다. 수업 코드에 필요한 패키지만 추가하세요.</p>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-gray-500"><Loader2 size={14} className="animate-spin" />환경 정보를 불러오는 중...</div>
        ) : (
          <>
            <div className={`rounded-md border px-3 py-2 text-xs ${state?.ready ? 'border-green-200 bg-green-50 text-green-700' : 'border-amber-200 bg-amber-50 text-amber-700'}`}>
              <div className="flex items-center gap-2 font-medium">
                {state?.ready ? <CheckCircle size={14} /> : <AlertTriangle size={14} />}
                {state?.ready ? `Python 환경 준비 완료 · 기본 ${state.baseRequirements.length}개 · 추가 ${state.requirements.length}개` : 'Python 환경을 아직 준비하지 않았습니다.'}
              </div>
              {state?.interrupted && <p className="mt-1">이전 설치가 완료되지 않았습니다. 현재 목록은 성공적으로 적용된 항목만 보여줍니다.</p>}
            </div>

            <div className="space-y-2">
              <span className="label">기본 패키지</span>
              <div className="flex flex-wrap gap-2">
                {(state?.baseRequirements || []).map(requirement => (
                  <div key={requirement} className="flex items-center gap-1.5 rounded-md border border-gray-200 bg-gray-50 px-2.5 py-1.5 font-mono text-xs text-gray-700">
                    <span>{requirement}</span>
                    <span className="font-sans text-[11px] font-medium text-blue-600">(기본 설치)</span>
                  </div>
                ))}
              </div>
              <p className="text-xs text-gray-400">기본 패키지는 앱에서 사용하므로 수정하거나 삭제할 수 없습니다.</p>
            </div>

            <label className="block">
              <span className="label">추가 패키지</span>
              <textarea
                className="input min-h-56 resize-y font-mono text-xs leading-5"
                value={requirements}
                onChange={(event) => { setRequirements(event.target.value); setSaved(false); setError(''); }}
                placeholder={'numpy\nscikit-learn\nmatplotlib'}
                spellCheck={false}
              />
            </label>

            <div className="flex items-center gap-3">
              <button className="btn-primary" onClick={applyRequirements} disabled={installing}>
                <Save size={14} />저장 및 적용
              </button>
              {saved && <span className="flex items-center gap-1 text-sm text-green-600"><CheckCircle size={14} />적용됨</span>}
            </div>
          </>
        )}

        {error && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs whitespace-pre-wrap text-red-700">{error}</div>}
        {state?.runtimeDir && <p className="text-xs text-gray-400">저장 위치: <code>{state.runtimeDir}</code></p>}
      </div>

      {installing && (
        <AiProgressOverlay
          title="Python 환경 적용 중"
          message="패키지를 순차적으로 설치하고 있습니다."
          detail={progressMessage}
          progress={progress}
          indeterminate={progressTotal === 0}
          icon={<Terminal size={18} className="text-blue-600" />}
        />
      )}
    </div>
  );
}
