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

// US dollars per million tokens at the providers' standard list prices (September 2026). Custom ids get no estimate.
export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  longContext?: ModelPricing;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'gpt-6-astra': {
    input: 10,
    output: 50,
    cacheRead: 1,
    cacheWrite: 12.5,
    longContext: { input: 20, output: 75, cacheRead: 2, cacheWrite: 25 },
  },
  'gpt-6-sol': {
    input: 2,
    output: 10,
    cacheRead: 0.2,
    cacheWrite: 2.5,
    longContext: { input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5 },
  },
  'gpt-6-luna': {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    longContext: { input: 0.2, output: 0.75, cacheRead: 0.02, cacheWrite: 0.25 },
  },
};

// Estimated cost in dollars of a chat's token usage, or null when the model/provider price is not known.
export function estimateCost(
  model: string,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens?: number;
    longContext?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  },
  officialProvider = true,
): number | null {
  if (!officialProvider) return null;
  const price = MODEL_PRICING[model];
  if (!price) return null;
  // Long-context tokens are split out only when the model has a long-context price; otherwise they stay at list price.
  const longPrice = price.longContext;
  const long = longPrice ? usage.longContext : undefined;
  const shortCost =
    (usage.inputTokens - (long?.inputTokens ?? 0)) * price.input +
    (usage.outputTokens - (long?.outputTokens ?? 0)) * price.output +
    (usage.cacheReadTokens - (long?.cacheReadTokens ?? 0)) * price.cacheRead +
    ((usage.cacheWriteTokens ?? 0) - (long?.cacheWriteTokens ?? 0)) * price.cacheWrite;
  const longCost =
    long && longPrice
      ? long.inputTokens * longPrice.input +
        long.outputTokens * longPrice.output +
        long.cacheReadTokens * longPrice.cacheRead +
        long.cacheWriteTokens * longPrice.cacheWrite
      : 0;
  return (shortCost + longCost) / 1_000_000;
}

export function formatCost(dollars: number): string {
  return dollars < 0.01 ? '<$0.01' : `$${dollars.toFixed(2)}`;
}

export const EMBEDDING_MODEL = 'text-embedding-3-small';

// Prompt size (tokens) from which the app suggests compacting the chat. One value for every model: context windows
// differ (and are unknown for custom endpoints), so this is a nudge well below the common 200k, not a limit.
export const COMPACT_SUGGESTED_TOKENS = 150_000;

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
