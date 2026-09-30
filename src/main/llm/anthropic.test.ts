import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AnthropicCompletionClient, AnthropicConversation, createAnthropicClient } from './anthropic';
import { anthropicStream, MockApiServer } from './test_server';
import type { ToolSpec, TurnRequest } from './types';

const readFileTool: ToolSpec = {
  name: 'read_file',
  description: 'Read a file',
  schema: z.object({ path: z.string() }),
};

function request(overrides: Partial<TurnRequest> = {}): TurnRequest & { streamed: string[] } {
  const streamed: string[] = [];
  return {
    system: 'You are a test.',
    tools: [readFileTool],
    signal: new AbortController().signal,
    callbacks: { onText: (delta) => streamed.push(delta) },
    streamed,
    ...overrides,
  };
}

describe('AnthropicConversation', () => {
  let server: MockApiServer;
  let baseURL: string;

  beforeEach(async () => {
    server = new MockApiServer();
    baseURL = await server.start();
  });

  afterEach(() => server.stop());

  it('streams text and returns tool calls', async () => {
    server.queueSse(
      anthropicStream(
        [
          { type: 'text', text: 'Let me look.' },
          { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.ts' } },
        ],
        'tool_use',
      ),
    );
    const conversation = new AnthropicConversation(createAnthropicClient('sk-test', baseURL), {
      model: 'claude-opus-5-5',
      effort: 'high',
    });
    conversation.addUserMessage({ text: 'Read a.ts' });

    const req = request();
    const result = await conversation.runTurn(req);

    expect(req.streamed.join('')).toBe('Let me look.');
    expect(result.text).toBe('Let me look.');
    expect(result.stopReason).toBe('tool_use');
    expect(result.toolCalls).toEqual([{ id: 'toolu_1', name: 'read_file', input: { path: 'a.ts' } }]);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 7, cacheReadTokens: 4, cacheWriteTokens: 3 });
  });

  it('sends current-model features: adaptive thinking, effort, compaction, fallback, caching, eager tool input', async () => {
    server.queueSse(anthropicStream([{ type: 'text', text: 'ok' }], 'end_turn'));
    const conversation = new AnthropicConversation(createAnthropicClient('sk-test', baseURL), {
      model: 'claude-opus-5-5',
      effort: 'xhigh',
    });
    conversation.addUserMessage({ text: 'hi' });
    await conversation.runTurn(request());

    const { body, headers } = server.requests[0]!;
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(body.output_config).toEqual({ effort: 'xhigh' });
    expect(body.context_management).toEqual({ edits: [{ type: 'compact_20260112' }] });
    expect(body.fallbacks).toBe('default');
    expect(body.cache_control).toEqual({ type: 'ephemeral' });
    expect(body.temperature).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(body.tools[0]).toMatchObject({
      name: 'read_file',
      eager_input_streaming: true,
      input_schema: { type: 'object', required: ['path'] },
    });
    expect(headers['anthropic-beta']).toContain('compact-2026-01-12');
    expect(headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
  });

  it('sends a plain request to models without those features', async () => {
    server.queueSse(anthropicStream([{ type: 'text', text: 'ok' }], 'end_turn'));
    const conversation = new AnthropicConversation(createAnthropicClient('sk-test', baseURL), {
      model: 'claude-haiku-4-5',
      effort: 'high',
    });
    conversation.addUserMessage({ text: 'hi' });
    await conversation.runTurn(request());

    const { body, headers } = server.requests[0]!;
    expect(body.thinking).toBeUndefined();
    expect(body.output_config).toBeUndefined();
    expect(body.context_management).toBeUndefined();
    expect(body.fallbacks).toBeUndefined();
    expect(headers['anthropic-beta']).toBeUndefined();
  });

  it('keeps history append-only and sends all tool results in one user message', async () => {
    server.queueSse(
      anthropicStream(
        [
          { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a' } },
          { type: 'tool_use', id: 'toolu_2', name: 'read_file', input: { path: 'b' } },
        ],
        'tool_use',
      ),
    );
    server.queueSse(anthropicStream([{ type: 'text', text: 'done' }], 'end_turn'));

    const conversation = new AnthropicConversation(createAnthropicClient('sk-test', baseURL), {
      model: 'claude-opus-5-5',
      effort: 'high',
    });
    conversation.addUserMessage({ text: 'Read both' });
    await conversation.runTurn(request());
    conversation.addToolResults([
      { id: 'toolu_1', content: 'A' },
      { id: 'toolu_2', content: 'missing', isError: true },
    ]);
    await conversation.runTurn(request());

    const second = server.requests[1]!.body.messages;
    expect(second).toHaveLength(3);
    // The assistant turn is sent back exactly as it was returned.
    expect(second[1].role).toBe('assistant');
    expect(second[1].content.map((block: any) => [block.type, block.id])).toEqual([
      ['tool_use', 'toolu_1'],
      ['tool_use', 'toolu_2'],
    ]);
    expect(second[2].role).toBe('user');
    expect(second[2].content.map((block: any) => [block.type, block.tool_use_id, block.is_error])).toEqual([
      ['tool_result', 'toolu_1', undefined],
      ['tool_result', 'toolu_2', true],
    ]);
    expect(conversation.serialize().messages).toHaveLength(4);
  });

  it('reports refusals with their explanation', async () => {
    const events = anthropicStream([{ type: 'text', text: '' }], 'refusal');
    const delta = events.find((event) => event.event === 'message_delta')!.data as any;
    delta.delta.stop_details = { type: 'refusal', category: 'cyber', explanation: 'Declined.' };
    server.queueSse(events);

    const conversation = new AnthropicConversation(createAnthropicClient('sk-test', baseURL), {
      model: 'claude-opus-5-5',
      effort: 'high',
    });
    conversation.addUserMessage({ text: 'something' });
    const result = await conversation.runTurn(request());

    expect(result.stopReason).toBe('refusal');
    expect(result.refusal).toBeTruthy();
  });

  it('propagates API errors', async () => {
    server.queueJson(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
    const conversation = new AnthropicConversation(createAnthropicClient('sk-test', baseURL), {
      model: 'claude-opus-5-5',
      effort: 'high',
    });
    conversation.addUserMessage({ text: 'hi' });
    await expect(conversation.runTurn(request())).rejects.toThrow(/invalid x-api-key/);
  });
});

describe('AnthropicCompletionClient', () => {
  it('returns schema-validated structured output without forcing a tool', async () => {
    const server = new MockApiServer();
    const baseURL = await server.start();
    server.queueJson(200, {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5',
      content: [{ type: 'text', text: '{"title":"Fix login bug"}' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 5 },
    });
    const client = new AnthropicCompletionClient(createAnthropicClient('sk-test', baseURL), 'claude-haiku-4-5');
    const result = await client.complete('Title?', z.object({ title: z.string() }));
    await server.stop();

    expect(result).toEqual({ title: 'Fix login bug' });
    const body = server.requests[0]!.body;
    expect(body.output_config.format.type).toBe('json_schema');
    expect(body.tool_choice).toBeUndefined();
  });
});
