import { useEffect } from 'react';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { useAiBatchStore } from '../../stores/aiBatchStore';
import { useAiOverlayStore } from '../../stores/aiOverlayStore';
import { startDisplaySleepPrevention, stopDisplaySleepPrevention } from '../../lib/displaySleepPrevention';
import { AiProgressOverlay } from './AiProgressOverlay';

export function AiGlobalOverlay() {
  const overlay = useAiOverlayStore();
  const batchJob = useAiBatchStore(state => state.currentJob);
  const pendingClaudeRequest = useAiBatchStore(state => state.claudeBatchJobs.find(job =>
    job.mode === 'claude-batch' && job.status === 'running' && !job.providerBatchIds?.length
  ));
  const stopBatch = useAiBatchStore(state => state.stopBatch);
  const clearFinishedBatch = useAiBatchStore(state => state.clearFinished);

  useEffect(() => {
    (window as any).__aiBatchRequestPending = Boolean(pendingClaudeRequest);
    if (pendingClaudeRequest) void startDisplaySleepPrevention();
    return () => {
      (window as any).__aiBatchRequestPending = false;
      if (pendingClaudeRequest) void stopDisplaySleepPrevention();
    };
  }, [pendingClaudeRequest]);

  const batchRunning = batchJob?.status === 'running' || batchJob?.status === 'stopping';
  const batchFinished = batchJob && !batchRunning;

  if (overlay.active) {
    return (
      <AiProgressOverlay
        title={overlay.title}
        message={overlay.message}
        progress={overlay.progress}
        indeterminate={overlay.progress < 0}
        stopping={overlay.stopping}
        onStop={overlay.stop}
        tone="blue"
      />
    );
  }

  if (pendingClaudeRequest) {
    const requestLabel = pendingClaudeRequest.domains
      .map(domain => domain === '__ACTIVITY__' ? '활동 기록' : domain === '__ACTIVITY_SEMESTER__' ? '활동 종합' : domain === '__SUBJECT_COMPREHENSIVE__' ? '세특' : domain)
      .join(', ');
    return (
      <AiProgressOverlay
        title={<span className="flex items-center gap-2">Claude 배치 요청 준비 중{pendingClaudeRequest.total > 0 && <span className="text-sm font-medium tabular-nums text-gray-500">({pendingClaudeRequest.completed}/{pendingClaudeRequest.total})</span>}</span>}
        message={requestLabel}
        detail={pendingClaudeRequest.classLabel}
        progress={pendingClaudeRequest.total > 0 ? (pendingClaudeRequest.completed / pendingClaudeRequest.total) * 100 : undefined}
        indeterminate={pendingClaudeRequest.total <= 0}
        running={false}
        tone="blue"
        backdrop="strong"
      />
    );
  }

  if (!batchRunning && !batchFinished) return null;

  const job = batchJob!;
  const failed = job.status === 'error' || job.errorCount > 0;
  const completed = job.status === 'completed';
  const percent = (job.completed / Math.max(job.total, 1)) * 100;

  return (
    <AiProgressOverlay
      title={job.classLabel}
      message={job.message}
      detail={`${job.completed}/${job.total}`}
      progress={percent}
      running={batchRunning || failed}
      stopping={job.status === 'stopping'}
      onStop={batchRunning ? stopBatch : clearFinishedBatch}
      stopLabel={batchRunning ? '중단' : '닫기'}
      tone={failed ? 'red' : completed ? 'green' : 'blue'}
      backdrop={batchRunning ? 'strong' : 'soft'}
      allowBackgroundScroll={batchRunning}
      icon={batchRunning
        ? <Loader2 size={18} className="animate-spin text-blue-600" />
        : failed
          ? <AlertCircle size={18} className="text-red-500" />
          : <CheckCircle2 size={18} className="text-green-500" />
      }
    />
  );
}
