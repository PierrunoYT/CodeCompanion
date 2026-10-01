import { describe, expect, it } from 'vitest';
import type { CompletionClient } from '../llm/types';
import { commitMessagePrompt, MAX_COMMIT_DIFF_CHARS, suggestCommitMessage } from './commit_message';

const client = (message: string): CompletionClient & { prompts: string[] } => {
  const prompts: string[] = [];
  return {
    prompts,
    complete: async (prompt: string) => {
      prompts.push(prompt);
      return { message } as never;
    },
  } as never;
};

describe('commit message suggestions', () => {
  it('asks for a Conventional Commit with the files and the diff', async () => {
    const model = client('  feat: validate signup input \n');
    await expect(suggestCommitMessage(model, '+a', ['src/signup.ts'])).resolves.toBe('feat: validate signup input');
    expect(model.prompts[0]).toContain('Conventional Commits');
    expect(model.prompts[0]).toContain('Changed files: src/signup.ts');
    expect(model.prompts[0]).toContain('+a');
  });

  it('cuts a long diff', () => {
    const prompt = commitMessagePrompt('x'.repeat(MAX_COMMIT_DIFF_CHARS + 10), ['a']);
    expect(prompt).toContain('[diff cut]');
    expect(prompt.length).toBeLessThan(MAX_COMMIT_DIFF_CHARS + 1000);
  });

  it('says why it cannot suggest one', async () => {
    await expect(suggestCommitMessage(client('x'), '', [])).rejects.toThrow('no changes');
    await expect(suggestCommitMessage(null, '+a', ['a'])).rejects.toThrow('API key');
    await expect(suggestCommitMessage(client('  '), '+a', ['a'])).rejects.toThrow('empty commit message');
  });
});
