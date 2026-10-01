import { describe, expect, it } from 'vitest';
import { matchFiles, mentionAt, messageWithMentions } from './composer';

describe('@-mentions', () => {
  it('finds the mention being typed before the caret', () => {
    expect(mentionAt('look at @src/sig', 16)).toEqual({ query: 'src/sig', start: 8 });
    expect(mentionAt('@', 1)).toEqual({ query: '', start: 0 });
    expect(mentionAt('mail me@example', 15)).toBeNull();
    expect(mentionAt('@done and more', 14)).toBeNull();
  });

  it('suggests files whose name starts with the query first', () => {
    const files = ['docs/signup-notes.md', 'src/signup.ts', 'src/__tests__/signup.test.ts', 'src/app.ts'];
    expect(matchFiles(files, 'signup')).toEqual([
      'src/signup.ts',
      'docs/signup-notes.md',
      'src/__tests__/signup.test.ts',
    ]);
    expect(matchFiles(files, 'SRC/A')).toEqual(['src/app.ts']);
    expect(matchFiles(files, '', 2)).toHaveLength(2);
  });

  it('puts the mentioned files at the start of the message', () => {
    expect(messageWithMentions('Fix it', [])).toBe('Fix it');
    expect(messageWithMentions('Fix it', ['src/a.ts', 'b.ts'])).toBe('@src/a.ts @b.ts\n\nFix it');
    expect(messageWithMentions('', ['src/a.ts'])).toBe('@src/a.ts');
  });
});
