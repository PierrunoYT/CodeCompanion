export type Provider = 'anthropic' | 'openai';

export interface ModelOption {
  id: string;
  label: string;
  provider: Provider;
}

export const MODEL_OPTIONS: ModelOption[] = [
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', provider: 'anthropic' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', provider: 'anthropic' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', provider: 'anthropic' },
  { id: 'gpt-4o', label: 'GPT-4o', provider: 'openai' },
  { id: 'gpt-4o-mini', label: 'GPT-4o mini', provider: 'openai' },
];

export const DEFAULT_MODEL = 'claude-sonnet-5-5';

// Cheap model used for background work: chat titles, summaries, search re-ranking.
export const SMALL_MODELS: Record<Provider, string> = {
  anthropic: 'claude-haiku-4-5-20251001',
  openai: 'gpt-4o-mini',
};

export const EMBEDDING_MODEL = 'text-embedding-3-small';

// Any model id can be entered in settings; ids starting with "claude" go to Anthropic, the rest to the
// OpenAI-compatible endpoint.
export function providerForModel(model: string): Provider {
  return model.toLowerCase().startsWith('claude') ? 'anthropic' : 'openai';
}
