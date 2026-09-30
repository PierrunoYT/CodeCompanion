import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ApprovalDecision, ChatEvent } from '@shared/chat';
import type { ApprovalMode } from '@shared/settings';
import type { Conversation, ImageData, ToolResult, TurnRequest, TurnResult, UserInput } from '../llm/types';
import { defineTool, ToolError, type AgentTool, type ToolContext, type ToolOutput } from '../tools/types';
import { Agent } from './agent';

type Step = Partial<TurnResult> | ((request: TurnRequest) => Promise<Partial<TurnResult>>);

// A conversation that replays scripted model turns and records what the agent sent to it, in order.
class ScriptedConversation implements Conversation {
  readonly provider = 'anthropic' as const;
  readonly model = 'test-model';
  readonly log: string[] = [];
  readonly users: UserInput[] = [];
  readonly results: ToolResult[][] = [];
  turns = 0;

  constructor(private readonly steps: Step[] | ((turn: number) => Step)) {}

  addUserMessage(input: UserInput): void {
    this.users.push(input);
    this.log.push(`user:${input.text.slice(0, 12)}`);
  }

  addToolResults(results: ToolResult[]): void {
    this.results.push(results);
    this.log.push(`results:${results.map((result) => result.id).join(',')}`);
  }

  async runTurn(request: TurnRequest): Promise<TurnResult> {
    const turn = this.turns++;
    this.log.push('turn');
    const step = typeof this.steps === 'function' ? this.steps(turn) : this.steps[turn];
    if (!step) throw new Error('unexpected extra turn');
    const partial = typeof step === 'function' ? await step(request) : step;
    if (partial.text) request.callbacks.onText(partial.text);
    return {
      text: '',
      toolCalls: [],
      stopReason: partial.toolCalls?.length ? 'tool_use' : 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
      ...partial,
    };
  }

  serialize() {
    return { provider: this.provider, model: this.model, messages: [] };
  }
}

const image: ImageData = { mediaType: 'image/png', base64: 'AAAA' };

function tool(
  name: string,
  run: (input: Record<string, unknown>, context: ToolContext) => Promise<ToolOutput> | ToolOutput,
  extra: Partial<Pick<AgentTool, 'requiresApproval' | 'preview'>> = {},
): AgentTool {
  return defineTool({
    name,
    description: name,
    schema: z.object({ what: z.string().optional() }),
    requiresApproval: false,
    ...extra,
    async run(input, context) {
      return run(input, context);
    },
  });
}

// A tool that needs a string `what`, to check input validation.
const strict = defineTool({
  name: 'strict',
  description: 'strict',
  schema: z.object({ what: z.string() }),
  requiresApproval: false,
  async run({ what }) {
    return { content: `saw ${what}`, summary: `Saw ${what}`, images: [image] };
  },
});

function setup(
  steps: Step[] | ((turn: number) => Step),
  {
    tools = [] as AgentTool[],
    mode = 'auto' as ApprovalMode,
    requestApproval = vi.fn(async (): Promise<ApprovalDecision> => ({ approved: true })),
  } = {},
) {
  const conversation = new ScriptedConversation(steps);
  const events: ChatEvent[] = [];
  const agent = new Agent({
    conversation,
    system: 'system',
    tools: () => tools,
    approvalMode: () => mode,
    requestApproval,
    toolContext: (signal, onProgress) => ({ signal, onProgress, readFiles: new Set() }) as unknown as ToolContext,
    emit: (event) => events.push(event),
  });
  return { agent, conversation, events, requestApproval };
}

function eventsOf<T extends ChatEvent['type']>(events: ChatEvent[], type: T): Array<Extract<ChatEvent, { type: T }>> {
  return events.filter((event): event is Extract<ChatEvent, { type: T }> => event.type === type);
}

function call(id: string, name: string, input: unknown = {}) {
  return { id, name, input };
}

// Resolves once `started()` has been called, so a test can act while a tool is running.
function signalPair() {
  let started!: () => void;
  const running = new Promise<void>((resolve) => (started = resolve));
  return { started, running };
}

describe('Agent: tool-result pairing', () => {
  it('answers every call, in order, whatever happened to it', async () => {
    const soft = tool('soft', () => ({ content: 'failed softly', isError: true, summary: 'Soft fail' }));
    const denied = tool('denied', () => {
      throw new ToolError('not allowed here');
    });
    const crash = tool('crash', () => {
      throw new Error('kaput');
    });
    const { agent, conversation, events } = setup(
      [
        {
          toolCalls: [
            call('t1', 'strict', { what: 'a' }),
            call('t2', 'missing'),
            call('t3', 'strict', { what: 42 }),
            call('t4', 'denied'),
            call('t5', 'crash'),
            call('t6', 'soft'),
          ],
        },
        { text: 'done' },
      ],
      { tools: [strict, soft, denied, crash] },
    );

    expect(await agent.send({ text: 'go' }, new AbortController().signal)).toBe(false);

    expect(conversation.results).toHaveLength(1);
    expect(conversation.results[0].map((result) => result.id)).toEqual(['t1', 't2', 't3', 't4', 't5', 't6']);
    expect(conversation.results[0]).toMatchObject([
      { content: 'saw a', images: [image] },
      { content: 'Unknown tool: missing', isError: true },
      { isError: true, content: expect.stringMatching(/^Invalid input for strict: what: .*Send every required field/) },
      { content: 'not allowed here', isError: true },
      { content: 'Error: kaput', isError: true },
      { content: 'failed softly', isError: true },
    ]);
    expect(conversation.results[0][0].isError).toBeUndefined();

    // Unknown tools and invalid input never show up as started tools; everything else ends with a status.
    expect(eventsOf(events, 'tool-start').map((event) => event.id)).toEqual(['t1', 't4', 't5', 't6']);
    expect(eventsOf(events, 'tool-end').map((event) => [event.id, event.status, event.summary])).toEqual([
      ['t1', 'done', 'Saw a'],
      ['t4', 'error', 'denied failed'],
      ['t5', 'error', 'crash failed'],
      ['t6', 'error', 'Soft fail'],
    ]);
  });

  it('sends results only after all calls of a turn and before the next model turn', async () => {
    const look = tool('look', () => ({ content: 'ok' }));
    const { agent, conversation } = setup([{ toolCalls: [call('a', 'look'), call('b', 'look')] }, { text: 'done' }], {
      tools: [look],
    });
    await agent.send({ text: 'go' }, new AbortController().signal);
    expect(conversation.log).toEqual(['user:go', 'turn', 'results:a,b', 'turn']);
  });

  it('keeps the transcript event id for a call without an id', async () => {
    const look = tool('look', () => ({ content: 'ok' }));
    const { agent, conversation, events } = setup([{ toolCalls: [call('', 'look')] }, { text: 'done' }], { tools: [look] });
    await agent.send({ text: 'go' }, new AbortController().signal);

    const [start] = eventsOf(events, 'tool-start');
    const [end] = eventsOf(events, 'tool-end');
    expect(start.id).not.toBe('');
    expect(end.id).toBe(start.id);
    expect(conversation.results[0][0].id).toBe('');
  });

  it('streams tool progress and only shows the output of command tools', async () => {
    const runCommand = tool('run_command', (_input, context) => {
      context.onProgress('line 1');
      return { content: 'exit code 0' };
    });
    const look = tool('look', () => ({ content: 'plain result' }));
    const { agent, events } = setup(
      [{ toolCalls: [call('c1', 'run_command'), call('c2', 'look')] }, { text: 'done' }],
      { tools: [runCommand, look] },
    );
    await agent.send({ text: 'go' }, new AbortController().signal);

    expect(eventsOf(events, 'tool-progress')).toEqual([{ type: 'tool-progress', id: 'c1', text: 'line 1' }]);
    expect(eventsOf(events, 'tool-end').map((event) => [event.id, event.output])).toEqual([
      ['c1', 'exit code 0'],
      ['c2', undefined],
    ]);
  });

  it('does not run a tool whose preview fails, and reports the reason', async () => {
    const run = vi.fn(() => ({ content: 'changed' }));
    const edit = tool('edit', run, {
      requiresApproval: true,
      preview: async () => {
        throw new Error('target file is missing');
      },
    });
    const { agent, conversation, events, requestApproval } = setup([{ toolCalls: [call('e1', 'edit')] }, { text: 'ok' }], {
      mode: 'ask',
      tools: [edit],
    });
    await agent.send({ text: 'go' }, new AbortController().signal);

    expect(run).not.toHaveBeenCalled();
    expect(requestApproval).not.toHaveBeenCalled();
    expect(conversation.results[0]).toEqual([{ id: 'e1', content: 'target file is missing', isError: true }]);
    expect(eventsOf(events, 'tool-start')[0]).toMatchObject({ id: 'e1', awaitingApproval: false });
    expect(eventsOf(events, 'tool-end')[0]).toMatchObject({ id: 'e1', status: 'error', output: 'target file is missing' });
  });
});

describe('Agent: approvals', () => {
  it('asks only for tools that need approval in ask mode, passing the call id and the run signal', async () => {
    const look = tool('look', () => ({ content: 'ok' }));
    const change = tool('change', () => ({ content: 'changed' }), { requiresApproval: true });
    const controller = new AbortController();
    const { agent, requestApproval } = setup(
      [{ toolCalls: [call('t1', 'look'), call('t2', 'change')] }, { text: 'done' }],
      { mode: 'ask', tools: [look, change] },
    );
    await agent.send({ text: 'go' }, controller.signal);

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(requestApproval).toHaveBeenCalledWith('t2', controller.signal);
  });

  it('treats a decline with a blank note as a decline without feedback and skips the rest of the turn', async () => {
    const look = tool('look', () => ({ content: 'ok' }));
    const change = tool('change', () => ({ content: 'changed' }), { requiresApproval: true });
    const { agent, conversation, events } = setup(
      [{ toolCalls: [call('t1', 'look'), call('t2', 'change'), call('t3', 'look')] }],
      {
        mode: 'ask',
        tools: [look, change],
        requestApproval: vi.fn(async () => ({ approved: false, feedback: '   ' })),
      },
    );

    expect(await agent.send({ text: 'go' }, new AbortController().signal)).toBe(false);

    expect(conversation.turns).toBe(1);
    expect(conversation.results[0]).toEqual([
      { id: 't1', content: 'ok', isError: undefined, images: undefined },
      { id: 't2', content: 'The user declined this action. Wait for further instructions.', isError: true },
      { id: 't3', content: 'Not run: the user declined an earlier action.', isError: true },
    ]);
    expect(eventsOf(events, 'tool-end').find((event) => event.id === 't2')).toMatchObject({ status: 'declined' });
  });

  it('does not run an approved tool when the stop arrived while waiting', async () => {
    const run = vi.fn(() => ({ content: 'changed' }));
    const change = tool('change', run, { requiresApproval: true });
    const controller = new AbortController();
    const { agent, conversation, events } = setup([{ toolCalls: [call('t1', 'change')] }], {
      mode: 'ask',
      tools: [change],
      requestApproval: vi.fn(async () => {
        controller.abort();
        return { approved: true };
      }),
    });

    expect(await agent.send({ text: 'go' }, controller.signal)).toBe(true);

    expect(run).not.toHaveBeenCalled();
    expect(conversation.results[0][0]).toMatchObject({ id: 't1', isError: true });
    expect(conversation.results[0][0].content).toContain('Stopped by the user before this action was approved');
    expect(eventsOf(events, 'tool-end')[0]).toMatchObject({ status: 'error', summary: 'Stopped' });
  });
});

describe('Agent: stop', () => {
  it('returns at once when the signal is already aborted, without calling the model', async () => {
    const controller = new AbortController();
    controller.abort();
    const { agent, conversation, events } = setup([{ text: 'never' }]);

    expect(await agent.send({ text: 'go' }, controller.signal)).toBe(true);
    expect(conversation.turns).toBe(0);
    expect(events).toEqual([]);
  });

  it('answers the running tool and the calls after it when stopped mid-tool, then ends the run', async () => {
    const controller = new AbortController();
    const { started, running } = signalPair();
    const ran: string[] = [];
    const slow = tool(
      'slow',
      (_input, context) =>
        new Promise<ToolOutput>((resolve) => {
          started();
          context.signal.addEventListener('abort', () => resolve({ content: 'interrupted', isError: true }));
        }),
    );
    const look = tool('look', () => {
      ran.push('look');
      return { content: 'ok' };
    });
    const { agent, conversation } = setup([{ toolCalls: [call('t1', 'slow'), call('t2', 'look')] }, { text: 'never' }], {
      tools: [slow, look],
    });

    const sending = agent.send({ text: 'go' }, controller.signal);
    await running;
    controller.abort();

    expect(await sending).toBe(true);
    expect(ran).toEqual([]);
    expect(conversation.turns).toBe(1);
    expect(conversation.results[0]).toEqual([
      { id: 't1', content: 'interrupted', isError: true, images: undefined },
      { id: 't2', content: 'Not run: the user stopped the task.', isError: true },
    ]);
  });

  it('records the finished results before ending a run that was stopped between turns', async () => {
    const controller = new AbortController();
    const finishAndStop = tool('finish', () => {
      controller.abort();
      return { content: 'finished anyway' };
    });
    const { agent, conversation } = setup([{ toolCalls: [call('t1', 'finish')] }, { text: 'never' }], {
      tools: [finishAndStop],
    });

    expect(await agent.send({ text: 'go' }, controller.signal)).toBe(true);
    expect(conversation.turns).toBe(1);
    expect(conversation.log).toEqual(['user:go', 'turn', 'results:t1']);
  });

  it('rethrows an abort from the model turn after closing the streamed message', async () => {
    const controller = new AbortController();
    const { agent, events } = setup([
      (request) =>
        new Promise((_resolve, reject) => {
          request.callbacks.onText('partial');
          request.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          controller.abort();
        }),
    ]);

    await expect(agent.send({ text: 'go' }, controller.signal)).rejects.toThrow('aborted');
    const start = eventsOf(events, 'assistant-start')[0];
    expect(eventsOf(events, 'assistant-end')).toEqual([{ type: 'assistant-end', id: start.id }]);
  });
});

describe('Agent: resume', () => {
  it('continues after a stopped tool without repeating the request or running the skipped calls', async () => {
    const first = new AbortController();
    const { started, running } = signalPair();
    const ran: string[] = [];
    const slow = tool(
      'slow',
      (_input, context) =>
        new Promise<ToolOutput>((resolve) => {
          started();
          context.signal.addEventListener('abort', () => resolve({ content: 'interrupted', isError: true }));
        }),
    );
    const look = tool('look', () => {
      ran.push('look');
      return { content: 'ok' };
    });
    const { agent, conversation } = setup([{ toolCalls: [call('t1', 'slow'), call('t2', 'look')] }, { text: 'Carried on' }], {
      tools: [slow, look],
    });

    const sending = agent.send({ text: 'go' }, first.signal);
    await running;
    first.abort();
    expect(await sending).toBe(true);

    expect(await agent.resume(new AbortController().signal)).toBe(false);

    // Every call was answered before the continuation message, so the history stays valid for the provider.
    expect(conversation.log).toEqual(['user:go', 'turn', 'results:t1,t2', 'user:Continue the', 'turn']);
    expect(conversation.users[0].text).toBe('go');
    expect(conversation.users[1].text).toContain('do not repeat the original request');
    expect(conversation.users[1].text).toContain('inspect the current state');
    expect(ran).toEqual([]);
  });

  it('reports a stop during a resumed run as interrupted again', async () => {
    const controller = new AbortController();
    controller.abort();
    const { agent, conversation } = setup([{ text: 'never' }]);

    expect(await agent.resume(controller.signal)).toBe(true);
    expect(conversation.turns).toBe(0);
    expect(conversation.users).toHaveLength(1);
  });
});

describe('Agent: error and limit paths', () => {
  it('closes the streamed message and rejects when the model call fails', async () => {
    const { agent, conversation, events } = setup([
      async (request) => {
        request.callbacks.onText('partial');
        throw new Error('connection reset');
      },
    ]);

    await expect(agent.send({ text: 'go' }, new AbortController().signal)).rejects.toThrow('connection reset');

    const [start] = eventsOf(events, 'assistant-start');
    expect(events.map((event) => event.type)).toEqual(['assistant-start', 'assistant-delta', 'assistant-end']);
    expect(eventsOf(events, 'assistant-end')[0]).toEqual({ type: 'assistant-end', id: start.id });
    expect(conversation.results).toEqual([]);
    expect(agent.totals).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  it('keeps the results and usage of earlier turns when a later turn fails', async () => {
    const look = tool('look', () => ({ content: 'ok' }));
    const { agent, conversation } = setup(
      [
        { toolCalls: [call('t1', 'look')], usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 4 } },
        async () => {
          throw new Error('rate limited');
        },
      ],
      { tools: [look] },
    );

    await expect(agent.send({ text: 'go' }, new AbortController().signal)).rejects.toThrow('rate limited');
    expect(conversation.results).toHaveLength(1);
    expect(agent.totals).toMatchObject({ inputTokens: 10, outputTokens: 2, cacheReadTokens: 4 });
  });

  it('does not run tool calls that come with a refusal, and explains the refusal', async () => {
    const run = vi.fn(() => ({ content: 'ran' }));
    const risky = tool('risky', run);
    const { agent, conversation, events } = setup(
      [
        { stopReason: 'refusal', refusal: 'Not able to help with that.', toolCalls: [call('t1', 'risky')] },
        { stopReason: 'refusal', toolCalls: [call('t2', 'risky')] },
      ],
      { tools: [risky] },
    );
    const signal = new AbortController().signal;

    expect(await agent.send({ text: 'one' }, signal)).toBe(false);
    expect(await agent.send({ text: 'two' }, signal)).toBe(false);

    expect(run).not.toHaveBeenCalled();
    expect(conversation.results).toEqual([]);
    expect(eventsOf(events, 'notice').map((event) => event.text)).toEqual([
      'Not able to help with that.',
      'The model declined this request.',
    ]);
  });

  it('tells the user when the conversation is too long or the answer was cut off', async () => {
    const { agent, events } = setup([{ stopReason: 'context_exceeded' }, { stopReason: 'max_tokens', text: 'half an ans' }]);
    const signal = new AbortController().signal;

    expect(await agent.send({ text: 'one' }, signal)).toBe(false);
    expect(await agent.send({ text: 'two' }, signal)).toBe(false);

    expect(eventsOf(events, 'notice').map((event) => event.text)).toEqual([
      'The conversation is too long for the model. Start a new chat.',
      'The response hit the output limit and may be incomplete.',
    ]);
  });

  it('gives up after 200 model turns of tool calls', async () => {
    const look = tool('look', () => ({ content: 'ok' }));
    const { agent, conversation, events } = setup((turn) => ({ toolCalls: [call(`t${turn}`, 'look')] }), { tools: [look] });

    expect(await agent.send({ text: 'go' }, new AbortController().signal)).toBe(false);

    expect(conversation.turns).toBe(200);
    expect(conversation.results).toHaveLength(200);
    expect(eventsOf(events, 'notice').map((event) => event.text)).toEqual(['Stopped after 200 steps.']);
  });
});

describe('Agent: streaming and usage', () => {
  it('routes streamed text, thinking and restarts to one message id', async () => {
    const { agent, events } = setup([
      async (request) => {
        request.callbacks.onThinking?.('hmm');
        request.callbacks.onText('draft');
        request.callbacks.onRestart?.();
        // The scripted conversation streams the returned text after this step, as the final delta.
        return { text: 'final' };
      },
    ]);
    await agent.send({ text: 'go' }, new AbortController().signal);

    const [start] = eventsOf(events, 'assistant-start');
    expect(events.filter((event) => event.type !== 'usage')).toEqual([
      { type: 'assistant-start', id: start.id },
      { type: 'thinking-delta', id: start.id, text: 'hmm' },
      { type: 'assistant-delta', id: start.id, text: 'draft' },
      { type: 'assistant-restart', id: start.id },
      { type: 'assistant-delta', id: start.id, text: 'final' },
      { type: 'assistant-end', id: start.id, text: 'final' },
    ]);
  });

  it('adds up usage over the turns of a task and emits the running totals', async () => {
    const look = tool('look', () => ({ content: 'ok' }));
    const { agent, events } = setup(
      [
        { toolCalls: [call('t1', 'look')], usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1 } },
        { text: 'done', usage: { inputTokens: 20, outputTokens: 3, cacheReadTokens: 6 } },
      ],
      { tools: [look] },
    );
    await agent.send({ text: 'go' }, new AbortController().signal);

    const expected = { inputTokens: 30, outputTokens: 5, cacheReadTokens: 10, cacheWriteTokens: 1 };
    expect(agent.totals).toEqual(expected);
    expect(eventsOf(events, 'usage').map((event) => event.totals.inputTokens)).toEqual([10, 30]);
    // Totals are copies, so callers cannot change the running count.
    agent.totals.inputTokens = 999;
    expect(agent.totals).toEqual(expected);
  });
});
