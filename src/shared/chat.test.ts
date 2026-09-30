import { describe, expect, it } from 'vitest';
import { applyChatEvent, filterChats, searchSnippet, transcriptSearchText, type ChatEvent, type ChatSummary, type TranscriptItem } from './chat';

const run = (events: ChatEvent[]) => events.reduce<TranscriptItem[]>(applyChatEvent, []);

describe('transcriptSearchText and searchSnippet', () => {
  it('collects only what the user and the assistant said', () => {
    const items: TranscriptItem[] = [
      { kind: 'user', id: 'u', text: 'Why does login fail?', imageCount: 0 },
      { kind: 'tool', id: 't', name: 'read_file', status: 'done', output: 'secret tool output' },
      { kind: 'assistant', id: 'a', text: 'The token expires.', thinking: 'private thoughts', streaming: false },
    ];
    expect(transcriptSearchText(items)).toBe('Why does login fail?\nThe token expires.');
  });

  it('cuts a one-line excerpt around the first match', () => {
    const text = `${'a '.repeat(100)}the needle is here\n${'b '.repeat(100)}`;
    const snippet = searchSnippet(text, ['needle'])!;
    expect(snippet).toContain('the needle is here');
    expect(snippet).not.toContain('\n');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet.length).toBeLessThan(200);
  });

  it('returns nothing when no word is in the text', () => {
    expect(searchSnippet('nothing here', ['needle'])).toBeUndefined();
    expect(searchSnippet('short text with word', ['word'])).toBe('short text with word');
  });
});

describe('filterChats', () => {
  const chat = (id: string, title: string, projectPath: string | null): ChatSummary => ({
    id,
    title,
    projectPath,
    updatedAt: '2026-09-30T00:00:00.000Z',
  });
  const chats = [chat('1', 'Fix login bug', 'D:\\code\\shop'), chat('2', 'Add dark mode', 'D:\\code\\blog'), chat('3', 'Notes', null)];

  it('returns everything for a blank query', () => {
    expect(filterChats(chats, '  ')).toBe(chats);
  });

  it('matches the title or project path, ignoring case', () => {
    expect(filterChats(chats, 'LOGIN').map((c) => c.id)).toEqual(['1']);
    expect(filterChats(chats, 'blog').map((c) => c.id)).toEqual(['2']);
  });

  it('requires every word to match', () => {
    expect(filterChats(chats, 'fix shop').map((c) => c.id)).toEqual(['1']);
    expect(filterChats(chats, 'fix blog')).toEqual([]);
  });
});

describe('applyChatEvent', () => {
  it('builds a streamed assistant message and finalizes it', () => {
    const items = run([
      { type: 'assistant-start', id: 'a' },
      { type: 'assistant-delta', id: 'a', text: 'Hel' },
      { type: 'assistant-delta', id: 'a', text: 'lo' },
      { type: 'assistant-end', id: 'a', text: 'Hello.' },
    ]);
    expect(items).toEqual([{ kind: 'assistant', id: 'a', text: 'Hello.', thinking: '', streaming: false }]);
  });

  it('drops empty assistant bubbles from tool-only turns', () => {
    expect(run([{ type: 'assistant-start', id: 'a' }, { type: 'assistant-end', id: 'a', text: '' }])).toEqual([]);
  });

  it('keeps streamed text when ended without final text', () => {
    const items = run([
      { type: 'assistant-start', id: 'a' },
      { type: 'assistant-delta', id: 'a', text: 'partial' },
      { type: 'assistant-end', id: 'a' },
    ]);
    expect(items[0]).toMatchObject({ text: 'partial', streaming: false });
  });

  it('tracks a tool through approval, progress and completion', () => {
    const items = run([
      { type: 'tool-start', id: 't', name: 'run_command', awaitingApproval: true, preview: { title: 'Run', command: 'ls' } },
      { type: 'tool-running', id: 't' },
      { type: 'tool-progress', id: 't', text: 'a\n' },
      { type: 'tool-progress', id: 't', text: 'b\n' },
      { type: 'tool-end', id: 't', status: 'done', summary: 'Ran ls' },
    ]);
    expect(items[0]).toMatchObject({ status: 'done', summary: 'Ran ls', output: 'a\nb\n', preview: { command: 'ls' } });
  });

  it('ignores metadata events', () => {
    expect(run([{ type: 'busy', busy: true }, { type: 'title', title: 'x' }])).toEqual([]);
  });
});

describe('undoing an edit', () => {
  const start: ChatEvent = { type: 'tool-start', id: 't1', name: 'edit_file', awaitingApproval: false };

  it('marks a finished edit that has a backup as undoable, and as undone after the undo', () => {
    const done = run([start, { type: 'tool-end', id: 't1', status: 'done', summary: 'Edited a.ts', path: 'a.ts', undoable: true }]);
    expect(done[0]).toMatchObject({ kind: 'tool', status: 'done', undo: 'available' });

    const undone = run([start, { type: 'tool-end', id: 't1', status: 'done', summary: 'Edited a.ts', undoable: true }, { type: 'tool-undone', id: 't1' }]);
    expect(undone[0]).toMatchObject({ undo: 'undone' });
  });

  it('offers no undo without a backup, for a failed edit, or for a declined one', () => {
    expect(run([start, { type: 'tool-end', id: 't1', status: 'done', summary: 's' }])[0]).not.toHaveProperty('undo');
    expect(run([start, { type: 'tool-end', id: 't1', status: 'error', summary: 's', undoable: true }])[0]).not.toHaveProperty('undo');
    expect(run([start, { type: 'tool-end', id: 't1', status: 'declined', summary: 's', undoable: true }])[0]).not.toHaveProperty('undo');
  });

  it('only marks an edit that could be undone, and leaves other items alone', () => {
    const items = run([
      start,
      { type: 'tool-end', id: 't1', status: 'done', summary: 's' },
      { type: 'user', id: 'u1', text: 'hi', imageCount: 0 },
    ]);
    expect(applyChatEvent(items, { type: 'tool-undone', id: 't1' })).toEqual(items);
    expect(applyChatEvent(items, { type: 'tool-undone', id: 'u1' })).toEqual(items);
    expect(applyChatEvent(items, { type: 'tool-undone', id: 'missing' })).toEqual(items);
  });
});
