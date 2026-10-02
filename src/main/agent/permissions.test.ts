import { describe, expect, it, vi } from 'vitest';
import type { PermissionRule } from '@shared/settings';
import { decidePermission, globMatch, ruleMatches } from './permissions';

describe('globMatch', () => {
  it('matches * across any text and ? for one character', () => {
    expect(globMatch('git push*', 'git push origin main')).toBe(true);
    expect(globMatch('mcp__*', 'mcp__fs__read')).toBe(true);
    expect(globMatch('read_?ile', 'read_file')).toBe(true);
    expect(globMatch('git push*', 'echo git push')).toBe(false);
  });

  it('treats regular-expression characters literally', () => {
    expect(globMatch('a.b(c)', 'a.b(c)')).toBe(true);
    expect(globMatch('a.b', 'axb')).toBe(false);
    expect(globMatch('src/**/*.ts', 'src/a/b.ts')).toBe(true);
  });
});

describe('ruleMatches', () => {
  const rule: PermissionRule = {
    tool: ['edit_file', 'write_file'],
    matches: { path: ['src/*', 'lib/*'] },
    action: 'reject',
  };

  it('needs the tool and every matcher to match', () => {
    expect(ruleMatches(rule, 'edit_file', { path: 'src/a.ts' }, 'thread')).toBe(true);
    expect(ruleMatches(rule, 'write_file', { path: 'lib/a.ts' }, 'thread')).toBe(true);
    expect(ruleMatches(rule, 'edit_file', { path: 'docs/a.md' }, 'thread')).toBe(false);
    expect(ruleMatches(rule, 'edit_file', {}, 'thread')).toBe(false);
    expect(ruleMatches(rule, 'grep', { path: 'src/a.ts' }, 'thread')).toBe(false);
  });

  it('honours the context filter', () => {
    const subagentOnly: PermissionRule = { tool: '*', action: 'reject', context: 'subagent' };
    expect(ruleMatches(subagentOnly, 'grep', {}, 'subagent')).toBe(true);
    expect(ruleMatches(subagentOnly, 'grep', {}, 'thread')).toBe(false);
  });
});

describe('decidePermission', () => {
  const rules: PermissionRule[] = [
    { tool: 'run_command', matches: { command: 'git push*' }, action: 'reject', message: 'no pushing' },
    { tool: 'run_command', matches: { command: 'git *' }, action: 'allow' },
    { tool: 'mcp__*', action: 'ask' },
    { tool: 'fetch_url', action: 'delegate', to: 'checker' },
  ];

  it('returns the first matching rule, or null', async () => {
    expect(await decidePermission(rules, 'run_command', { command: 'git push' }, 'thread')).toEqual({
      action: 'reject',
      message: 'no pushing',
    });
    expect(await decidePermission(rules, 'run_command', { command: 'git status' }, 'thread')).toMatchObject({
      action: 'allow',
    });
    expect(await decidePermission(rules, 'mcp__fs__read', {}, 'thread')).toMatchObject({ action: 'ask' });
    expect(await decidePermission(rules, 'run_command', { command: 'ls' }, 'thread')).toBeNull();
  });

  it('asks the delegate program with the call and uses its answer', async () => {
    const delegate = vi.fn(async () => 'allow\n');
    const input = { url: 'https://example.com' };
    expect(await decidePermission(rules, 'fetch_url', input, 'subagent', delegate)).toEqual({ action: 'allow' });
    expect(delegate).toHaveBeenCalledWith('checker', JSON.stringify({ tool: 'fetch_url', input, context: 'subagent' }));
  });

  it('rejects when the delegate fails or answers nonsense', async () => {
    const failing = async () => {
      throw new Error('boom');
    };
    expect(await decidePermission(rules, 'fetch_url', {}, 'thread', failing)).toMatchObject({ action: 'reject' });
    expect(await decidePermission(rules, 'fetch_url', {}, 'thread', async () => 'maybe')).toMatchObject({
      action: 'reject',
    });
  });

  it('runs a real program without a shell', async () => {
    const program = process.execPath;
    const decision = await decidePermission(
      [{ tool: '*', action: 'delegate', to: program }],
      'x',
      {},
      'thread',
      undefined,
    );
    // node with no script and piped stdin evaluates the JSON as code and fails, which must reject.
    expect(decision?.action).toBe('reject');
  });
});
