export const PROVIDERS = [
  { value: 'gemini', label: 'Google (Gemini)' },
  { value: 'openai', label: 'OpenAI (ChatGPT)' },
  { value: 'anthropic', label: 'Anthropic (Claude)' },
  { value: 'ollama', label: 'Ollama' },
  { value: 'openai-compatible', label: 'OpenAI 호환' },
];

export const DEFAULT_MODELS: Record<string, string> = {
  gemini: 'gemini-2.5-flash',
  openai: 'gpt-4o-mini',
  anthropic: '',
  ollama: 'llama3',
  'openai-compatible': '',
};

export const DEFAULT_URLS: Record<string, string> = {
  ollama: 'http://localhost:11434',
  'openai-compatible': 'http://localhost:8000/v1',
};

export const TEMPERATURE_TASKS = [
  { key: 'domainManagement', label: '평가 영역 관리' },
  { key: 'recordsScoring', label: '채점 기록 관리 - 채점' },
  { key: 'recordsComments', label: '채점 기록 관리 - 기록(세특)' },
] as const;

export const ANTHROPIC_OUTPUT_TASKS = [
  { key: 'domainManagement', label: '평가 영역 관리' },
  { key: 'recordsScoring', label: '채점' },
  { key: 'recordsComments', label: '기록' },
  { key: 'subjectComprehensive', label: '세특' },
] as const;

export const DEFAULT_TEMPERATURES = {
  anthropic: {
    domainManagement: 0.4,
    recordsScoring: 0,
    recordsComments: 0.5,
  },
  default: {
    domainManagement: 0.5,
    recordsScoring: 0,
    recordsComments: 0.7,
  },
};

export const ANTHROPIC_EFFORT_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'XHigh' },
  { value: 'max', label: 'Max' },
] as const;

export const GEMINI_THINKING_LEVEL_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
] as const;

export const OPENAI_REASONING_EFFORT_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
] as const;

export function supportsTemperature(provider: string, model: string) {
  if (provider === 'anthropic') return false;
  const normalized = model.trim().toLowerCase();
  if (!normalized) return true;
  if (provider === 'openai' || provider === 'openai-compatible') {
    return !(
      normalized.startsWith('o1') ||
      normalized.startsWith('o3') ||
      normalized.startsWith('o4') ||
      normalized.startsWith('gpt-5')
    );
  }
  return true;
}
