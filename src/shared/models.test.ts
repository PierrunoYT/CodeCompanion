import { describe, expect, it } from 'vitest';
import { estimateCost, formatCost } from './models';

describe('estimateCost', () => {
  it('adds input, output and cached input at the model prices', () => {
    // 1M input at $4 + 0.5M output at $20 + 2M cached at $0.20.
    expect(estimateCost('claude-opus-5-5', { inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 2_000_000 })).toBeCloseTo(14.4);
  });

  it('returns null for models without a known price', () => {
    expect(estimateCost('gpt-6-astra', { inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0 })).toBeNull();
    expect(estimateCost('claude-custom', { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 })).toBeNull();
  });
});

describe('formatCost', () => {
  it('shows cents, and a floor for tiny amounts', () => {
    expect(formatCost(0.004)).toBe('<$0.01');
    expect(formatCost(1.234)).toBe('$1.23');
  });
});
