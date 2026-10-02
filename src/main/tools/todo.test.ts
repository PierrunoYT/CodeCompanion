import { describe, expect, it } from 'vitest';
import { createTodoTool, formatTodos } from './todo';
import type { ToolContext } from './types';

function setup() {
  const tool = createTodoTool();
  return (input: object) => tool.run(tool.schema!.parse(input), {} as ToolContext);
}

describe('todo_list', () => {
  it('adds, updates, removes and lists, returning the whole list each time', async () => {
    const call = setup();
    expect((await call({ action: 'list' })).content).toBe('The todo list is empty.');

    const added = await call({ action: 'add', titles: ['Write the parser', 'Add tests'] });
    expect(added.content).toBe('[ ] 1. Write the parser\n[ ] 2. Add tests');
    expect(added.summary).toBe('Todo list (0/2 done)');

    await call({ action: 'update', id: 1, status: 'in_progress' });
    const updated = await call({ action: 'update', id: 1, status: 'done', title: 'Write the lexer' });
    expect(updated.content).toBe('[x] 1. Write the lexer\n[ ] 2. Add tests');
    expect(updated.summary).toBe('Todo list (1/2 done)');

    const removed = await call({ action: 'remove', id: 2 });
    expect(removed.content).toBe('[x] 1. Write the lexer');
    // Ids are not reused.
    expect((await call({ action: 'add', titles: ['More'] })).content).toContain('[ ] 3. More');
  });

  it('keeps a separate list per tool instance', async () => {
    const first = setup();
    const second = setup();
    await first({ action: 'add', titles: ['only here'] });
    expect((await second({ action: 'list' })).content).toBe('The todo list is empty.');
  });

  it('explains mistakes', async () => {
    const call = setup();
    await expect(call({ action: 'add' })).rejects.toThrow('titles');
    await expect(call({ action: 'update', id: 9, status: 'done' })).rejects.toThrow('no todo with id 9');
    await call({ action: 'add', titles: ['a'] });
    await expect(call({ action: 'update', id: 1 })).rejects.toThrow('status');
    await expect(call({ action: 'add', titles: Array.from({ length: 60 }, () => 'x') })).rejects.toThrow('at most');
  });

  it('formats in-progress items', () => {
    expect(formatTodos([{ id: 1, title: 'a', status: 'in_progress' }])).toBe('[~] 1. a');
  });
});
