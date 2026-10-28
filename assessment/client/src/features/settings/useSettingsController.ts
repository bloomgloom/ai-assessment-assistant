import { SetStateAction, useEffect, useState } from 'react';
import { settingsApi } from '../../lib/api';
import { saveBlob } from '../../lib/desktopFiles';
import { ANTHROPIC_OUTPUT_TASKS, DEFAULT_MODELS, DEFAULT_TEMPERATURES, DEFAULT_URLS, supportsTemperature } from './constants';
import { AiTemperatures, AnthropicEffort, AnthropicOutputOptions, AnthropicOutputTask, GeminiThinkingLevel, OpenAIReasoningEffort, SettingsState } from './types';

function providerTemperatureMax(provider: string) {
  return provider === 'anthropic' ? 1 : 2;
}

function defaultTemperatures(provider: string): AiTemperatures {
  return provider === 'anthropic' ? DEFAULT_TEMPERATURES.anthropic : DEFAULT_TEMPERATURES.default;
}

function clampTemperature(provider: string, value: unknown, fallback: number) {
  const max = providerTemperatureMax(provider);
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(max, numeric));
}

function normalizeTemperatures(provider: string, value?: Partial<AiTemperatures>): AiTemperatures {
  const defaults = defaultTemperatures(provider);
  return {
    domainManagement: clampTemperature(provider, value?.domainManagement, defaults.domainManagement),
    recordsScoring: clampTemperature(provider, value?.recordsScoring, defaults.recordsScoring),
    recordsComments: clampTemperature(provider, value?.recordsComments, defaults.recordsComments),
  };
}

function normalizeAnthropicEffort(value: unknown): AnthropicEffort {
  return ['low', 'medium', 'high', 'xhigh', 'max'].includes(String(value))
    ? String(value) as AnthropicEffort
    : 'high';
}

function normalizeGeminiThinkingLevel(value: unknown): GeminiThinkingLevel {
  return ['low', 'medium', 'high'].includes(String(value))
    ? String(value) as GeminiThinkingLevel
    : 'medium';
}

function normalizeOpenAIReasoningEffort(value: unknown): OpenAIReasoningEffort {
  return ['low', 'medium', 'high'].includes(String(value))
    ? String(value) as OpenAIReasoningEffort
    : 'medium';
}

function normalizeAnthropicMaxTokens(value: unknown): number | '' {
  if (value === '') return '';
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 8192;
  return Math.floor(numeric);
}

function defaultAnthropicOutputOptions(): AnthropicOutputOptions {
  return Object.fromEntries(ANTHROPIC_OUTPUT_TASKS.map((task) => [task.key, {
    model: '',
    effort: '',
    maxTokens: '',
    thinkingLevel: '',
    reasoningEffort: '',
  }])) as AnthropicOutputOptions;
}

function normalizeAnthropicOutputOptions(value: unknown): AnthropicOutputOptions {
  const source = value && typeof value === 'object'
    ? value as Partial<Record<AnthropicOutputTask, Partial<AnthropicOutputOptions[AnthropicOutputTask]>>>
    : {};
  return Object.fromEntries(ANTHROPIC_OUTPUT_TASKS.map((task) => {
    const item = source[task.key] || {};
    return [task.key, {
      model: String(item.model || ''),
      effort: item.effort ? normalizeAnthropicEffort(item.effort) : '',
      maxTokens: item.maxTokens === undefined || item.maxTokens === null || item.maxTokens === '' ? '' : normalizeAnthropicMaxTokens(item.maxTokens),
      thinkingLevel: item.thinkingLevel ? normalizeGeminiThinkingLevel(item.thinkingLevel) : '',
      reasoningEffort: item.reasoningEffort ? normalizeOpenAIReasoningEffort(item.reasoningEffort) : '',
    }];
  })) as AnthropicOutputOptions;
}

function snapshotProviderSettings(s: SettingsState) {
  return {
    model: s.model,
    baseUrl: s.baseUrl,
    maxConcurrency: s.maxConcurrency,
    temperatureEnabled: s.temperatureEnabled,
    temperatures: normalizeTemperatures(s.provider, s.temperatures),
    anthropicEffort: normalizeAnthropicEffort(s.anthropicEffort),
    anthropicMaxTokens: normalizeAnthropicMaxTokens(s.anthropicMaxTokens),
    outputThinkingLevel: normalizeGeminiThinkingLevel(s.outputThinkingLevel),
    outputReasoningEffort: normalizeOpenAIReasoningEffort(s.outputReasoningEffort),
    anthropicOutputOptions: normalizeAnthropicOutputOptions(s.anthropicOutputOptions),
  };
}

export function useSettingsController() {
  const [settings, setSettings] = useState<SettingsState>({
    provider: 'anthropic',
    apiKey: '',
    apiKeys: {},
    model: '',
    baseUrl: '',
    maxConcurrency: 5,
    temperatureEnabled: false,
    temperatures: defaultTemperatures('anthropic'),
    anthropicEffort: 'high',
    anthropicMaxTokens: 8192,
    outputThinkingLevel: 'medium',
    outputReasoningEffort: 'medium',
    anthropicOutputOptions: defaultAnthropicOutputOptions(),
    providerSettings: {},
    loggingEnabled: true,
    artifactStripIntroBlocks: true,
    artifactStripIntroBlocksDeprecated: false,
    pdfRedactionTopCm: 0,
    aiEnabled: false,
    assignmentTeacherPasswordSet: false,
    assignmentUploadApprovalMb: 50,
  });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [saved, setSaved] = useState(false);
  const [testedSignature, setTestedSignature] = useState('');
  const [resetting, setResetting] = useState(false);
  const [resetConfirm, setResetConfirm] = useState(false);
  const [backingUp, setBackingUp] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [inputOptionsSaving, setInputOptionsSaving] = useState(false);

  const [compatibleModels, setCompatibleModels] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelFetchError, setModelFetchError] = useState<string | null>(null);

  useEffect(() => {
    settingsApi.get().then((r) => {
      const data = r.data as SettingsState;
      const provider = data.provider || 'anthropic';
      setSettings({
        ...data,
        providerSettings: data.providerSettings || {},
        temperatureEnabled: data.temperatureEnabled === true,
        temperatures: normalizeTemperatures(provider, data.temperatures),
        anthropicEffort: normalizeAnthropicEffort(data.anthropicEffort),
        anthropicMaxTokens: normalizeAnthropicMaxTokens(data.anthropicMaxTokens),
        outputThinkingLevel: normalizeGeminiThinkingLevel(data.outputThinkingLevel),
        outputReasoningEffort: normalizeOpenAIReasoningEffort(data.outputReasoningEffort),
        anthropicOutputOptions: normalizeAnthropicOutputOptions(data.anthropicOutputOptions),
        artifactStripIntroBlocks: data.artifactStripIntroBlocks !== false,
        artifactStripIntroBlocksDeprecated: data.artifactStripIntroBlocksDeprecated === true,
        pdfRedactionTopCm: Math.max(0, Math.min(30, Number(data.pdfRedactionTopCm) || 0)),
        aiEnabled: data.aiEnabled === true,
        assignmentTeacherPasswordSet: data.assignmentTeacherPasswordSet === true,
        assignmentUploadApprovalMb: Math.max(1, Number(data.assignmentUploadApprovalMb) || 50),
      });
    });
  }, []);

  const fetchModelsForProvider = async (provider: string, baseUrl: string, apiKey: string, currentModel: string) => {
    setFetchingModels(true);
    setModelFetchError(null);
    try {
      const r = await settingsApi.getProviderModels(provider, baseUrl, apiKey);
      const models: string[] = r.data.models || [];
      setCompatibleModels(models);
      if (models.length > 0 && (!currentModel || !models.includes(currentModel))) {
        setSettings((s) => ({
          ...s,
          model: models[0],
          providerSettings: {
            ...s.providerSettings,
            [s.provider]: {
              ...snapshotProviderSettings(s),
              model: models[0],
            },
          },
        }));
      }
    } catch (e: unknown) {
      setCompatibleModels([]);
      const msg =
        e && typeof e === 'object' && 'response' in e
          ? ((e as { response?: { data?: { error?: string } } }).response?.data?.error ?? String(e))
          : String(e);
      setModelFetchError(msg);
    } finally {
      setFetchingModels(false);
    }
  };

  const handleProviderChange = (provider: string) => {
    setTestResult(null);
    setTestedSignature('');
    let nextBaseUrl = '';
    let nextApiKey = '';
    let nextModel = '';
    setSettings((s) => ({
      ...s,
      provider,
      apiKey: s.apiKeys?.[provider] || '',
      providerSettings: {
        ...s.providerSettings,
        [s.provider]: snapshotProviderSettings(s),
      },
      model: (nextModel = s.providerSettings?.[provider]?.model ?? DEFAULT_MODELS[provider] ?? ''),
      baseUrl: (nextBaseUrl = s.providerSettings?.[provider]?.baseUrl ?? DEFAULT_URLS[provider] ?? ''),
      maxConcurrency: s.providerSettings?.[provider]?.maxConcurrency ?? (provider === 'openai-compatible' ? 1 : 5),
      temperatureEnabled: s.providerSettings?.[provider]?.temperatureEnabled === true,
      temperatures: normalizeTemperatures(provider, s.providerSettings?.[provider]?.temperatures),
      anthropicEffort: normalizeAnthropicEffort(s.providerSettings?.[provider]?.anthropicEffort),
      anthropicMaxTokens: normalizeAnthropicMaxTokens(s.providerSettings?.[provider]?.anthropicMaxTokens),
      outputThinkingLevel: normalizeGeminiThinkingLevel(s.providerSettings?.[provider]?.outputThinkingLevel),
      outputReasoningEffort: normalizeOpenAIReasoningEffort(s.providerSettings?.[provider]?.outputReasoningEffort),
      anthropicOutputOptions: normalizeAnthropicOutputOptions(s.providerSettings?.[provider]?.anthropicOutputOptions),
    }));
    nextApiKey = settings.apiKeys?.[provider] || '';
    setCompatibleModels([]);
    setModelFetchError(null);
    void fetchModelsForProvider(provider, nextBaseUrl, nextApiKey, nextModel);
  };

  const withCurrentProviderSettings = (value: SettingsState): SettingsState => ({
    ...value,
    providerSettings: {
      ...value.providerSettings,
      [value.provider]: snapshotProviderSettings(value),
    },
  });

  const getConnectionSignature = (value: SettingsState) => JSON.stringify({
    provider: value.provider,
    apiKey: value.apiKeys?.[value.provider] || value.apiKey || '',
    model: value.model,
    baseUrl: value.baseUrl,
    maxConcurrency: value.maxConcurrency,
    temperatureEnabled: value.temperatureEnabled,
    temperatures: normalizeTemperatures(value.provider, value.temperatures),
    anthropicEffort: normalizeAnthropicEffort(value.anthropicEffort),
    anthropicMaxTokens: normalizeAnthropicMaxTokens(value.anthropicMaxTokens),
    outputThinkingLevel: normalizeGeminiThinkingLevel(value.outputThinkingLevel),
    outputReasoningEffort: normalizeOpenAIReasoningEffort(value.outputReasoningEffort),
    anthropicOutputOptions: normalizeAnthropicOutputOptions(value.anthropicOutputOptions),
    providerSettings: value.providerSettings?.[value.provider],
  });

  const currentConnectionSignature = getConnectionSignature(withCurrentProviderSettings(settings));
  const canSave = !settings.aiEnabled || testedSignature === currentConnectionSignature;

  const updateSettings = (updater: SetStateAction<SettingsState>) => {
    setTestResult(null);
    setTestedSignature('');
    setSettings(updater);
  };

  const handleFetchCompatibleModels = async () => {
    const apiKey = settings.apiKeys?.[settings.provider] || settings.apiKey || '';
    await fetchModelsForProvider(settings.provider, settings.baseUrl, apiKey, settings.model);
  };

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    try {
      const payload = withCurrentProviderSettings(settings);
      const invalidAnthropicMaxTokens = ['anthropic', 'gemini', 'openai'].includes(payload.provider)
        && payload.anthropicMaxTokens === '';
      if (invalidAnthropicMaxTokens) {
        alert('Claude max token을 입력해주세요.');
        return;
      }
      if (payload.aiEnabled && testedSignature !== getConnectionSignature(payload)) {
        alert('AI 기능 사용 상태에서는 연결 테스트 성공 후 저장할 수 있습니다.');
        return;
      }
      const r = await settingsApi.update(payload as unknown as Record<string, unknown>);
      const storage = r.data?.storage ?? settings.storage;
      setSettings((s) => ({ ...withCurrentProviderSettings(s), storage }));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  const handleInputOptionChange = async (
    key: 'loggingEnabled' | 'artifactStripIntroBlocks' | 'artifactStripIntroBlocksDeprecated' | 'aiEnabled' | 'pdfRedactionTopCm',
    value: boolean | number,
  ) => {
    const previousValue = settings[key];
    setTestResult(null);
    setTestedSignature('');
    setSettings((s) => ({ ...s, [key]: value }));
    setInputOptionsSaving(true);
    try {
      if (key === 'aiEnabled') return;
      await settingsApi.update({ [key]: value });
    } catch (e: unknown) {
      setSettings((s) => ({ ...s, [key]: previousValue }));
      const msg =
        e && typeof e === 'object' && 'response' in e
          ? ((e as { response?: { data?: { error?: string } } }).response?.data?.error ?? String(e))
          : String(e);
      alert(`설정 저장 중 오류: ${msg}`);
    } finally {
      setInputOptionsSaving(false);
    }
  };

  const handleTemperatureChange = (key: keyof AiTemperatures, value: number) => {
    setTestResult(null);
    setTestedSignature('');
    setSettings((s) => {
      const temperatures = normalizeTemperatures(s.provider, {
        ...s.temperatures,
        [key]: value,
      });
      return {
        ...s,
        temperatures,
        providerSettings: {
          ...s.providerSettings,
          [s.provider]: {
              ...snapshotProviderSettings(s),
              temperatures,
          },
        },
      };
    });
  };

  const handleTemperatureEnabledChange = (value: boolean) => {
    setTestResult(null);
    setTestedSignature('');
    setSettings((s) => ({
      ...s,
      temperatureEnabled: value,
      providerSettings: {
        ...s.providerSettings,
        [s.provider]: {
          ...snapshotProviderSettings(s),
          temperatureEnabled: value,
        },
      },
    }));
  };

  const handleAnthropicEffortChange = (value: AnthropicEffort) => {
    setTestResult(null);
    setTestedSignature('');
    const effort = normalizeAnthropicEffort(value);
    setSettings((s) => ({
      ...s,
      anthropicEffort: effort,
      providerSettings: {
        ...s.providerSettings,
        [s.provider]: {
          ...snapshotProviderSettings(s),
          anthropicEffort: effort,
        },
      },
    }));
  };

  const handleAnthropicMaxTokensChange = (value: number | '') => {
    setTestResult(null);
    setTestedSignature('');
    setSettings((s) => ({
      ...s,
      anthropicMaxTokens: value,
      providerSettings: {
        ...s.providerSettings,
        [s.provider]: {
          ...snapshotProviderSettings(s),
          anthropicMaxTokens: value,
        },
      },
    }));
  };

  const handleOutputThinkingLevelChange = (value: GeminiThinkingLevel) => {
    setTestResult(null);
    setTestedSignature('');
    setSettings((s) => ({ ...s, outputThinkingLevel: normalizeGeminiThinkingLevel(value) }));
  };

  const handleOutputReasoningEffortChange = (value: OpenAIReasoningEffort) => {
    setTestResult(null);
    setTestedSignature('');
    setSettings((s) => ({ ...s, outputReasoningEffort: normalizeOpenAIReasoningEffort(value) }));
  };

  const handleAnthropicTaskModelChange = (key: AnthropicOutputTask, value: string) => {
    setTestResult(null);
    setTestedSignature('');
    setSettings((s) => ({
      ...s,
      anthropicOutputOptions: normalizeAnthropicOutputOptions({
        ...s.anthropicOutputOptions,
        [key]: { ...s.anthropicOutputOptions[key], model: value },
      }),
    }));
  };

  const handleAnthropicTaskEffortChange = (key: AnthropicOutputTask, value: AnthropicEffort | '') => {
    setTestResult(null);
    setTestedSignature('');
    setSettings((s) => {
      const anthropicOutputOptions = normalizeAnthropicOutputOptions({
        ...s.anthropicOutputOptions,
        [key]: { ...s.anthropicOutputOptions[key], effort: value ? normalizeAnthropicEffort(value) : '' },
      });
      return {
        ...s,
        anthropicOutputOptions,
        providerSettings: {
          ...s.providerSettings,
          [s.provider]: {
            ...snapshotProviderSettings(s),
            anthropicOutputOptions,
          },
        },
      };
    });
  };

  const handleAnthropicTaskMaxTokensChange = (key: AnthropicOutputTask, value: number | '') => {
    setTestResult(null);
    setTestedSignature('');
    setSettings((s) => {
      const anthropicOutputOptions = normalizeAnthropicOutputOptions({
        ...s.anthropicOutputOptions,
        [key]: { ...s.anthropicOutputOptions[key], maxTokens: value },
      });
      return {
        ...s,
        anthropicOutputOptions,
        providerSettings: {
          ...s.providerSettings,
          [s.provider]: {
            ...snapshotProviderSettings(s),
            anthropicOutputOptions,
          },
        },
      };
    });
  };

  const handleGeminiTaskThinkingLevelChange = (key: AnthropicOutputTask, value: GeminiThinkingLevel | '') => {
    setTestResult(null);
    setTestedSignature('');
    setSettings((s) => {
      const anthropicOutputOptions = normalizeAnthropicOutputOptions({
        ...s.anthropicOutputOptions,
        [key]: { ...s.anthropicOutputOptions[key], thinkingLevel: value ? normalizeGeminiThinkingLevel(value) : '' },
      });
      return {
        ...s,
        anthropicOutputOptions,
        providerSettings: {
          ...s.providerSettings,
          [s.provider]: {
            ...snapshotProviderSettings(s),
            anthropicOutputOptions,
          },
        },
      };
    });
  };

  const handleOpenAITaskReasoningEffortChange = (key: AnthropicOutputTask, value: OpenAIReasoningEffort | '') => {
    setTestResult(null);
    setTestedSignature('');
    setSettings((s) => {
      const anthropicOutputOptions = normalizeAnthropicOutputOptions({
        ...s.anthropicOutputOptions,
        [key]: { ...s.anthropicOutputOptions[key], reasoningEffort: value ? normalizeOpenAIReasoningEffort(value) : '' },
      });
      return {
        ...s,
        anthropicOutputOptions,
        providerSettings: {
          ...s.providerSettings,
          [s.provider]: {
            ...snapshotProviderSettings(s),
            anthropicOutputOptions,
          },
        },
      };
    });
  };

  const handleResetOutputOverrides = () => {
    setTestResult(null);
    setTestedSignature('');
    setSettings((s) => ({ ...s, anthropicOutputOptions: defaultAnthropicOutputOptions() }));
  };

  const handleTest = async () => {
    if (['anthropic', 'gemini', 'openai'].includes(settings.provider) && settings.anthropicMaxTokens === '') {
      setTestResult({ ok: false, message: 'Claude max token을 입력해주세요.' });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const payload = withCurrentProviderSettings({ ...settings, aiEnabled: true });
      const r = await settingsApi.test({ ...payload, anthropicOutputOptions: defaultAnthropicOutputOptions() } as unknown as Record<string, unknown>);
      setTestedSignature(getConnectionSignature(payload));
      setTestResult({ ok: true, message: r.data.response });
    } catch (e: unknown) {
      const msg =
        e && typeof e === 'object' && 'response' in e
          ? ((e as { response?: { data?: { error?: string } } }).response?.data?.error ?? String(e))
          : String(e);
      setTestResult({ ok: false, message: msg });
    } finally {
      setTesting(false);
    }
  };

  const handleReset = async () => {
    setResetting(true);
    try {
      await settingsApi.reset();
      setResetConfirm(false);
      alert('초기화가 완료되었습니다. 모든 데이터와 업로드 파일이 삭제되었습니다.');
    } catch (e: unknown) {
      const msg =
        e && typeof e === 'object' && 'response' in e
          ? ((e as { response?: { data?: { error?: string } } }).response?.data?.error ?? String(e))
          : String(e);
      alert(`초기화 중 오류: ${msg}`);
    } finally {
      setResetting(false);
    }
  };

  const handleBackup = async () => {
    setBackingUp(true);
    try {
      const r = await settingsApi.backup();
      const blob = new Blob([r.data], { type: 'application/zip' });
      const disposition = String(r.headers['content-disposition'] || '');
      const match = disposition.match(/filename="?([^"]+)"?/);
      const filename = match?.[1] || `assessment-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
      await saveBlob(filename, blob);
    } catch (e: unknown) {
      const msg =
        e && typeof e === 'object' && 'response' in e
          ? ((e as { response?: { data?: { error?: string } } }).response?.data?.error ?? String(e))
          : String(e);
      alert(`백업 중 오류: ${msg}`);
    } finally {
      setBackingUp(false);
    }
  };

  const handleRestore = async (file: File) => {
    const ok = window.confirm('현재 저장된 데이터가 선택한 백업 ZIP 내용으로 교체됩니다. 복원하시겠습니까?');
    if (!ok) return;

    setRestoring(true);
    try {
      const r = await settingsApi.restore(file);
      setSettings((s) => ({ ...s, storage: r.data?.storage ?? s.storage }));
      alert('복원이 완료되었습니다. 화면을 새로고침한 뒤 데이터를 확인하세요.');
      window.location.reload();
    } catch (e: unknown) {
      const msg =
        e && typeof e === 'object' && 'response' in e
          ? ((e as { response?: { data?: { error?: string } } }).response?.data?.error ?? String(e))
          : String(e);
      alert(`복원 중 오류: ${msg}`);
    } finally {
      setRestoring(false);
    }
  };

  const saveAssignmentTeacherPassword = async (password: string) => {
    const trimmed = password.trim();
    if (trimmed.length < 4) {
      alert('교사 비밀번호는 4자 이상으로 입력하세요.');
      return false;
    }
    await settingsApi.update({ assignmentTeacherPassword: trimmed });
    setSettings((s) => ({ ...s, assignmentTeacherPasswordSet: true }));
    return true;
  };

  const clearAssignmentTeacherPassword = async () => {
    if (!confirm('교사 확인 화면 비밀번호를 해제하시겠습니까?')) return false;
    await settingsApi.update({ clearAssignmentTeacherPassword: true });
    setSettings((s) => ({ ...s, assignmentTeacherPasswordSet: false }));
    return true;
  };

  const saveAssignmentUploadApprovalMb = async (value: number) => {
    const normalized = Math.max(1, Math.floor(Number(value) || 50));
    await settingsApi.update({ assignmentUploadApprovalMb: normalized });
    setSettings((s) => ({ ...s, assignmentUploadApprovalMb: normalized }));
    return true;
  };

  const isOllama = settings.provider === 'ollama';
  const isOpenAICompatible = settings.provider === 'openai-compatible';
  const needsKey = settings.provider !== 'ollama';
  const needsUrl = isOllama || isOpenAICompatible;



  return {
    settings,
    setSettings: updateSettings,
    saving,
    testing,
    testResult,
    saved,
    resetting,
    resetConfirm,
    setResetConfirm,
    backingUp,
    restoring,
    inputOptionsSaving,
    compatibleModels,
    fetchingModels,
    modelFetchError,
    canSave,
    handleProviderChange,
    handleFetchCompatibleModels,
    handleSave,
    handleInputOptionChange,
    handleTest,
    handleReset,
    handleBackup,
    handleRestore,
    saveAssignmentTeacherPassword,
    clearAssignmentTeacherPassword,
    saveAssignmentUploadApprovalMb,
    isOllama,
    isOpenAICompatible,
    needsKey,
    needsUrl,
    isAnthropic: settings.provider === 'anthropic',
    temperatureMax: providerTemperatureMax(settings.provider),
    temperatureSupported: supportsTemperature(settings.provider, settings.model),
    handleTemperatureChange,
    handleTemperatureEnabledChange,
    handleAnthropicEffortChange,
    handleAnthropicMaxTokensChange,
    handleOutputThinkingLevelChange,
    handleOutputReasoningEffortChange,
    handleAnthropicTaskModelChange,
    handleAnthropicTaskEffortChange,
    handleAnthropicTaskMaxTokensChange,
    handleGeminiTaskThinkingLevelChange,
    handleOpenAITaskReasoningEffortChange,
    handleResetOutputOverrides,
  };
}
