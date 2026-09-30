import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ChatEvent, UsageTotals } from '@shared/chat';
import type { ApprovalMode } from '@shared/settings';
import type { Conversation, ToolResult, TurnRequest, TurnResult, UserInput } from '../llm/types';
import { defineTool, type AgentTool, type ToolContext } from '../tools/types';
import { ChatSession, type ChatSessionOptions } from './session';

type Step = Partial<TurnResult> | ((request: TurnRequest) => Promise<Partial<TurnResult>>);

class ScriptedConversation implements Conversation {
  readonly provider: 'anthropic' | 'openai';
  readonly model = 'test-model';
  readonly users: UserInput[] = [];
  readonly toolResults: ToolResult[][] = [];
  turns = 0;

  constructor(
    private readonly steps: Step[],
    provider: 'anthropic' | 'openai' = 'anthropic',
  ) {
    this.provider = provider;
  }

  addUserMessage(input: UserInput): void {
    this.users.push(input);
  }

  addToolResults(results: ToolResult[]): void {
    this.toolResults.push(results);
  }

  async runTurn(request: TurnRequest): Promise<TurnResult> {
    const step = this.steps[this.turns++];
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

const ran: string[] = [];

const lookTool = defineTool({
  name: 'look',
  description: 'read-only',
  schema: z.object({ what: z.string() }),
  requiresApproval: false,
  async run({ what }) {
    ran.push(`look:${what}`);
    return { content: `saw ${what}`, summary: `Looked at ${what}` };
  },
});

const changeTool = defineTool({
  name: 'change',
  description: 'needs approval',
  schema: z.object({ to: z.string() }),
  requiresApproval: true,
  async preview({ to }) {
    return { title: `Change to ${to}`, diff: `+${to}` };
  },
  async run({ to }) {
    ran.push(`change:${to}`);
    return { content: `changed to ${to}` };
  },
});

function setup(
  steps: Step[],
  {
    mode = 'ask' as ApprovalMode,
    tools = () => [lookTool, changeTool] as AgentTool[],
    isPreApproved = undefined as ((toolName: string, input: unknown) => boolean) | undefined,
    usage = undefined as UsageTotals | undefined,
    provider = 'anthropic' as 'anthropic' | 'openai',
    officialPricing = undefined as boolean | undefined,
    resumable = undefined as boolean | undefined,
    transcript = undefined as ChatSessionOptions['transcript'],
  } = {},
) {
  ran.length = 0;
  const conversation = new ScriptedConversation(steps, provider);
  const events: ChatEvent[] = [];
  const session = new ChatSession({
    projectPath: '/project',
    conversation,
    officialPricing,
    system: 'system prompt',
    agentFile: null,
    tools,
    usage,
    resumable,
    transcript,
    approvalMode: () => mode,
    isPreApproved,
    toolContext: (base) =>
      ({
        ...base,
        workspace: null as never,
        shell: null as never,
        browser: null,
        codeSearch: null,
        webSearch: null,
      }) as ToolContext,
    smallModel: () => null,
    onEvent: (event) => events.push(event),
    onChange: () => {},
  });
  const nextApproval = () =>
    new Promise<string>((resolve) => {
      const check = () => {
        const pending = session
          .snapshot()
          .transcript.find((item) => item.kind === 'tool' && item.status === 'awaiting-approval');
        if (pending) resolve(pending.id);
        else setTimeout(check, 5);
      };
      check();
    });
  return { conversation, session, events, nextApproval };
}

describe('agent loop', () => {
  it('answers without tools', async () => {
    const { session } = setup([{ text: 'Hello!' }]);
    await session.send({ text: 'hi' });
    const kinds = session.snapshot().transcript.map((item) => [item.kind, 'text' in item ? item.text : '']);
    expect(kinds).toEqual([
      ['user', 'hi'],
      ['assistant', 'Hello!'],
    ]);
    expect(session.busy).toBe(false);
  });

  it('runs read-only tools without approval and feeds results back', async () => {
    const { session, conversation } = setup([
      { text: 'Looking', toolCalls: [{ id: 't1', name: 'look', input: { what: 'a' } }] },
      { text: 'Done' },
    ]);
    await session.send({ text: 'go' });
    expect(ran).toEqual(['look:a']);
    expect(conversation.toolResults).toEqual([[{ id: 't1', content: 'saw a', isError: undefined, images: undefined }]]);
    const tool = session.snapshot().transcript.find((item) => item.kind === 'tool');
    expect(tool).toMatchObject({ status: 'done', summary: 'Looked at a' });
  });

  it('runs a call the user allowed in advance without asking, and still asks for the others', async () => {
    const { session, events } = setup(
      [{ toolCalls: [{ id: 't1', name: 'change', input: { to: 'allowed' } }] }, { text: 'ok' }],
      { isPreApproved: (name, input) => name === 'change' && (input as { to: string }).to === 'allowed' },
    );
    await session.send({ text: 'go' });
    expect(ran).toEqual(['change:allowed']);
    const start = events.find((event) => event.type === 'tool-start');
    expect(start).toMatchObject({ awaitingApproval: false, preview: { title: 'Change to allowed' } });
  });

  it('waits for approval and shows a preview', async () => {
    const { session, nextApproval } = setup([
      { toolCalls: [{ id: 't1', name: 'change', input: { to: 'x' } }] },
      { text: 'ok' },
    ]);
    const sending = session.send({ text: 'change it' });
    const id = await nextApproval();
    const pending = session.snapshot().transcript.find((item) => item.id === id);
    expect(pending).toMatchObject({ preview: { title: 'Change to x', diff: '+x' } });
    expect(ran).toEqual([]);

    session.decide(id, { approved: true });
    await sending;
    expect(ran).toEqual(['change:x']);
  });

  it('stops when the user declines without feedback, and skips remaining calls', async () => {
    const { session, conversation, nextApproval } = setup([
      {
        toolCalls: [
          { id: 't1', name: 'change', input: { to: 'x' } },
          { id: 't2', name: 'look', input: { what: 'b' } },
        ],
      },
    ]);
    const sending = session.send({ text: 'change it' });
    session.decide(await nextApproval(), { approved: false });
    await sending;

    expect(ran).toEqual([]);
    expect(conversation.turns).toBe(1);
    expect(conversation.toolResults[0].map((result) => [result.id, result.isError])).toEqual([
      ['t1', true],
      ['t2', true],
    ]);
  });

  it('continues with the user feedback when declining with a note', async () => {
    const { session, conversation, nextApproval } = setup([
      { toolCalls: [{ id: 't1', name: 'change', input: { to: 'x' } }] },
      { text: 'Understood, using y instead.' },
    ]);
    const sending = session.send({ text: 'change it' });
    session.decide(await nextApproval(), { approved: false, feedback: 'use y' });
    await sending;

    expect(conversation.turns).toBe(2);
    expect(conversation.toolResults[0][0].content).toContain('use y');
  });

  it('skips approval in auto mode', async () => {
    const { session } = setup([{ toolCalls: [{ id: 't1', name: 'change', input: { to: 'z' } }] }, { text: 'done' }], {
      mode: 'auto',
    });
    await session.send({ text: 'go' });
    expect(ran).toEqual(['change:z']);
  });

  it('rejects invalid tool input without running the tool', async () => {
    const { session, conversation } = setup([
      { toolCalls: [{ id: 't1', name: 'look', input: { what: 42 } }] },
      { text: 'retrying' },
    ]);
    await session.send({ text: 'go' });
    expect(ran).toEqual([]);
    expect(conversation.toolResults[0][0]).toMatchObject({ isError: true });
    expect(conversation.toolResults[0][0].content).toContain('Invalid input for look');
  });

  it('names missing fields and the fields that were received', async () => {
    const { session, conversation } = setup([
      { toolCalls: [{ id: 't1', name: 'change', input: {} }] },
      { text: 'retrying' },
    ]);
    await session.send({ text: 'go' });
    const content = conversation.toolResults[0][0].content;
    expect(content).toContain('required but missing');
    expect(content).toContain('Received fields: (none)');
  });

  it('does not run tool calls from a response cut off at the output limit', async () => {
    const { session, conversation } = setup([
      { stopReason: 'max_tokens', toolCalls: [{ id: 't1', name: 'look', input: { what: 'a' } }] },
      { text: 'smaller' },
    ]);
    await session.send({ text: 'go' });
    expect(ran).toEqual([]);
    expect(conversation.toolResults[0][0].content).toContain('output limit');
  });

  it('answers every pending call when stopped during approval', async () => {
    const { session, conversation, nextApproval } = setup([
      {
        toolCalls: [
          { id: 't1', name: 'change', input: { to: 'x' } },
          { id: 't2', name: 'look', input: { what: 'b' } },
        ],
      },
    ]);
    const sending = session.send({ text: 'go' });
    await nextApproval();
    session.stop();
    await sending;

    expect(conversation.toolResults[0]).toHaveLength(2);
    expect(session.busy).toBe(false);
    expect(ran).toEqual([]);
  });

  it('resumes after stopping during approval without rerunning the saved calls or duplicating the user message', async () => {
    const { session, conversation, nextApproval } = setup([
      {
        toolCalls: [
          { id: 't1', name: 'change', input: { to: 'x' } },
          { id: 't2', name: 'look', input: { what: 'b' } },
        ],
      },
      { text: 'Continued safely.' },
    ]);
    const sending = session.send({ text: 'change it' });
    await nextApproval();
    session.stop();
    await sending;

    expect(session.snapshot().resumable).toBe(true);
    expect(conversation.toolResults[0]).toHaveLength(2);
    await session.resume();

    expect(ran).toEqual([]);
    expect(conversation.users).toHaveLength(2);
    expect(conversation.users[0].text).toBe('change it');
    expect(conversation.users[1].text).toContain('inspect the current state');
    expect(session.snapshot().transcript.filter((item) => item.kind === 'user')).toHaveLength(1);
    expect(session.snapshot().resumable).toBe(false);
  });

  it('resumes an aborted streaming turn and prevents simultaneous or duplicate resumes', async () => {
    const { session, conversation } = setup([
      (request) =>
        new Promise((_resolve, reject) => {
          request.callbacks.onText('partial');
          request.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { text: 'finished' };
      },
    ]);
    const sending = session.send({ text: 'start once' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    session.stop();
    await sending;

    const resuming = session.resume();
    await expect(session.resume()).rejects.toThrow(/still working/);
    await resuming;
    await expect(session.resume()).rejects.toThrow(/no stopped run/);
    expect(conversation.users.map((user) => user.text).filter((text) => text === 'start once')).toHaveLength(1);
  });

  it('persists resumable state for a reopened chat', async () => {
    const first = setup([
      (request) =>
        new Promise((_resolve, reject) =>
          request.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
        ),
    ]);
    const sending = first.session.send({ text: 'pause me' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    first.session.stop();
    await sending;
    const saved = first.session.serialize();

    const reopened = setup([{ text: 'continued after reopen' }], {
      resumable: saved.resumable,
      transcript: saved.transcript,
    });
    expect(reopened.session.snapshot().resumable).toBe(true);
    await reopened.session.resume();
    expect(reopened.session.snapshot().transcript.filter((item) => item.kind === 'user')).toHaveLength(1);
  });

  it('shows model errors in the transcript', async () => {
    const { session } = setup([
      async () => {
        throw new Error('401 invalid x-api-key');
      },
    ]);
    await session.send({ text: 'go' });
    const last = session.snapshot().transcript.at(-1);
    expect(last).toMatchObject({ kind: 'error', text: '401 invalid x-api-key' });
    expect(session.busy).toBe(false);
  });

  it('reports refusals as a notice', async () => {
    const { session } = setup([{ stopReason: 'refusal', refusal: 'Declined for safety.' }]);
    await session.send({ text: 'go' });
    expect(session.snapshot().transcript.at(-1)).toMatchObject({ kind: 'notice', text: 'Declined for safety.' });
  });

  it('keeps streamed text when a turn fails midway', async () => {
    const { session } = setup([
      async (request) => {
        request.callbacks.onText('partial answer');
        throw new Error('connection reset');
      },
    ]);
    await session.send({ text: 'go' });
    const assistant = session.snapshot().transcript.find((item) => item.kind === 'assistant');
    expect(assistant).toMatchObject({ text: 'partial answer', streaming: false });
  });

  it('refuses a second message while busy', async () => {
    const { session, nextApproval } = setup([{ toolCalls: [{ id: 't1', name: 'change', input: { to: 'x' } }] }]);
    const sending = session.send({ text: 'first' });
    await nextApproval();
    await expect(session.send({ text: 'second' })).rejects.toThrow(/still working/);
    session.stop();
    await sending;
  });

  it('offers tools that become available while the chat is open', async () => {
    let available: AgentTool[] = [lookTool];
    const offered: string[][] = [];
    const record = (request: TurnRequest, result: Partial<TurnResult>) => {
      offered.push(request.tools.map((tool) => tool.name));
      return Promise.resolve(result);
    };
    const { session } = setup(
      [(request) => record(request, { text: 'one' }), (request) => record(request, { text: 'two' })],
      { tools: () => available },
    );
    await session.send({ text: 'first' });
    available = [lookTool, changeTool];
    await session.send({ text: 'second' });
    expect(offered).toEqual([['look'], ['look', 'change']]);
  });

  it('runs a tool added mid-chat within the same task', async () => {
    let available: AgentTool[] = [lookTool];
    const { session } = setup(
      [
        () => {
          available = [lookTool, changeTool];
          return Promise.resolve({ toolCalls: [{ id: 't1', name: 'look', input: { what: 'a' } }] });
        },
        { toolCalls: [{ id: 't2', name: 'change', input: { to: 'x' } }] },
        { text: 'done' },
      ],
      { mode: 'auto', tools: () => available },
    );
    await session.send({ text: 'go' });
    expect(ran).toEqual(['look:a', 'change:x']);
  });

  it('serializes and tracks usage', async () => {
    const { session } = setup([
      {
        text: 'a',
        usage: {
          inputTokens: 7,
          outputTokens: 5,
          cacheReadTokens: 3,
          cacheWriteTokens: 2,
          longContext: true,
        },
      },
    ]);
    await session.send({ text: 'hi' });
    const saved = session.serialize();
    expect(saved.usage).toEqual({
      inputTokens: 7,
      outputTokens: 5,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
      longContext: { inputTokens: 7, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2 },
    });
    expect(saved.system).toBe('system prompt');
    expect(saved.transcript).toHaveLength(2);
  });

  it('restores legacy saved usage without cache writes', () => {
    const { session } = setup([], { usage: { inputTokens: 7, outputTokens: 5, cacheReadTokens: 3 } });
    expect(session.snapshot().usage).toEqual({
      inputTokens: 7,
      outputTokens: 5,
      cacheReadTokens: 3,
      cacheWriteTokens: 0,
    });
  });

  it('normalizes legacy OpenAI input exactly once and suppresses custom endpoint pricing', () => {
    const { session } = setup([], {
      provider: 'openai',
      officialPricing: false,
      usage: { inputTokens: 17, outputTokens: 5, cacheReadTokens: 3 },
    });
    expect(session.snapshot().usage.inputTokens).toBe(14);
    expect(session.snapshot().officialPricing).toBe(false);
    const restored = setup([], { provider: 'openai', usage: session.serialize().usage });
    expect(restored.session.snapshot().usage.inputTokens).toBe(14);
  });

  it('accumulates multiple long requests without mutating earlier snapshots', async () => {
    const usage = {
      inputTokens: 280_000,
      outputTokens: 17,
      cacheReadTokens: 3,
      cacheWriteTokens: 5,
      longContext: true,
    };
    const { session } = setup([
      { text: 'first', usage },
      { text: 'second', usage },
    ]);
    await session.send({ text: 'one' });
    const first = session.snapshot();
    await session.send({ text: 'two' });
    expect(first.usage.longContext?.inputTokens).toBe(280_000);
    expect(session.snapshot().usage.longContext?.inputTokens).toBe(560_000);
  });
});
