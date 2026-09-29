export type Provider = 'anthropic' | 'openai';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ModelOption {
  id: string;
  label: string;
  provider: Provider;
}

export const MODEL_OPTIONS: ModelOption[] = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', provider: 'anthropic' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', provider: 'anthropic' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', provider: 'anthropic' },
  { id: 'gpt-6-astra', label: 'GPT-6 Astra', provider: 'openai' },
  { id: 'gpt-6-sol', label: 'GPT-6 Sol', provider: 'openai' },
  { id: 'gpt-6-luna', label: 'GPT-6 Luna', provider: 'openai' },
];

export const DEFAULT_MODEL = 'claude-opus-5-5';

// Cheap model used for background work: chat titles and search re-ranking.
export const SMALL_MODELS: Record<Provider, string> = {
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-6-luna',
};

export const EMBEDDING_MODEL = 'text-embedding-3-small';

// Any model id can be entered in settings; ids starting with "claude" go to Anthropic, the rest to the
// OpenAI-compatible endpoint.
export function providerForModel(model: string): Provider {
  return model.toLowerCase().startsWith('claude') ? 'anthropic' : 'openai';
}

export interface ClaudeCapabilities {
  // Adaptive thinking and output_config.effort.
  adaptiveThinking: boolean;
  // Server-side compaction (beta compact-2026-01-12).
  compaction: boolean;
  // Server-side refusal fallback with fallbacks: "default" (beta server-side-fallback-2026-07-01).
  refusalFallback: boolean;
}

// Request features differ per Claude model and sending an unsupported one is a 400, so features are enabled
// only for models known to support them. Unknown (custom) Claude ids get a plain request.
const CURRENT_GENERATION = /^claude-(opus-5-5|sonnet-5-5|opus-5|fable-5-1|fable-5)$/;

export function claudeCapabilities(model: string): ClaudeCapabilities {
  const current = CURRENT_GENERATION.test(model);
  return {
    adaptiveThinking: current,
    compaction: current,
    refusalFallback: /^claude-(opus-5-5|sonnet-5-5|fable-5-1)$/.test(model),
  };
}
