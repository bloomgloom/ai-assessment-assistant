import assert from 'node:assert/strict';
import { buildAnthropicMessageParams, filterAnthropicModelsByReleaseDate, LLMSettings, outputOptionsForTask } from './llm';

const settings = {
  model: 'claude-sonnet-5',
  anthropicEffort: 'medium',
  anthropicMaxTokens: 8192,
  outputThinkingLevel: 'medium',
  outputReasoningEffort: 'medium',
  anthropicOutputOptions: {
    domainManagement: {},
    recordsScoring: {},
    recordsComments: {},
    subjectComprehensive: {
      model: 'claude-opus-5-5',
      maxTokens: 24576,
    },
  },
} as LLMSettings;

assert.deepEqual(outputOptionsForTask(settings, 'recordsScoring'), {
  model: 'claude-sonnet-5',
  effort: 'medium',
  maxTokens: 8192,
  thinkingLevel: 'medium',
  reasoningEffort: 'medium',
});
assert.deepEqual(outputOptionsForTask(settings, 'subjectComprehensive'), {
  model: 'claude-opus-5-5',
  effort: 'medium',
  maxTokens: 24576,
  thinkingLevel: 'medium',
  reasoningEffort: 'medium',
});
const sonnet55Request = buildAnthropicMessageParams('test', {
  ...settings,
  model: 'claude-sonnet-5-5',
  anthropicEffort: 'max',
}, [], undefined, undefined, undefined, 'recordsScoring');
assert.equal('thinking' in sonnet55Request, false);
assert.deepEqual(sonnet55Request.output_config, { effort: 'max' });

const sonnet5Request = buildAnthropicMessageParams('test', settings, [], undefined, undefined, undefined, 'recordsScoring');
assert.equal('thinking' in sonnet5Request, false);

const opus55Request = buildAnthropicMessageParams('test', {
  ...settings,
  model: 'claude-opus-5-5',
}, [], undefined, undefined, undefined, 'recordsScoring');
assert.equal('thinking' in opus55Request, false);

const fable51Request = buildAnthropicMessageParams('test', {
  ...settings,
  model: 'claude-fable-5-1',
}, [], undefined, undefined, undefined, 'recordsScoring');
assert.equal('thinking' in fable51Request, false);

assert.deepEqual(filterAnthropicModelsByReleaseDate([
  { id: 'old-model', created_at: '2026-08-31T23:59:59Z' },
  { id: 'claude-fable-5-1', created_at: '2026-09-01T00:00:00Z' },
  { id: 'claude-opus-5-5', created_at: '2026-09-22T00:00:00Z' },
  { id: 'claude-sonnet-5-5', created_at: '2026-09-28T00:00:00Z' },
  { id: 'future-model', created_at: '2026-10-01T00:00:00Z' },
]), ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'future-model']);
