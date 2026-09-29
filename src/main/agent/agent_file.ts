import { readFileSync, statSync } from 'node:fs';
import type { Workspace } from '../tools/workspace';

// Project instruction files injected into every chat, in order of preference; the first one found wins.
export const AGENT_FILE_NAMES = ['AGENTS.md', 'CLAUDE.md'];

const MAX_CHARS = 20_000;

export interface AgentFile {
  name: string;
  content: string;
  truncated: boolean;
}

export function loadAgentFile(workspace: Workspace): AgentFile | null {
  for (const name of AGENT_FILE_NAMES) {
    try {
      const path = workspace.resolve(name);
      if (!statSync(path).isFile()) continue;
      const text = readFileSync(path, 'utf8').trim();
      if (!text) continue;
      return { name, content: text.slice(0, MAX_CHARS), truncated: text.length > MAX_CHARS };
    } catch {
      // Missing, unreadable or outside the project: try the next name.
    }
  }
  return null;
}
