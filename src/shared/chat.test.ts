import { describe, expect, it } from 'vitest';
import { applyChatEvent, type ChatEvent, type TranscriptItem } from './chat';

const run = (events: ChatEvent[]) => events.reduce<TranscriptItem[]>(applyChatEvent, []);

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
