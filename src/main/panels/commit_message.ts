import { z } from 'zod';
import type { CompletionClient } from '../llm/types';

// How much of the diff the small model reads. Longer diffs are cut; the file list still names every file.
export const MAX_COMMIT_DIFF_CHARS = 30_000;

export function commitMessagePrompt(diff: string, files: string[]): string {
  const shown = diff.length > MAX_COMMIT_DIFF_CHARS ? `${diff.slice(0, MAX_COMMIT_DIFF_CHARS)}\n[diff cut]` : diff;
  return [
    'Write a git commit message for the changes below, following Conventional Commits (feat:, fix:, docs:, test:,',
    'refactor:, chore:, …). One subject line of at most 72 characters in the imperative mood; add a short body only',
    'when the subject cannot say enough. Describe what changed and why, not file by file. No quotes around it.',
    '',
    `Changed files: ${files.join(', ')}`,
    '',
    shown,
  ].join('\n');
}

// Suggests a commit message for the project's uncommitted changes with the small model (the Git panel's Generate).
export async function suggestCommitMessage(
  model: CompletionClient | null,
  diff: string,
  files: string[],
): Promise<string> {
  if (files.length === 0) throw new Error('There are no changes to describe.');
  if (!model) throw new Error('Generating a commit message needs an Anthropic or OpenAI API key. Add one in Settings.');
  const { message } = await model.complete(commitMessagePrompt(diff, files), z.object({ message: z.string() }));
  const text = message.trim();
  if (!text) throw new Error('The model returned an empty commit message. Try again or write one.');
  return text;
}
