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

// US dollars per million tokens (Anthropic API list prices, September 2026). Models without an entry (the OpenAI
// models and custom ids) get no cost estimate rather than a guess. Haiku's cache-read price is 10% of its input price.
export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
};

// Estimated cost in dollars of a chat's token usage, or null when the model's price is not known. The Claude API
// reports cache reads separately from input tokens; cache writes are not tracked, so this is a lower bound.
export function estimateCost(
  model: string,
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number },
): number | null {
  const price = MODEL_PRICING[model];
  if (!price) return null;
  return (usage.inputTokens * price.input + usage.outputTokens * price.output + usage.cacheReadTokens * price.cacheRead) / 1_000_000;
}

export function formatCost(dollars: number): string {
  return dollars < 0.01 ? '<$0.01' : `$${dollars.toFixed(2)}`;
}

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
