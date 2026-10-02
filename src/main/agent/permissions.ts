import { spawn } from 'node:child_process';
import type { PermissionRule } from '@shared/settings';

export type PermissionContext = 'thread' | 'subagent';

// What a rule decided. No decision (null) leaves the tool's own approval rules in force.
export interface PermissionDecision {
  action: 'allow' | 'reject' | 'ask';
  message?: string;
}

const DELEGATE_TIMEOUT_MS = 15_000;
const MAX_DELEGATE_OUTPUT = 4096;

// `*` matches any run of characters (also across `/`), `?` one character. Everything else is literal.
export function globMatch(pattern: string, text: string): boolean {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${source}$`, 's').test(text);
}

function anyGlob(patterns: string | string[], text: string): boolean {
  return (Array.isArray(patterns) ? patterns : [patterns]).some((pattern) => globMatch(pattern, text));
}

export function ruleMatches(
  rule: PermissionRule,
  toolName: string,
  input: Record<string, unknown>,
  context: PermissionContext,
): boolean {
  if (rule.context && rule.context !== context) return false;
  if (!anyGlob(rule.tool, toolName)) return false;
  for (const [field, patterns] of Object.entries(rule.matches ?? {})) {
    const value = input[field];
    if (value === undefined) return false;
    if (!anyGlob(patterns, typeof value === 'string' ? value : JSON.stringify(value))) return false;
  }
  return true;
}

// The first matching rule wins. A delegate rule asks an external program, and any failure of that program rejects.
export async function decidePermission(
  rules: PermissionRule[],
  toolName: string,
  input: Record<string, unknown>,
  context: PermissionContext,
  delegate: (program: string, payload: string) => Promise<string> = runDelegate,
): Promise<PermissionDecision | null> {
  const rule = rules.find((candidate) => ruleMatches(candidate, toolName, input, context));
  if (!rule) return null;
  if (rule.action !== 'delegate') return { action: rule.action, message: rule.message };

  const program = rule.to ?? '';
  try {
    const answer = (await delegate(program, JSON.stringify({ tool: toolName, input, context }))).trim().toLowerCase();
    if (answer === 'allow' || answer === 'ask') return { action: answer };
    if (answer === 'reject') return { action: 'reject', message: rule.message };
    return { action: 'reject', message: `The permission program "${program}" gave an unusable answer.` };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { action: 'reject', message: `The permission program "${program}" failed: ${reason}` };
  }
}

// Runs the program without a shell, writes the call as JSON to its stdin and returns what it prints.
function runDelegate(program: string, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('it did not answer within 15 seconds'));
    }, DELEGATE_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      if (output.length < MAX_DELEGATE_OUTPUT) output += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(`it exited with code ${code}`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(payload);
  });
}
