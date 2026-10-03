import { describe, expect, it } from 'vitest';
import { availableTools } from './registry';
import type { AgentTool } from './types';

function named(name: string): AgentTool {
  return { name } as AgentTool;
}

describe('availableTools', () => {
  const context = { browser: null, codeSearch: null, webSearch: null };

  it('sorts extra tools by name and leaves propose_plan out when plan mode is off', () => {
    const extra = [named('zeta_tool'), named('alpha_tool')];
    const names = availableTools(context, extra).map((tool) => tool.name);

    expect(names.slice(-2)).toEqual(['alpha_tool', 'zeta_tool']);
    expect(names).not.toContain('propose_plan');
    expect(extra.map((tool) => tool.name)).toEqual(['zeta_tool', 'alpha_tool']);
  });
});
