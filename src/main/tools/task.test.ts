import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { TurnResult, TurnRequest, UserInput } from '../llm/types';
import type { Conversation, ToolResult } from '../llm/types';
import { SUBAGENT_MAX_TURNS } from '../agent/agent';
import { editFileTool } from './files';
import { defineTool, type ToolContext } from './types';
import { createTaskTool } from './task';
import { Workspace } from './workspace';

type Step = Partial<TurnResult> | ((request: TurnRequest) => Promise<Partial<TurnResult>>);

// Same idea as the agent loop tests: a conversation that replays scripted turns.
class ScriptedConversation implements Conversation {
  readonly provider = 'anthropic' as const;
  readonly model = 'test-model';
  readonly users: UserInput[] = [];
  readonly requests: TurnRequest[] = [];
  turns = 0;

  constructor(private readonly steps: Step[]) {}

  addUserMessage(input: UserInput): void {
    this.users.push(input);
  }

  addToolResults(results: ToolResult[]): void {
    this.toolResults.push(results);
  }

  toolResults: ToolResult[][] = [];

  hasPendingToolCalls(): boolean {
    return false;
  }

  planCompaction() {
    return null;
  }

  applyCompaction(): void {}

  async runTurn(request: TurnRequest): Promise<TurnResult> {
    this.requests.push(request);
    const step = this.steps[this.turns++];
    if (!step) throw new Error('unexpected extra turn');
    const partial = typeof step === 'function' ? await step(request) : step;
    return {
      text: '',
      toolCalls: [],
      contextTokens: 0,
      stopReason: partial.toolCalls?.length ? 'tool_use' : 'end_turn',
      usage: { inputTokens: 2, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      ...partial,
    };
  }

  serialize() {
    return { provider: this.provider, model: this.model, messages: [] };
  }
}

const readTool = defineTool({
  name: 'read_file',
  description: 'read',
  schema: z.object({ path: z.string() }),
  requiresApproval: false,
  async run({ path }, context) {
    context.readFiles.add(context.workspace.resolve(path));
    return { content: 'file contents', summary: `Read ${path}` };
  },
});

function context(signal = new AbortController().signal, readFiles = new Set<string>()): ToolContext {
  return {
    workspace: null as never,
    signal,
    readFiles,
    shell: null as never,
    browser: null,
    codeSearch: null,
    webSearch: null,
    onProgress: () => {},
  };
}

describe('task tool (subagent)', () => {
  it('runs a read-only subagent and returns its answer with usage', async () => {
    const ran: string[] = [];
    const reading = defineTool({
      name: 'read_file',
      description: 'read',
      schema: z.object({ path: z.string() }),
      requiresApproval: false,
      async run({ path }) {
        ran.push(`read:${path}`);
        return { content: 'file contents', summary: `Read ${path}` };
      },
    });
    // Must never run: the subagent only gets the read-only subset.
    const writeTool = defineTool({
      name: 'write_file',
      description: 'write',
      schema: z.object({ path: z.string(), content: z.string() }),
      requiresApproval: true,
      async run() {
        ran.push('write');
        return { content: 'written' };
      },
    });
    const conversation = new ScriptedConversation([
      { toolCalls: [{ id: 't1', name: 'read_file', input: { path: 'a.ts' } }] },
      { text: 'The answer is 42.' },
    ]);
    const taskTool = createTaskTool({
      createConversation: () => conversation,
      system: 'system prompt',
      tools: () => [reading, writeTool],
    });

    const progress: string[] = [];
    const output = await taskTool.run(
      { task: 'Find the answer in a.ts' },
      {
        ...context(),
        onProgress: (text: string) => progress.push(text),
      },
    );

    expect(ran).toEqual(['read:a.ts']);
    expect(output.content).toContain('The answer is 42.');
    expect(output.content).toContain('Subagent token usage: 4 in / 2 out');
    expect(output.isError).toBeUndefined();
    expect(output.summary).toContain('Find the answer in a.ts');
    // Progress lines end with a newline, so the card does not run them together.
    expect(progress).toContain('[done] Read a.ts\n');
    expect(progress).toContain('The answer is 42.\n');
    // The subagent is told it is read-only, instead of inheriting the parent's "edit files" instructions alone.
    expect(conversation.requests[0]?.system).toContain('read-only research subagent');
    expect(conversation.requests[0]?.tools.map((tool) => tool.name)).toEqual(['read_file']);
  });

  it('does not offer write, network, plan or nested task tools', async () => {
    const names = [
      'write_file',
      'edit_file',
      'run_command',
      'fetch_url',
      'browser',
      'propose_plan',
      'task',
      'mcp_docs_search',
    ];
    const tools = names.map((name) =>
      defineTool({
        name,
        description: name,
        schema: z.object({}),
        requiresApproval: false,
        async run() {
          return { content: 'ran' };
        },
      }),
    );
    const conversation = new ScriptedConversation([{ text: 'Nothing to see.' }]);
    const taskTool = createTaskTool({
      createConversation: () => conversation,
      system: 'system prompt',
      tools: () => [readTool, ...tools],
    });
    await taskTool.run({ task: 'Look around' }, context());
    expect(conversation.requests[0]?.tools.map((tool) => tool.name)).toEqual(['read_file']);
  });

  it('does not count a file the subagent read as read by the parent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-task-'));
    try {
      writeFileSync(join(root, 'a.ts'), 'original\n');
      const workspace = new Workspace(root);
      const parentReads = new Set<string>();
      const conversation = new ScriptedConversation([
        { toolCalls: [{ id: 't1', name: 'read_file', input: { path: 'a.ts' } }] },
        { text: 'It says original.' },
      ]);
      const taskTool = createTaskTool({
        createConversation: () => conversation,
        system: 'system prompt',
        tools: () => [readTool],
      });
      await taskTool.run({ task: 'Read a.ts' }, { ...context(), workspace, readFiles: parentReads });

      expect(parentReads.size).toBe(0);
      const preview = editFileTool.preview;
      expect(preview).toBeTypeOf('function');
      await expect(
        preview!(
          { path: 'a.ts', old_string: 'original', new_string: 'changed' },
          { ...context(), workspace, readFiles: parentReads },
        ),
      ).rejects.toThrow(/has not been read/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports an error result when the subagent returns no answer', async () => {
    const taskTool = createTaskTool({
      createConversation: () => new ScriptedConversation([{ text: '' }]),
      system: 'system prompt',
      tools: () => [],
    });
    const output = await taskTool.run({ task: 'Look around' }, context());
    expect(output.isError).toBe(true);
    expect(output.content).toContain('did not finish');
  });

  it('does not treat interim text as the answer when the turn cap is hit', async () => {
    const steps = Array.from({ length: SUBAGENT_MAX_TURNS }, () => ({
      text: 'Let me check the callers…',
      toolCalls: [{ id: 't', name: 'read_file', input: { path: 'a.ts' } }],
    }));
    const taskTool = createTaskTool({
      createConversation: () => new ScriptedConversation(steps),
      system: 'system prompt',
      tools: () => [readTool],
    });
    const output = await taskTool.run({ task: 'Find every caller' }, context());
    expect(output.isError).toBe(true);
    expect(output.content).toContain(`${SUBAGENT_MAX_TURNS}-step limit`);
    expect(output.content).toContain('Let me check the callers');
    expect(output.summary).toContain('stopped');
  });

  it('stops the subagent when the parent task is stopped', async () => {
    const controller = new AbortController();
    const taskTool = createTaskTool({
      createConversation: () =>
        new ScriptedConversation([
          (request) =>
            new Promise((_resolve, reject) => {
              request.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
              controller.abort();
            }),
        ]),
      system: 'system prompt',
      tools: () => [],
    });
    await expect(taskTool.run({ task: 'Look around' }, context(controller.signal))).rejects.toThrow(/stopped/);
  });

  it('reports a stop between turns as an unfinished run, not as the interim text', async () => {
    const controller = new AbortController();
    const taskTool = createTaskTool({
      createConversation: () =>
        new ScriptedConversation([
          () => {
            controller.abort();
            return Promise.resolve({
              text: 'Let me check the callers…',
              toolCalls: [{ id: 't1', name: 'read_file', input: { path: 'a.ts' } }],
            });
          },
        ]),
      system: 'system prompt',
      tools: () => [readTool],
    });
    const output = await taskTool.run({ task: 'Find every caller' }, context(controller.signal));
    expect(output.isError).toBe(true);
    expect(output.content).toContain('it was stopped');
    expect(output.content).toContain('Let me check the callers');
  });

  it('adds the subagent usage to the chat totals', async () => {
    const recorded: number[] = [];
    const taskTool = createTaskTool({
      createConversation: () => new ScriptedConversation([{ text: 'Done.' }]),
      system: 'system prompt',
      tools: () => [],
      recordUsage: (usage) => recorded.push(usage.inputTokens),
    });
    await taskTool.run({ task: 'Look around' }, context());
    expect(recorded).toEqual([2]);
  });
});
