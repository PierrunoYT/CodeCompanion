import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Workspace } from '../tools/workspace';
import { loadAgentFile } from './agent_file';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-agentfile-'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('loadAgentFile', () => {
  it('returns null when there is no agent file', () => {
    expect(loadAgentFile(new Workspace(root))).toBeNull();
  });

  it('prefers AGENTS.md over CLAUDE.md', () => {
    writeFileSync(join(root, 'AGENTS.md'), 'agents\n');
    writeFileSync(join(root, 'CLAUDE.md'), 'claude');
    expect(loadAgentFile(new Workspace(root))).toEqual({ name: 'AGENTS.md', content: 'agents', truncated: false });
  });

  it('falls back to CLAUDE.md and skips empty files', () => {
    writeFileSync(join(root, 'AGENTS.md'), '  \n');
    writeFileSync(join(root, 'CLAUDE.md'), 'claude');
    expect(loadAgentFile(new Workspace(root))?.name).toBe('CLAUDE.md');
  });

  it('truncates very long files', () => {
    writeFileSync(join(root, 'AGENTS.md'), 'x'.repeat(30_000));
    const file = loadAgentFile(new Workspace(root));
    expect(file?.content).toHaveLength(20_000);
    expect(file?.truncated).toBe(true);
  });
});
