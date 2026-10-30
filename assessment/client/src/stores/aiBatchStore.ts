import { create } from 'zustand';
import { activityApi, aiApi, claudeBatchApi } from '../lib/api';
import { startDisplaySleepPrevention, stopDisplaySleepPrevention } from '../lib/displaySleepPrevention';

export type BatchContentType = 'scoring' | 'comments' | 'combined' | 'spellcheck' | 'activity';
type GenerationBatchContentType = Exclude<BatchContentType, 'spellcheck' | 'activity'>;
export type BatchStatus = 'running' | 'stopping' | 'completed' | 'error' | 'stopped';

export interface GeneratedContentUpdate {
  classId?: number;
  studentId: number;
  contentType: 'scoring' | 'comments' | 'spellcheck' | 'activity';
  domain: string;
  content?: string;
  error?: string;
  llmResult?: string;
}

export interface BatchJob {
  id: string;
  classId: number;
  classLabel: string;
  domains: string[];
  contentType: BatchContentType;
  studentIds: number[];
  completed: number;
  total: number;
  errorCount: number;
  message: string;
  status: BatchStatus;
  startedAt: number;
  mode?: 'stream' | 'claude-batch';
  providerBatchIds?: string[];
  lockedCells?: Array<{ contentType: BatchContentType; domain: string; studentIds: number[] }>;
}

interface StartBatchArgs {
  classId: number;
  classLabel: string;
  domains: string[];
  contentType: GenerationBatchContentType;
  studentIds: number[];
}

interface StartSpellcheckBatchArgs {
  classId: number;
  classLabel: string;
  items: Array<{ studentId: number; text: string }>;
}

export interface ActivityGenerationRequest {
  mode: 'date' | 'semester';
  targets: Array<{ studentId: number; activityDateId?: number }>;
}

interface StartActivityBatchArgs {
  classId: number;
  classLabel: string;
  requests: ActivityGenerationRequest[];
}

interface AiBatchState {
  currentJob: BatchJob | null;
  claudeBatchJobs: BatchJob[];
  updates: GeneratedContentUpdate[];
  startBatch: (args: StartBatchArgs) => Promise<boolean>;
  loadClaudeBatchJobs: (classId: number) => Promise<void>;
  startClaudeBatch: (args: StartBatchArgs) => Promise<boolean>;
  startClaudeSpellcheckBatch: (args: StartSpellcheckBatchArgs) => Promise<boolean>;
  startActivityBatch: (args: StartActivityBatchArgs) => Promise<boolean>;
  startActivityClaudeBatch: (args: StartActivityBatchArgs) => Promise<boolean>;
  checkClaudeBatchResults: (jobId: string) => Promise<boolean>;
  stopBatch: () => void;
  clearFinished: () => void;
  isCellLocked: (classId: number, studentId: number, contentType: BatchContentType, domain: string) => boolean;
  hasLockedCells: (classId: number, studentIds: number[], contentType: BatchContentType, domains: string[]) => boolean;
}

let activeController: AbortController | null = null;
let clearTimer: number | null = null;
let unloadListenerAttached = false;

function displayDomainName(domain: string) {
  if (domain === '__SUBJECT_COMPREHENSIVE__') return '세특';
  if (domain === '__ACTIVITY_SEMESTER__') return '활동 종합';
  return domain;
}

function activityLockedCells(requests: ActivityGenerationRequest[]): BatchJob['lockedCells'] {
  const cells = new Map<string, number[]>();
  for (const request of requests) {
    for (const target of request.targets) {
      const domain = request.mode === 'semester' ? '__ACTIVITY_SEMESTER__' : String(target.activityDateId || '');
      if (!domain) continue;
      const ids = cells.get(domain) || [];
      if (!ids.includes(target.studentId)) ids.push(target.studentId);
      cells.set(domain, ids);
    }
  }
  return [...cells].map(([domain, studentIds]) => ({ contentType: 'activity', domain, studentIds }));
}

function newJobId() {
  return `batch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isGeneratedContentUpdate(value: unknown): value is GeneratedContentUpdate {
  const event = value as Partial<GeneratedContentUpdate>;
  return Boolean(event.studentId && event.contentType && event.domain && (event.content || event.error || event.llmResult));
}

function contentTypesOverlap(a: BatchContentType, b: BatchContentType) {
  return a === b || a === 'combined' || b === 'combined';
}

function jobLocksCell(job: BatchJob | null | undefined, classId: number, studentId: number, contentType: BatchContentType, domain: string) {
  if (!job) return false;
  if (job.classId !== classId) return false;
  if (job.status !== 'running' && job.status !== 'stopping') return false;
  return (contentTypesOverlap(job.contentType, contentType) && job.domains.includes(domain) && job.studentIds.includes(studentId))
    || !!job.lockedCells?.some((cell) =>
      contentTypesOverlap(cell.contentType, contentType) &&
      cell.domain === domain &&
      cell.studentIds.includes(studentId)
    );
}

function isPendingClaudeBatchRequest(job: BatchJob) {
  return job.mode === 'claude-batch' && !job.providerBatchIds?.length;
}

async function readGenerationEvents(response: Response, onEvent: (event: any) => void) {
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `HTTP ${response.status}`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('진행 스트림을 열 수 없습니다.');
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try { onEvent(JSON.parse(line.slice(6))); }
      catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    }
  }
}

export const useAiBatchStore = create<AiBatchState>((set, get) => ({
  currentJob: null,
  claudeBatchJobs: [],
  updates: [],

  loadClaudeBatchJobs: async (classId) => {
    try {
      const res = await claudeBatchApi.list(classId);
      const jobs = (Array.isArray(res.data.jobs) ? res.data.jobs : []) as BatchJob[];
      set((state) => {
        const pendingJobs = state.claudeBatchJobs.filter((job) => job.classId === classId && isPendingClaudeBatchRequest(job));
        return {
          claudeBatchJobs: [
            ...state.claudeBatchJobs.filter((job) => job.classId !== classId),
            ...pendingJobs,
            ...jobs,
          ],
        };
      });
    } catch {
      // 목록 복원 실패는 화면 사용을 막지 않습니다.
    }
  },

  startBatch: async ({ classId, classLabel, domains, contentType, studentIds }) => {
    const existing = get().currentJob;
    if (existing && (existing.status === 'running' || existing.status === 'stopping')) return false;

    if (clearTimer) {
      window.clearTimeout(clearTimer);
      clearTimer = null;
    }

    const jobId = newJobId();
    const jobController = new AbortController();
    activeController = jobController;
    set({
      updates: [],
      currentJob: {
        id: jobId,
        classId,
        classLabel,
        domains,
        contentType,
        studentIds,
        completed: 0,
        total: domains.length * studentIds.length,
        errorCount: 0,
        message: `[${displayDomainName(domains[0])}] 준비 중...`,
        status: 'running',
        startedAt: Date.now(),
      },
    });

    let aggregateCompleted = 0;
    let aggregateErrors = 0;

    try {
      await startDisplaySleepPrevention();
      for (const domain of domains) {
        if (jobController.signal.aborted) break;
        const domainLabel = displayDomainName(domain);
        const domainStartCompleted = aggregateCompleted;
        set((state) => state.currentJob?.id === jobId ? {
          currentJob: {
            ...state.currentJob,
            completed: aggregateCompleted,
            message: `[${domainLabel}] 준비 중...`,
          },
        } : {});

        try {
          const response = await fetch('/api/ai/generate-batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: jobController.signal,
            body: JSON.stringify({
              classId,
              domain,
              contentType,
              studentIds,
            }),
          });

          if (!response.ok) throw new Error(`HTTP ${response.status}`);

          const reader = response.body?.getReader();
          if (!reader) throw new Error('진행 스트림을 열 수 없습니다.');

          const decoder = new TextDecoder();
          let buffer = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;

              try {
                const event = JSON.parse(line.slice(6));

                if (event.type === 'progress' || event.type === 'error') {
                  aggregateCompleted = domainStartCompleted + Number(event.completed || 0);
                  if (event.type === 'error') aggregateErrors++;
                  const update = isGeneratedContentUpdate({
                    studentId: event.studentId,
                    contentType: event.contentType || contentType,
                    domain: event.domain || domain,
                    content: event.content,
                    error: event.error,
                    llmResult: event.llmResult,
                  })
                    ? {
                        studentId: event.studentId,
                        contentType: event.contentType || contentType,
                        domain: event.domain || domain,
                        content: event.content,
                        error: event.error,
                        llmResult: event.llmResult,
                      }
                    : null;

                  set((state) => {
                    if (state.currentJob?.id !== jobId) return {};
                    return {
                      updates: update ? [...state.updates, update] : state.updates,
                      currentJob: {
                        ...state.currentJob,
                        completed: aggregateCompleted,
                        errorCount: aggregateErrors,
                        message: event.type === 'error'
                          ? `[${domainLabel}] ${event.name || '학생'} 오류: ${event.error || '생성 실패'}`
                          : `[${domainLabel}] ${event.name} 완료`,
                      },
                    };
                  });
                } else if (event.type === 'done') {
                  aggregateCompleted = domainStartCompleted + Number(event.completed || studentIds.length);
                  set((state) => state.currentJob?.id === jobId ? {
                    currentJob: {
                      ...state.currentJob,
                      completed: aggregateCompleted,
                      errorCount: aggregateErrors,
                      message: aggregateErrors > 0
                        ? `[${domainLabel}] 완료, 오류 ${aggregateErrors}건`
                        : `[${domainLabel}] 완료`,
                    },
                  } : {});
                } else if (event.type === 'fatal') {
                  throw new Error(event.error || '일괄 생성 실패');
                }
              } catch (e) {
                if (e instanceof SyntaxError) continue;
                throw e;
              }
            }
          }
        } catch (e) {
          if ((e as Error)?.name === 'AbortError') break;
          throw e;
        }
      }

      const stopped = jobController.signal.aborted;
      set((state) => state.currentJob?.id === jobId ? {
        currentJob: {
          ...state.currentJob,
          status: stopped ? 'stopped' : 'completed',
          errorCount: aggregateErrors,
          message: stopped
            ? '중단되었습니다.'
            : aggregateErrors > 0
              ? `AI 생성이 완료되었습니다. 오류 ${aggregateErrors}건은 작성하지 않았습니다.`
              : 'AI 생성이 완료되었습니다.',
        },
      } : {});

      if (stopped || aggregateErrors === 0) {
        clearTimer = window.setTimeout(() => {
          if (get().currentJob?.id === jobId) get().clearFinished();
        }, stopped ? 300 : 1200);
      }

      return !stopped;
    } catch (e) {
      set((state) => state.currentJob?.id === jobId ? {
        currentJob: {
          ...state.currentJob,
          status: 'error',
          message: `오류: ${e instanceof Error ? e.message : String(e)}`,
        },
      } : {});
      return false;
    } finally {
      if (activeController === jobController) {
        activeController = null;
        await stopDisplaySleepPrevention();
      }
    }
  },

  startActivityBatch: async ({ classId, classLabel, requests }) => {
    const existing = get().currentJob;
    if (existing && (existing.status === 'running' || existing.status === 'stopping')) return false;
    const lockedCells = activityLockedCells(requests) || [];
    const studentIds = Array.from(new Set(lockedCells.flatMap(cell => cell.studentIds)));
    const domains = lockedCells.map(cell => cell.domain);
    if (!lockedCells.length) return false;
    if (clearTimer) {
      window.clearTimeout(clearTimer);
      clearTimer = null;
    }

    const jobId = newJobId();
    const jobController = new AbortController();
    activeController = jobController;
    set({
      updates: [],
      currentJob: {
        id: jobId, classId, classLabel, domains, contentType: 'activity', studentIds,
        completed: 0, total: requests.reduce((sum, request) => sum + request.targets.length, 0),
        errorCount: 0, message: '[활동 기록] 준비 중...', status: 'running', startedAt: Date.now(),
        mode: 'stream', lockedCells,
      },
    });

    let completed = 0;
    let errorCount = 0;
    try {
      await startDisplaySleepPrevention();
      for (const request of requests) {
        if (jobController.signal.aborted) break;
        const requestStart = completed;
        const label = request.mode === 'semester' ? '활동 종합' : '활동 기록';
        set(state => state.currentJob?.id === jobId ? { currentJob: { ...state.currentJob, message: `[${label}] 준비 중...` } } : {});
        const response = await fetch(`/api/activity/${classId}/generate`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: jobController.signal,
          body: JSON.stringify(request),
        });
        await readGenerationEvents(response, event => {
          if (event.type === 'fatal') throw new Error(event.error || '활동 기록 생성 실패');
          if (event.type === 'progress' || event.type === 'error') {
            completed = requestStart + Number(event.completed || 0);
            if (event.type === 'error') errorCount++;
            const update = isGeneratedContentUpdate({
              classId, studentId: event.studentId, contentType: 'activity', domain: event.domain,
              content: event.content, error: event.error, llmResult: event.llmResult,
            }) ? {
              classId, studentId: event.studentId, contentType: 'activity' as const, domain: String(event.domain),
              content: event.content, error: event.error, llmResult: event.llmResult,
            } : null;
            set(state => state.currentJob?.id === jobId ? {
              updates: update ? [...state.updates, update] : state.updates,
              currentJob: {
                ...state.currentJob, completed, errorCount,
                message: event.type === 'error'
                  ? `[${label}] ${event.name || '학생'} 오류: ${event.error || '생성 실패'}`
                  : `[${label}] ${event.name || '학생'} 완료`,
              },
            } : {});
          }
          if (event.type === 'done') completed = requestStart + Number(event.completed || request.targets.length);
        });
      }

      const stopped = jobController.signal.aborted;
      set(state => state.currentJob?.id === jobId ? { currentJob: {
        ...state.currentJob, status: stopped ? 'stopped' : 'completed', completed, errorCount,
        message: stopped ? '중단되었습니다.' : errorCount ? `AI 생성이 완료되었습니다. 오류 ${errorCount}건은 작성하지 않았습니다.` : 'AI 생성이 완료되었습니다.',
      } } : {});
      if (stopped || errorCount === 0) clearTimer = window.setTimeout(() => {
        if (get().currentJob?.id === jobId) get().clearFinished();
      }, stopped ? 300 : 1200);
      return !stopped;
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') {
        set(state => state.currentJob?.id === jobId ? { currentJob: { ...state.currentJob, status: 'stopped', message: '중단되었습니다.' } } : {});
        return false;
      }
      set(state => state.currentJob?.id === jobId ? { currentJob: {
        ...state.currentJob, status: 'error', message: `오류: ${error instanceof Error ? error.message : String(error)}`,
      } } : {});
      return false;
    } finally {
      if (activeController === jobController) {
        activeController = null;
        await stopDisplaySleepPrevention();
      }
    }
  },

  startActivityClaudeBatch: async ({ classId, classLabel, requests }) => {
    const allLocks = activityLockedCells(requests) || [];
    if (!allLocks.length || allLocks.some(cell => get().hasLockedCells(classId, cell.studentIds, 'activity', [cell.domain]))) return false;
    let submitted = 0;
    for (const request of requests) {
      const lockedCells = activityLockedCells([request]) || [];
      const studentIds = Array.from(new Set(request.targets.map(target => target.studentId)));
      const domain = request.mode === 'semester' ? '__ACTIVITY_SEMESTER__' : '__ACTIVITY__';
      const pendingJobId = newJobId();
      const pendingJob: BatchJob = {
        id: pendingJobId, classId, classLabel, domains: [domain], contentType: 'activity', studentIds,
        completed: 0, total: request.targets.length, errorCount: 0,
        message: `[${displayDomainName(domain)}] Claude 배치 요청 중...`, status: 'running', startedAt: Date.now(),
        mode: 'claude-batch', providerBatchIds: [], lockedCells,
      };
      set(state => ({ claudeBatchJobs: [...state.claudeBatchJobs, pendingJob] }));
      try {
        const response = await activityApi.startBatch(classId, request);
        const batchId = String(response.data.batchId || '');
        if (!batchId) {
          set(state => ({ claudeBatchJobs: state.claudeBatchJobs.filter(job => job.id !== pendingJobId) }));
          continue;
        }
        submitted++;
        set(state => ({ claudeBatchJobs: state.claudeBatchJobs.map(job => job.id === pendingJobId ? {
          ...pendingJob, id: batchId, providerBatchIds: [batchId], message: `[${displayDomainName(domain)}] Claude 배치 제출 완료`,
        } : job) }));
      } catch {
        set(state => ({ claudeBatchJobs: state.claudeBatchJobs.filter(job => job.id !== pendingJobId) }));
      }
    }
    return submitted > 0;
  },

  startClaudeBatch: async ({ classId, classLabel, domains, contentType, studentIds }) => {
    if (get().hasLockedCells(classId, studentIds, contentType, domains)) return false;
    if (clearTimer) {
      window.clearTimeout(clearTimer);
      clearTimer = null;
    }

    let submitted = 0;
    try {
      for (const domain of domains) {
        const pendingJobId = newJobId();
        const pendingJob: BatchJob = {
          id: pendingJobId,
          classId,
          classLabel,
          domains: [domain],
          contentType,
          studentIds,
          completed: 0,
          total: studentIds.length,
          errorCount: 0,
          message: `[${displayDomainName(domain)}] Claude 배치 요청 중...`,
          status: 'running',
          startedAt: Date.now(),
          mode: 'claude-batch',
          providerBatchIds: [],
          lockedCells: [{ contentType, domain, studentIds }],
        };
        set((state) => ({
          claudeBatchJobs: [...state.claudeBatchJobs, pendingJob],
        }));

        try {
          const res = await aiApi.generateClaudeBatch({ classId, domain, contentType, studentIds });
          const batchId = String(res.data.batchId || '');
          if (!batchId) {
            set((state) => ({
              claudeBatchJobs: state.claudeBatchJobs.filter((job) => job.id !== pendingJobId),
            }));
            continue;
          }
          const immediate = Array.isArray(res.data.immediateUpdates) ? res.data.immediateUpdates : [];
          const errors = immediate.filter((item: GeneratedContentUpdate) => item.error).length;
          const job: BatchJob = {
            ...pendingJob,
            completed: immediate.length,
            errorCount: errors,
            message: `[${displayDomainName(domain)}] Claude 배치 제출 완료`,
            providerBatchIds: [batchId],
          };
          submitted++;
          set((state) => ({
            // 배치 제출만으로 편집 내용을 바꾸지 않습니다. 즉시 처리된 결과도
            // checkClaudeBatchResults에서 나머지 배치 결과와 함께 반영합니다.
            claudeBatchJobs: state.claudeBatchJobs.map((item) => item.id === pendingJobId ? job : item),
          }));
        } catch (e) {
          set((state) => ({
            claudeBatchJobs: state.claudeBatchJobs.filter((job) => job.id !== pendingJobId),
          }));
          throw e;
        }
      }
      return submitted > 0;
    } catch (e) {
      return false;
    }
  },

  startClaudeSpellcheckBatch: async ({ classId, classLabel, items }) => {
    const domain = '__SUBJECT_COMPREHENSIVE__';
    const studentIds = items.map((item) => item.studentId);
    if (!items.length || get().hasLockedCells(classId, studentIds, 'spellcheck', [domain])) return false;

    const pendingJobId = newJobId();
    const pendingJob: BatchJob = {
      id: pendingJobId,
      classId,
      classLabel,
      domains: [domain],
      contentType: 'spellcheck',
      studentIds,
      completed: 0,
      total: items.length,
      errorCount: 0,
      message: '[세특] Claude 교정 배치 요청 중...',
      status: 'running',
      startedAt: Date.now(),
      mode: 'claude-batch',
      providerBatchIds: [],
      lockedCells: [{ contentType: 'spellcheck', domain, studentIds }],
    };
    set((state) => ({ claudeBatchJobs: [...state.claudeBatchJobs, pendingJob] }));

    try {
      const res = await aiApi.spellcheckClaudeBatch({ classId, items });
      const batchId = String(res.data.batchId || '');
      if (!batchId) {
        set((state) => ({
          claudeBatchJobs: state.claudeBatchJobs.filter((job) => job.id !== pendingJobId),
        }));
        return false;
      }
      set((state) => ({
        claudeBatchJobs: state.claudeBatchJobs.map((job) => job.id === pendingJobId ? {
          ...pendingJob,
          message: '[세특] Claude 교정 배치 제출 완료',
          providerBatchIds: [batchId],
        } : job),
      }));
      return true;
    } catch {
      set((state) => ({
        claudeBatchJobs: state.claudeBatchJobs.filter((job) => job.id !== pendingJobId),
      }));
      return false;
    }
  },

  checkClaudeBatchResults: async (jobId) => {
    const job = get().claudeBatchJobs.find((item) => item.id === jobId);
    if (!job || job.mode !== 'claude-batch' || !job.providerBatchIds?.length) return false;
    set((state) => ({
      claudeBatchJobs: state.claudeBatchJobs.map((item) => item.id === job.id
        ? { ...item, message: 'Claude 배치 결과 확인 중...' }
        : item
      ),
    }));
    try {
      const res = await claudeBatchApi.receive(job.providerBatchIds);
      const updates = ((Array.isArray(res.data.updates) ? res.data.updates : []) as GeneratedContentUpdate[])
        .map(update => ({ ...update, classId: job.classId }));
      const errors = updates.filter((item) => item.error).length;
      if (res.data.inProgress) {
        set((state) => ({
          updates: updates.length ? [...state.updates, ...updates] : state.updates,
          claudeBatchJobs: state.claudeBatchJobs.map((item) => item.id === job.id ? {
            ...item,
            completed: Math.max(item.completed, updates.length),
            errorCount: item.errorCount + errors,
            message: 'Claude 배치가 아직 진행 중입니다.',
          } : item),
        }));
        return false;
      }

      set((state) => ({
        updates: updates.length ? [...state.updates, ...updates] : state.updates,
        claudeBatchJobs: state.claudeBatchJobs.filter((item) => item.id !== job.id),
      }));
      return true;
    } catch (e) {
      set((state) => ({
        claudeBatchJobs: state.claudeBatchJobs.map((item) => item.id === job.id
          ? { ...item, message: `결과 확인 오류: ${e instanceof Error ? e.message : String(e)}` }
          : item
        ),
      }));
      throw e;
    }
  },

  stopBatch: () => {
    activeController?.abort();
    set((state) => state.currentJob ? {
      currentJob: {
        ...state.currentJob,
        status: 'stopping',
        message: '중단 중...',
      },
    } : {});
  },

  clearFinished: () => {
    const job = get().currentJob;
    if (!job || job.status === 'running' || job.status === 'stopping') return;
    set({ currentJob: null });
  },

  isCellLocked: (classId, studentId, contentType, domain) => {
    const job = get().currentJob;
    if (jobLocksCell(job, classId, studentId, contentType, domain)) return true;
    return get().claudeBatchJobs.some((item) => jobLocksCell(item, classId, studentId, contentType, domain));
  },

  hasLockedCells: (classId, studentIds, contentType, domains) => {
    return studentIds.some((studentId) =>
      domains.some((domain) => get().isCellLocked(classId, studentId, contentType, domain))
    );
  },
}));

if (typeof window !== 'undefined' && !unloadListenerAttached) {
  unloadListenerAttached = true;
  window.addEventListener('beforeunload', () => {
    activeController?.abort();
    void stopDisplaySleepPrevention();
  });
  window.addEventListener('pagehide', () => {
    activeController?.abort();
    void stopDisplaySleepPrevention();
  });
}
