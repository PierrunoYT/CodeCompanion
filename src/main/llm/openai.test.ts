import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createOpenAIClient, OpenAIConversation } from './openai';
import { MockApiServer } from './test_server';
import type { TurnRequest } from './types';

function chunk(delta: object, finishReason: string | null = null, usage?: object) {
  return {
    data: {
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'gpt-test',
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...(usage ? { usage } : {}),
    },
  };
}

function request(): TurnRequest & { streamed: string[] } {
  const streamed: string[] = [];
  return {
    system: 'sys',
    tools: [{ name: 'read_file', description: 'Read', schema: z.object({ path: z.string() }) }],
    signal: new AbortController().signal,
    callbacks: { onText: (delta) => streamed.push(delta) },
    streamed,
  };
}

describe('OpenAIConversation', () => {
  let server: MockApiServer;
  let baseURL: string;

  beforeEach(async () => {
    server = new MockApiServer();
    baseURL = await server.start();
  });

  afterEach(() => server.stop());

  it('streams text and parses tool calls', async () => {
    server.queueSse([
      chunk({ role: 'assistant', content: 'Checking' }),
      chunk({
        tool_calls: [
          { index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } },
        ],
      }),
      chunk({}, 'tool_calls'),
      { data: { id: 'x', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } } },
      { data: '[DONE]' },
    ]);
    const conversation = new OpenAIConversation(createOpenAIClient('sk-test', baseURL), 'gpt-test');
    conversation.addUserMessage({ text: 'read a.ts' });

    const req = request();
    const result = await conversation.runTurn(req);

    expect(req.streamed.join('')).toBe('Checking');
    expect(result.toolCalls).toEqual([{ id: 'call_1', name: 'read_file', input: { path: 'a.ts' } }]);
    expect(result.stopReason).toBe('tool_use');
    expect(result.usage.inputTokens).toBe(5);

    const body = server.requests[0].body;
    expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(body.tools[0].function.parameters).toMatchObject({ type: 'object', required: ['path'] });
  });

  it('marks unparseable tool arguments instead of throwing', async () => {
    server.queueSse([
      chunk({
        role: 'assistant',
        tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":' } }],
      }),
      chunk({}, 'tool_calls'),
      { data: '[DONE]' },
    ]);
    const conversation = new OpenAIConversation(createOpenAIClient('sk-test', baseURL), 'gpt-test');
    conversation.addUserMessage({ text: 'x' });
    const result = await conversation.runTurn(request());
    expect(result.toolCalls[0].input).toEqual({ __invalidJson: '{"path":' });
  });

  it('sends tool screenshots as a follow-up user message', () => {
    const conversation = new OpenAIConversation(createOpenAIClient('sk-test', baseURL), 'gpt-test');
    conversation.addToolResults([
      { id: 'call_1', content: 'Loaded', images: [{ mediaType: 'image/png', base64: 'AAAA' }] },
    ]);
    const messages = conversation.serialize().messages as any[];
    expect(messages[0]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'Loaded' });
    expect(messages[1].role).toBe('user');
    expect(messages[1].content[0].image_url.url).toBe('data:image/png;base64,AAAA');
  });

  it('drops the oldest turns but keeps the task when history grows too large', async () => {
    server.queueSse([chunk({ role: 'assistant', content: 'ok' }), chunk({}, 'stop'), { data: '[DONE]' }]);
    const big = 'x'.repeat(60_000);
    const history = [
      { role: 'user', content: 'THE TASK' },
      ...Array.from({ length: 10 }, (_, i) => [
        { role: 'assistant', content: `answer ${i} ${big}` },
        { role: 'user', content: `follow-up ${i}` },
      ]).flat(),
    ];
    const conversation = new OpenAIConversation(createOpenAIClient('sk-test', baseURL), 'gpt-test', history as any);
    await conversation.runTurn(request());

    const sent = server.requests[0].body.messages;
    expect(sent[1]).toEqual({ role: 'user', content: 'THE TASK' });
    expect(sent[2].content).toContain('removed to fit');
    expect(JSON.stringify(sent).length / 4).toBeLessThan(110_000);
    expect(sent.at(-1).content).toBe('follow-up 9');
  });
});
