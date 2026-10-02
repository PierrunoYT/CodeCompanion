import { z } from 'zod';
import { defineTool, ToolError, type AgentTool } from './types';

export type TodoStatus = 'todo' | 'in_progress' | 'done';

export interface TodoItem {
  id: number;
  title: string;
  status: TodoStatus;
}

const MAX_ITEMS = 50;
const MARKS: Record<TodoStatus, string> = { todo: '[ ]', in_progress: '[~]', done: '[x]' };

export function formatTodos(items: TodoItem[]): string {
  if (items.length === 0) return 'The todo list is empty.';
  return items.map((item) => `${MARKS[item.status]} ${item.id}. ${item.title}`).join('\n');
}

// A checklist the model keeps while it works through a multi-step task. It lives in memory for one chat: nothing is
// written to disk, the whole list is shown on the tool's card, and the model always gets the full list back.
export function createTodoTool(): AgentTool {
  const items: TodoItem[] = [];
  let nextId = 1;

  const find = (id: number | undefined): TodoItem => {
    const item = items.find((candidate) => candidate.id === id);
    if (!item) throw new ToolError(`There is no todo with id ${id ?? '(none given)'}. Use action "list" to see them.`);
    return item;
  };

  return defineTool({
    name: 'todo_list',
    description:
      'Keep a checklist for a multi-step task. Add the steps when you start, mark one in_progress while you work on it and done when it is finished, so the user can follow your progress. Actions: add (titles), update (id, status and/or title), remove (id), list. The tool returns the whole list each time. Skip it for one-step requests.',
    schema: z.object({
      action: z.enum(['add', 'update', 'remove', 'list']),
      titles: z.array(z.string().min(1)).min(1).optional().describe('For add: the steps to append.'),
      id: z.number().int().optional().describe('For update and remove: the number shown in the list.'),
      status: z.enum(['todo', 'in_progress', 'done']).optional().describe('For update: the new status.'),
      title: z.string().min(1).optional().describe('For update: a new title.'),
    }),
    requiresApproval: false,
    async run({ action, titles, id, status, title }) {
      if (action === 'add') {
        if (!titles) throw new ToolError('add needs "titles", the steps to append.');
        if (items.length + titles.length > MAX_ITEMS)
          throw new ToolError(`A todo list holds at most ${MAX_ITEMS} items.`);
        for (const text of titles) items.push({ id: nextId++, title: text.trim(), status: 'todo' });
      } else if (action === 'update') {
        const item = find(id);
        if (status === undefined && title === undefined) throw new ToolError('update needs a "status" or a "title".');
        if (status) item.status = status;
        if (title) item.title = title.trim();
      } else if (action === 'remove') {
        items.splice(items.indexOf(find(id)), 1);
      }
      const done = items.filter((item) => item.status === 'done').length;
      return {
        content: formatTodos(items),
        summary: items.length === 0 ? 'Todo list (empty)' : `Todo list (${done}/${items.length} done)`,
      };
    },
  });
}
