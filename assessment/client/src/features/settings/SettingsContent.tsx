import { useState } from 'react';
import { Save, TestTube, CheckCircle, XCircle, Loader2, RefreshCw, Trash2, AlertTriangle, Eye, EyeOff, Download, Upload } from 'lucide-react';
import { ANTHROPIC_EFFORT_OPTIONS, ANTHROPIC_OUTPUT_TASKS, DEFAULT_MODELS, DEFAULT_URLS, GEMINI_THINKING_LEVEL_OPTIONS, OPENAI_REASONING_EFFORT_OPTIONS, PROVIDERS, TEMPERATURE_TASKS } from './constants';
import { useSettingsController } from './useSettingsController';
import { AnthropicEffort, GeminiThinkingLevel, OpenAIReasoningEffort, SettingsTab } from './types';
import { hasDesktopFileDialogs, openFiles } from '../../lib/desktopFiles';

interface SettingsContentProps extends ReturnType<typeof useSettingsController> {
  activeTab: SettingsTab;
}

export function SettingsContent({
  activeTab,
  settings,
  setSettings,
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
  isOllama,
  isOpenAICompatible,
  needsKey,
  needsUrl,
  isAnthropic,
  temperatureMax,
  temperatureSupported,
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
}: SettingsContentProps) {
  const [showApiKey, setShowApiKey] = useState(false);
  const [teacherPassword, setTeacherPassword] = useState('');
  const [teacherPasswordConfirm, setTeacherPasswordConfirm] = useState('');
  const [savingTeacherPassword, setSavingTeacherPassword] = useState(false);
  const aiDisabled = !settings.aiEnabled;
  const disabledPanelClass = aiDisabled ? 'opacity-45 grayscale select-none' : '';
  const temperatureControlsDisabled = aiDisabled || !settings.temperatureEnabled || !temperatureSupported;
  const outputOptionsAvailable = settings.provider === 'anthropic' || settings.provider === 'gemini' || settings.provider === 'openai';
  const outputOptionsDisabled = aiDisabled;
  const defaultModel = settings.model || DEFAULT_MODELS[settings.provider] || '미지정';

  return (
    <div className="flex-1 min-h-0 overflow-auto scrollbar-stable">
      <div className="min-w-[720px] max-w-5xl px-6 pt-6 pb-32">
      {activeTab === 'ai' && (
      <div className="space-y-6">
      <div className="card p-6 space-y-3">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            className="w-4 h-4 rounded"
            checked={settings.aiEnabled}
            disabled={inputOptionsSaving}
            onChange={(e) => handleInputOptionChange('aiEnabled', e.target.checked)}
          />
          <span className="text-sm font-semibold text-gray-800">AI 기능 사용</span>
        </label>
        <p className="text-xs text-gray-400 ml-6">
          끄면 평가 영역 관리와 채점 기록 관리의 AI 생성, 채점, 교정 기능이 비활성화됩니다.
        </p>
      </div>

      <div className={disabledPanelClass} aria-disabled={aiDisabled}>
      <div className="card p-6 space-y-5">
        <div>
          <h3 className="text-sm font-semibold text-gray-800">AI 입력 옵션</h3>
          <p className="text-xs text-gray-400 mt-1">체크하면 바로 적용됩니다.</p>
        </div>

        <div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="w-4 h-4 rounded"
              checked={settings.loggingEnabled}
              disabled={inputOptionsSaving || aiDisabled}
              onChange={(e) => handleInputOptionChange('loggingEnabled', e.target.checked)}
            />
            <span className="text-sm font-medium text-gray-700">LLM 요청/응답 로그 저장</span>
          </label>
          <p className="text-xs text-gray-400 mt-1 ml-6">
            켜면 실행 단위별 입력과 출력을 <code>.log</code> 폴더에 저장합니다. 학생 산출물 내용이 포함될 수 있습니다.
          </p>
        </div>

        <div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="w-4 h-4 rounded"
              checked={settings.artifactStripIntroBlocks}
              disabled={inputOptionsSaving || aiDisabled}
              onChange={(e) => handleInputOptionChange('artifactStripIntroBlocks', e.target.checked)}
            />
            <span className="text-sm font-medium text-gray-700">산출물 개인정보 가리기</span>
          </label>
          <p className="text-xs text-gray-400 mt-1 ml-6">
            켜면 코드 파일 맨 앞의 블록 주석이나 docstring을 AI 입력에서 제외하고, PDF 상단 가림 설정을 적용합니다.
          </p>
          <div className="mt-3 ml-6 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <label className="text-xs font-medium text-gray-600" htmlFor="pdf-redaction-top-cm">
                PDF 첫 페이지 상단 가림 높이
              </label>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  className="input h-8 w-20 text-right text-xs"
                  min={0}
                  max={30}
                  step={0.1}
                  value={settings.pdfRedactionTopCm}
                  disabled={inputOptionsSaving || aiDisabled || !settings.artifactStripIntroBlocks}
                  onChange={(e) => {
                    const nextValue = Math.max(0, Math.min(30, Number(e.target.value) || 0));
                    handleInputOptionChange('pdfRedactionTopCm', nextValue);
                  }}
                />
                <span className="text-xs text-gray-500">cm</span>
              </div>
            </div>
            <input
              id="pdf-redaction-top-cm"
              type="range"
              className="w-full accent-gray-800"
              min={0}
              max={30}
              step={0.1}
              value={settings.pdfRedactionTopCm}
              disabled={inputOptionsSaving || aiDisabled || !settings.artifactStripIntroBlocks}
              onChange={(e) => handleInputOptionChange('pdfRedactionTopCm', Number(e.target.value))}
            />
            <p className="text-xs text-gray-400">
              원본 PDF는 그대로 보관하고, AI 입력용 이미지 캐시를 만들 때 첫 페이지만 지정 높이만큼 위에서부터 지웁니다. 0이면 PDF 가림을 적용하지 않습니다.
            </p>
          </div>
        </div>

        <div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="w-4 h-4 rounded"
              checked={settings.artifactStripIntroBlocksDeprecated}
              disabled={inputOptionsSaving || aiDisabled}
              onChange={(e) => handleInputOptionChange('artifactStripIntroBlocksDeprecated', e.target.checked)}
            />
            <span className="text-sm font-medium text-gray-700">산출물 개인정보 가리기 (deprecated)</span>
          </label>
          <p className="text-xs text-gray-400 mt-1 ml-6">
            임시 옵션입니다. 켜면 HWPX 첫 표 행과 IPYNB 첫 마크다운 셀만 기존 방식으로 AI 입력에서 제외합니다.
          </p>
        </div>
      </div>
      </div>

      <div className="card p-6 space-y-5" aria-disabled={aiDisabled}>

        {/* Provider */}
        <div>
          <label className="label">LLM 공급자</label>
          <select
            className="select"
            value={settings.provider}
            disabled={aiDisabled}
            onChange={(e) => handleProviderChange(e.target.value)}
          >
            {PROVIDERS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </div>

        {/* API Key */}
        {needsKey && (
          <div>
            <label className="label">API 키</label>
            <div className="relative">
              <input
                type={showApiKey ? 'text' : 'password'}
                className="input font-mono text-xs pr-10"
                disabled={aiDisabled}
                placeholder={isOpenAICompatible ? 'API 키가 필요 없는 로컬 서버면 비워두세요' : 'API 키를 입력하세요'}
                value={settings.apiKeys?.[settings.provider] || ''}
                onChange={(e) => setSettings((s) => ({
                  ...s,
                  apiKey: e.target.value,
                  apiKeys: { ...s.apiKeys, [s.provider]: e.target.value }
                }))}
              />
              <button
                type="button"
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-700 rounded"
                onClick={() => setShowApiKey((visible) => !visible)}
                disabled={aiDisabled}
                title={showApiKey ? 'API 키 숨기기' : 'API 키 보기'}
                aria-label={showApiKey ? 'API 키 숨기기' : 'API 키 보기'}
              >
                {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>
        )}

        {/* Base URL */}
        {needsUrl && (
          <div>
            <label className="label">
              {isOpenAICompatible ? 'OpenAI 호환 서버 URL' : isOllama ? 'Ollama 서버 URL' : 'API Base URL'}
            </label>
            <input
              type="text"
              className="input font-mono text-xs"
              disabled={aiDisabled}
              placeholder={DEFAULT_URLS[settings.provider] || 'https://your-api-endpoint/v1'}
              value={settings.baseUrl}
              onChange={(e) => setSettings((s) => ({ ...s, baseUrl: e.target.value }))}
            />
            {isOpenAICompatible && (
              <p className="text-xs text-gray-400 mt-1">
                예: <code>http://localhost:8000/v1</code>, <code>http://localhost:1234/v1</code>
              </p>
            )}
          </div>
        )}

        {/* 모델 선택 */}
        {!outputOptionsAvailable && <div>
          <label className="label">모델</label>

          <div className="space-y-2">
            <div className="flex gap-2">
              {compatibleModels.length > 0 ? (
                <select
                  className="select flex-1"
                  disabled={aiDisabled}
                  value={settings.model}
                  onChange={(e) => setSettings((s) => ({ ...s, model: e.target.value }))}
                >
                  <option value="">모델을 선택하세요</option>
                  {compatibleModels.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  className="input flex-1"
                  disabled={aiDisabled}
                  placeholder={DEFAULT_MODELS[settings.provider] || '모델명 직접 입력'}
                  value={settings.model}
                  onChange={(e) => setSettings((s) => ({ ...s, model: e.target.value }))}
                />
              )}
              <button
                className="btn-secondary shrink-0"
                onClick={handleFetchCompatibleModels}
                disabled={fetchingModels || aiDisabled}
                title="현재 공급자에서 사용 가능한 모델 목록 가져오기"
              >
                {fetchingModels
                  ? <Loader2 size={14} className="animate-spin" />
                  : <RefreshCw size={14} />}
                {fetchingModels ? '조회 중...' : '모델 가져오기'}
              </button>
            </div>
            {modelFetchError && (
              <p className="text-xs text-red-600 flex items-center gap-1">
                <XCircle size={12} /> {modelFetchError}
              </p>
            )}
            {compatibleModels.length > 0 ? (
              <p className="text-xs text-green-600">
                {compatibleModels.length}개 모델 로드됨
              </p>
            ) : DEFAULT_MODELS[settings.provider] ? (
              <p className="text-xs text-gray-400">
                비워두면 기본값({DEFAULT_MODELS[settings.provider]})이 사용됩니다.
              </p>
            ) : null}
          </div>
        </div>}

        {/* 최대 동시 요청 수 */}
        <div>
          <label className="label">최대 동시 요청 수</label>
          <input
            type="number"
            className="input w-24"
            disabled={aiDisabled}
            min={1}
            max={20}
            value={settings.maxConcurrency}
            onChange={(e) =>
              setSettings((s) => ({ ...s, maxConcurrency: parseInt(e.target.value, 10) || 1 }))
            }
          />
          <p className="text-xs text-gray-400 mt-1">
            1이면 순차 처리, 2 이상이면 병렬 처리합니다. 로컬 LLM은 1~3 권장.
          </p>
        </div>

        {outputOptionsAvailable && (
          <div className="space-y-5">
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <label className="label mb-0">기본 설정</label>
                <button
                  className="btn-secondary shrink-0"
                  onClick={handleFetchCompatibleModels}
                  disabled={fetchingModels || aiDisabled}
                  title="현재 공급자에서 사용 가능한 모델 목록 가져오기"
                >
                  {fetchingModels ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                  {fetchingModels ? '조회 중...' : '모델 가져오기'}
                </button>
              </div>
              <div className="overflow-hidden rounded border border-gray-200">
                <table className="w-full table-fixed border-collapse text-sm">
                  <colgroup>
                    <col className="w-[18%]" />
                    <col className="w-[42%]" />
                    <col className="w-[20%]" />
                    <col className="w-[20%]" />
                  </colgroup>
                  <thead>
                    <tr className="border-b bg-gray-50 text-xs font-semibold text-gray-600">
                      <th className="px-3 py-2 text-left">구분</th>
                      <th className="px-3 py-2 text-left">모델</th>
                      {settings.provider === 'anthropic' && <th className="px-3 py-2 text-left">Effort</th>}
                      {settings.provider === 'gemini' && <th className="px-3 py-2 text-center">Thinking level</th>}
                      {settings.provider === 'openai' && <th className="px-3 py-2 text-center">Reasoning effort</th>}
                      <th className="px-3 py-2 text-left">Max tokens</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="px-3 py-2 text-gray-700">기본값</td>
                      <td className="px-3 py-2">
                        {compatibleModels.length > 0 ? (
                          <select className="select h-8 min-w-44 text-xs" disabled={aiDisabled} value={settings.model} onChange={(e) => setSettings((s) => ({ ...s, model: e.target.value }))}>
                            <option value="">{DEFAULT_MODELS[settings.provider] || '모델을 선택하세요'}</option>
                            {compatibleModels.map((model) => <option key={model} value={model}>{model}</option>)}
                          </select>
                        ) : (
                          <input className="input h-8 min-w-44 text-xs" disabled={aiDisabled} value={settings.model} placeholder={DEFAULT_MODELS[settings.provider] || '모델명'} onChange={(e) => setSettings((s) => ({ ...s, model: e.target.value }))} />
                        )}
                      </td>
                      {settings.provider === 'anthropic' && (
                        <td className="px-3 py-2">
                          <select className="select h-8 w-28 text-xs" disabled={aiDisabled} value={settings.anthropicEffort} onChange={(e) => handleAnthropicEffortChange(e.target.value as AnthropicEffort)}>
                            {ANTHROPIC_EFFORT_OPTIONS.map((effort) => <option key={effort.value} value={effort.value}>{effort.label}</option>)}
                          </select>
                        </td>
                      )}
                      {settings.provider === 'gemini' && (
                        <td className="px-3 py-2 text-center">
                          <select className="select h-8 w-28 text-xs" disabled={aiDisabled} value={settings.outputThinkingLevel} onChange={(e) => handleOutputThinkingLevelChange(e.target.value as GeminiThinkingLevel)}>
                            {GEMINI_THINKING_LEVEL_OPTIONS.map((level) => <option key={level.value} value={level.value}>{level.label}</option>)}
                          </select>
                        </td>
                      )}
                      {settings.provider === 'openai' && (
                        <td className="px-3 py-2 text-center">
                          <select className="select h-8 w-28 text-xs" disabled={aiDisabled} value={settings.outputReasoningEffort} onChange={(e) => handleOutputReasoningEffortChange(e.target.value as OpenAIReasoningEffort)}>
                            {OPENAI_REASONING_EFFORT_OPTIONS.map((effort) => <option key={effort.value} value={effort.value}>{effort.label}</option>)}
                          </select>
                        </td>
                      )}
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          min={1}
                          step={1}
                          className="input h-8 w-28 text-xs"
                          disabled={aiDisabled}
                          value={settings.anthropicMaxTokens}
                          onChange={(e) => handleAnthropicMaxTokensChange(e.target.value === '' ? '' : Math.max(1, Math.floor(Number(e.target.value) || 1)))}
                        />
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              {modelFetchError && <p className="text-xs text-red-600 flex items-center gap-1"><XCircle size={12} /> {modelFetchError}</p>}
              {compatibleModels.length > 0 && <p className="text-xs text-green-600">{compatibleModels.length}개 모델 로드됨</p>}
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <label className="label mb-0">기능별 설정</label>
                  <p className="text-xs text-gray-400">바꾸려는 항목만 선택하면 나머지는 기본 설정을 따릅니다.</p>
                </div>
                <button className="btn-secondary shrink-0" onClick={handleResetOutputOverrides} disabled={aiDisabled} title="기능별 설정만 모두 기본값으로 되돌립니다.">
                  <RefreshCw size={14} />
                  세부 설정 초기화
                </button>
              </div>
              <div className="overflow-hidden rounded border border-gray-200">
              <table className="w-full table-fixed border-collapse text-sm">
                <colgroup>
                  <col className="w-[18%]" />
                  <col className="w-[42%]" />
                  <col className="w-[20%]" />
                  <col className="w-[20%]" />
                </colgroup>
                <thead>
                  <tr className="border-b bg-gray-50 text-xs font-semibold text-gray-600">
                    <th className="px-3 py-2 text-left">기능</th>
                    <th className="px-3 py-2 text-left">모델</th>
                    {settings.provider === 'anthropic' && <th className="px-3 py-2 text-left">Effort</th>}
                    {settings.provider === 'gemini' && <th className="px-3 py-2 text-center">Thinking level</th>}
                    {settings.provider === 'openai' && <th className="px-3 py-2 text-center">Reasoning effort</th>}
                    <th className="px-3 py-2 text-left">Max tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {ANTHROPIC_OUTPUT_TASKS.map((task) => {
                    const option = settings.anthropicOutputOptions[task.key];
                    const disabled = outputOptionsDisabled;
                    return (
                      <tr key={task.key} className="border-b last:border-b-0">
                        <td className="px-3 py-2 text-gray-700">{task.label}</td>
                        <td className="px-3 py-2">
                          {compatibleModels.length > 0 ? (
                            <select className="select h-8 min-w-40 text-xs" value={option.model} disabled={disabled} onChange={(e) => handleAnthropicTaskModelChange(task.key, e.target.value)}>
                              <option value="">(기본값: {defaultModel})</option>
                              {compatibleModels.map((model) => <option key={model} value={model}>{model}</option>)}
                            </select>
                          ) : (
                            <input className="input h-8 min-w-40 text-xs" value={option.model} disabled={disabled} placeholder={`(기본값: ${defaultModel})`} onChange={(e) => handleAnthropicTaskModelChange(task.key, e.target.value)} />
                          )}
                        </td>
                        {settings.provider === 'anthropic' && (
                          <td className="px-3 py-2 text-center">
                            <select
                              className="select h-8 w-28 text-center text-xs"
                              value={option.effort}
                              disabled={disabled}
                              onChange={(e) => handleAnthropicTaskEffortChange(task.key, e.target.value as AnthropicEffort | '')}
                            >
                              <option value="">(기본값: {settings.anthropicEffort})</option>
                              {ANTHROPIC_EFFORT_OPTIONS.map((effort) => (
                                <option key={effort.value} value={effort.value}>{effort.label}</option>
                              ))}
                            </select>
                          </td>
                        )}
                        {settings.provider === 'gemini' && (
                          <td className="px-3 py-2 text-center">
                            <select
                              className="select h-8 w-28 text-center text-xs"
                              value={option.thinkingLevel}
                              disabled={disabled}
                              onChange={(e) => handleGeminiTaskThinkingLevelChange(task.key, e.target.value as GeminiThinkingLevel | '')}
                            >
                              <option value="">(기본값: {settings.outputThinkingLevel})</option>
                              {GEMINI_THINKING_LEVEL_OPTIONS.map((level) => (
                                <option key={level.value} value={level.value}>{level.label}</option>
                              ))}
                            </select>
                          </td>
                        )}
                        {settings.provider === 'openai' && (
                          <td className="px-3 py-2 text-center">
                            <select
                              className="select h-8 w-28 text-center text-xs"
                              value={option.reasoningEffort}
                              disabled={disabled}
                              onChange={(e) => handleOpenAITaskReasoningEffortChange(task.key, e.target.value as OpenAIReasoningEffort | '')}
                            >
                              <option value="">(기본값: {settings.outputReasoningEffort})</option>
                              {OPENAI_REASONING_EFFORT_OPTIONS.map((effort) => (
                                <option key={effort.value} value={effort.value}>{effort.label}</option>
                              ))}
                            </select>
                          </td>
                        )}
                        <td className="px-3 py-2 text-left">
                          <input
                            type="number"
                            min={1}
                            step={1}
                            className="input h-8 w-24 text-left text-xs"
                            value={option.maxTokens}
                            placeholder={`기본값: ${settings.anthropicMaxTokens || 8192}`}
                            disabled={disabled}
                            onChange={(e) => handleAnthropicTaskMaxTokensChange(task.key, e.target.value === '' ? '' : Math.max(1, Math.floor(Number(e.target.value) || 1)))}
                            aria-label={`${task.label} Max tokens`}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
            </div>
          </div>
        )}

        {!isAnthropic && (
          <div className="space-y-3">
            <div>
              <div className="flex items-center justify-between gap-3">
                <label className="label mb-0">Temperature</label>
                <label className={`flex items-center gap-2 text-xs ${aiDisabled || !temperatureSupported ? 'text-gray-400' : 'text-gray-700 cursor-pointer'}`}>
                  <input
                    type="checkbox"
                    className="w-4 h-4 rounded"
                    checked={settings.temperatureEnabled && temperatureSupported}
                    disabled={aiDisabled || !temperatureSupported}
                    onChange={(e) => handleTemperatureEnabledChange(e.target.checked)}
                  />
                  사용
                </label>
              </div>
              <p className="text-xs text-gray-400">
                낮을수록 일관성이 높고, 높을수록 표현이 다양해집니다. Anthropic 이외 공급자는 0~2.0 범위입니다.
              </p>
              {!temperatureSupported && (
                <p className="text-xs text-amber-600 mt-1">
                  선택한 모델은 temperature 설정을 지원하지 않는 것으로 처리되어 요청에 temperature를 보내지 않습니다.
                </p>
              )}
            </div>
            <div className="space-y-4">
              {TEMPERATURE_TASKS.map((task) => (
                <div key={task.key} className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <label className="text-xs font-medium text-gray-600" htmlFor={`temperature-${task.key}`}>
                      {task.label}
                    </label>
                    <input
                      type="number"
                      className="input h-8 w-20 text-right text-xs"
                      min={0}
                      max={temperatureMax}
                      step={0.1}
                      value={settings.temperatures[task.key]}
                      disabled={temperatureControlsDisabled}
                      onChange={(e) => handleTemperatureChange(task.key, Number(e.target.value))}
                    />
                  </div>
                  <input
                    id={`temperature-${task.key}`}
                    type="range"
                    className="w-full accent-gray-800"
                    min={0}
                    max={temperatureMax}
                    step={0.1}
                    value={settings.temperatures[task.key]}
                    disabled={temperatureControlsDisabled}
                    onChange={(e) => handleTemperatureChange(task.key, Number(e.target.value))}
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 저장 / 테스트 */}
        <div className="flex items-center gap-3 pt-2">
          <button className="btn-primary" onClick={handleSave} disabled={saving || !canSave}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            저장
          </button>
          <button className="btn-secondary" onClick={handleTest} disabled={testing || aiDisabled}>
            {testing ? <Loader2 size={14} className="animate-spin" /> : <TestTube size={14} />}
            연결 테스트
          </button>
          {saved && (
            <span className="text-sm text-green-600 flex items-center gap-1">
              <CheckCircle size={14} /> 저장됨
            </span>
          )}
        </div>
        {settings.aiEnabled && !canSave && (
          <p className="text-xs text-amber-600">
            AI 기능 사용 상태에서는 현재 설정으로 연결 테스트에 성공해야 저장할 수 있습니다.
          </p>
        )}

        {testResult && (
          <div
            className={`p-4 rounded-lg border text-sm ${testResult.ok
                ? 'bg-green-50 border-green-200 text-green-800'
                : 'bg-red-50 border-red-200 text-red-800'
              }`}
          >
            <div className="flex items-start gap-2">
              {testResult.ok
                ? <CheckCircle size={16} className="mt-0.5 shrink-0" />
                : <XCircle size={16} className="mt-0.5 shrink-0" />}
              <div>
                <p className="font-medium">{testResult.ok ? '연결 성공' : '연결 실패'}</p>
                <p className="mt-1 text-xs whitespace-pre-wrap">{testResult.message}</p>
              </div>
            </div>
          </div>
        )}

        <div className="border-t border-gray-100 pt-4">
          <h3 className="text-sm font-semibold mb-2">공급자별 안내</h3>
          <ul className="text-xs text-gray-600 space-y-1.5">
            <li><span className="font-medium">Google Gemini:</span> Google AI Studio에서 API 키 발급 → gemini-2.5-flash 권장</li>
            <li><span className="font-medium">OpenAI:</span> OpenAI 플랫폼에서 API 키 발급 → gpt-4o-mini 권장</li>
            <li><span className="font-medium">Anthropic:</span> Anthropic Console에서 API 키 발급 → Claude 최신 모델명을 직접 입력하거나 모델 가져오기를 사용하세요.</li>
            <li><span className="font-medium">Ollama:</span> 로컬 Ollama 서버 실행 후 사용</li>
            <li><span className="font-medium">OpenAI 호환:</span> 기본 서버는 <code className="bg-gray-100 px-1 rounded">http://localhost:8000/v1</code>이며, 모델 가져오기로 목록을 불러올 수 있습니다.</li>
          </ul>
        </div>
      </div>
      </div>
      )}

      {activeTab === 'assignment' && (
      <div className="space-y-6">
        <div className="card p-6 space-y-5">
          <div>
            <h3 className="text-sm font-semibold text-gray-800">교사용 확인 화면 비밀번호</h3>
            <p className="text-xs text-gray-500 mt-1">
              수행평가앱의 교사용 페이지에 접속할 때 입력할 비밀번호입니다. 학생 제출 화면에는 적용되지 않습니다.
            </p>
          </div>

          <div className={`rounded-md border px-3 py-2 text-xs ${settings.assignmentTeacherPasswordSet ? 'border-green-200 bg-green-50 text-green-700' : 'border-amber-200 bg-amber-50 text-amber-700'}`}>
            {settings.assignmentTeacherPasswordSet
              ? '현재 교사용 비밀번호가 설정되어 있습니다.'
              : '아직 교사용 비밀번호가 설정되어 있지 않습니다.'}
          </div>

          <div className="space-y-3">
            <label className="block">
              <span className="label">새 비밀번호</span>
              <input
                type="password"
                className="input"
                value={teacherPassword}
                onChange={(e) => setTeacherPassword(e.target.value)}
                placeholder="4자 이상"
              />
            </label>
            <label className="block">
              <span className="label">새 비밀번호 확인</span>
              <input
                type="password"
                className="input"
                value={teacherPasswordConfirm}
                onChange={(e) => setTeacherPasswordConfirm(e.target.value)}
                placeholder="같은 비밀번호를 한 번 더 입력"
              />
            </label>
          </div>

          <div className="flex items-center gap-2">
            <button
              className="btn-primary"
              disabled={savingTeacherPassword}
              onClick={async () => {
                if (teacherPassword !== teacherPasswordConfirm) {
                  alert('비밀번호 확인이 일치하지 않습니다.');
                  return;
                }
                setSavingTeacherPassword(true);
                try {
                  const ok = await saveAssignmentTeacherPassword(teacherPassword);
                  if (ok) {
                    setTeacherPassword('');
                    setTeacherPasswordConfirm('');
                  }
                } finally {
                  setSavingTeacherPassword(false);
                }
              }}
            >
              {savingTeacherPassword ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              비밀번호 저장
            </button>
            {settings.assignmentTeacherPasswordSet && (
              <button
                className="btn-secondary"
                disabled={savingTeacherPassword}
                onClick={async () => {
                  setSavingTeacherPassword(true);
                  try {
                    await clearAssignmentTeacherPassword();
                  } finally {
                    setSavingTeacherPassword(false);
                  }
                }}
              >
                비밀번호 해제
              </button>
            )}
          </div>
        </div>
      </div>
      )}

      {activeTab === 'data' && (
      <div className="space-y-6">
        <div className="card p-6 space-y-4">
          <div>
            <h3 className="text-sm font-semibold text-gray-800">데이터 백업/복원</h3>
            <p className="text-xs text-gray-500 mt-1">
              현재 데이터베이스, 업로드 파일, 로그를 ZIP 파일로 백업하거나 이전 백업을 복원합니다.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button className="btn-primary" onClick={handleBackup} disabled={backingUp || restoring}>
              {backingUp ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
              백업 다운로드
            </button>

            {hasDesktopFileDialogs() ? (
              <button
                type="button"
                className="btn-secondary"
                disabled={backingUp || restoring}
                onClick={async () => {
                  const files = await openFiles({ filters: [{ name: 'ZIP', extensions: ['zip'] }] });
                  if (files?.[0]) handleRestore(files[0]);
                }}
              >
                {restoring ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                백업 복원
              </button>
            ) : (
              <label className={`btn-secondary cursor-pointer ${backingUp || restoring ? 'opacity-50 pointer-events-none' : ''}`}>
                {restoring ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                백업 복원
                <input
                  type="file"
                  accept=".zip,application/zip"
                  className="hidden"
                  disabled={backingUp || restoring}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.currentTarget.value = '';
                    if (file) handleRestore(file);
                  }}
                />
              </label>
            )}
          </div>

          <div className="space-y-0.5 text-xs text-gray-400">
            <p>현재 저장 위치: <code>{settings.storage?.currentRoot || '-'}</code></p>
            {settings.storage?.source === 'env' ? (
              <p>Electron 앱은 운영체제의 앱 데이터 폴더를 사용합니다.</p>
            ) : (
              <p>개발 모드에서는 프로젝트 루트의 <code>storage/</code> 폴더를 사용합니다.</p>
            )}
            <p className="text-amber-600">복원하면 현재 데이터가 백업 ZIP 내용으로 교체됩니다.</p>
          </div>
        </div>

        <div className="card p-6">
          <h3 className="text-sm font-semibold mb-1 text-red-700">데이터 초기화</h3>
          <p className="text-xs text-gray-500 mb-3">
            모든 수업·기준·기록 데이터와 업로드된 파일을 삭제합니다. LLM 설정은 유지됩니다.
          </p>

          {!resetConfirm ? (
            <button
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-red-600 bg-red-50 border border-red-200 rounded hover:bg-red-100 transition-colors"
              onClick={() => setResetConfirm(true)}
            >
              <Trash2 size={13} /> 전체 초기화
            </button>
          ) : (
            <div className="space-y-3">
              <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded text-xs text-red-800">
                <AlertTriangle size={14} className="mt-0.5 shrink-0 text-red-500" />
                <div>
                  <p className="font-semibold">정말 초기화하시겠습니까?</p>
                  <p className="mt-0.5">성취 기준 관리, 평가 영역 관리, 채점 기록 관리의 모든 데이터와 업로드 파일이 영구 삭제됩니다. 이 작업은 되돌릴 수 없습니다.</p>
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-white bg-red-600 rounded hover:bg-red-700 transition-colors disabled:opacity-50"
                  onClick={handleReset}
                  disabled={resetting}
                >
                  {resetting ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                  {resetting ? '초기화 중...' : '확인, 모두 삭제'}
                </button>
                <button
                  className="px-3 py-2 text-xs font-medium text-gray-600 bg-gray-100 rounded hover:bg-gray-200 transition-colors"
                  onClick={() => setResetConfirm(false)}
                  disabled={resetting}
                >
                  취소
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
      )}
      </div>
    </div>
  );
}
