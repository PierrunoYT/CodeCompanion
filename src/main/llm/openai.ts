import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import type { z } from 'zod';
import { toolInputSchema } from './tool_schema';
import type {
  CompletionClient,
  Conversation,
  SerializedConversation,
  StopReason,
  ToolCall,
  ToolResult,
  TurnRequest,
  TurnResult,
  UserInput,
} from './types';

type MessageParam = OpenAI.Chat.ChatCompletionMessageParam;

// OpenAI-compatible endpoints have no server-side compaction, so the oldest turns are dropped once the history
// passes this rough size (characters / 4 is close enough to tokens for a budget check).
const MAX_HISTORY_TOKENS = 100_000;

export function createOpenAIClient(apiKey: string, baseURL?: string): OpenAI {
  return new OpenAI({ apiKey, baseURL: baseURL || undefined, maxRetries: 3 });
}

export class OpenAIConversation implements Conversation {
  readonly provider = 'openai' as const;

  constructor(
    private readonly client: OpenAI,
    readonly model: string,
    private messages: MessageParam[] = [],
  ) {}

  addUserMessage(input: UserInput): void {
    if (!input.images?.length) {
      this.messages.push({ role: 'user', content: input.text });
      return;
    }
    this.messages.push({
      role: 'user',
      content: [
        ...input.images.map((image) => ({
          type: 'image_url' as const,
          image_url: { url: `data:${image.mediaType};base64,${image.base64}` },
        })),
        { type: 'text' as const, text: input.text },
      ],
    });
  }

  addToolResults(results: ToolResult[]): void {
    for (const result of results) {
      const prefix = result.isError ? 'Error: ' : '';
      this.messages.push({ role: 'tool', tool_call_id: result.id, content: prefix + (result.content || '(no output)') });
    }
    // Tool messages cannot carry images; screenshots follow as a user message.
    const images = results.flatMap((result) => result.images ?? []);
    if (images.length > 0) {
      this.addUserMessage({ text: 'Images returned by the tool calls above.', images });
    }
  }

  async runTurn(request: TurnRequest): Promise<TurnResult> {
    this.trimHistory();
    const stream = this.client.chat.completions.stream(
      {
        model: this.model,
        messages: [{ role: 'system', content: request.system }, ...this.messages],
        tools: request.tools.map((tool) => ({
          type: 'function' as const,
          function: { name: tool.name, description: tool.description, parameters: toolInputSchema(tool) },
        })),
        stream_options: { include_usage: true },
      },
      { signal: request.signal },
    );
    stream.on('content', (delta) => request.callbacks.onText(delta));

    const completion = await stream.finalChatCompletion();
    const choice = completion.choices[0];
    const message = choice.message;

    const toolCalls: ToolCall[] = (message.tool_calls ?? [])
      .filter((call) => call.type === 'function')
      .map((call) => ({ id: call.id, name: call.function.name, input: parseArguments(call.function.arguments) }));

    this.messages.push({
      role: 'assistant',
      content: message.content ?? '',
      ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}),
    });

    return {
      text: message.content ?? '',
      toolCalls,
      stopReason: mapFinishReason(choice.finish_reason, toolCalls.length > 0),
      usage: {
        inputTokens: completion.usage?.prompt_tokens ?? 0,
        outputTokens: completion.usage?.completion_tokens ?? 0,
        cacheReadTokens: completion.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      },
      refusal: message.refusal ?? undefined,
    };
  }

  serialize(): SerializedConversation {
    return { provider: this.provider, api: 'chat', model: this.model, messages: this.messages };
  }

  // Drops whole turns from the front, keeping the first user message (the task) so the goal is never lost.
  private trimHistory(): void {
    if (estimateTokens(this.messages) <= MAX_HISTORY_TOKENS) return;
    const [first, ...rest] = this.messages;
    const kept = [...rest];
    while (kept.length > 1 && estimateTokens([first, ...kept]) > MAX_HISTORY_TOKENS) {
      kept.shift();
      // A tool or assistant message cannot start the kept history; drop up to the next user message.
      while (kept.length > 1 && kept[0].role !== 'user') kept.shift();
    }
    this.messages = [
      first,
      { role: 'user', content: '(Earlier messages were removed to fit the context window.)' },
      ...kept,
    ];
  }
}

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return { __invalidJson: raw };
  }
}

function estimateTokens(messages: MessageParam[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

function mapFinishReason(reason: string | null, hasToolCalls: boolean): StopReason {
  if (hasToolCalls) return 'tool_use';
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return 'other';
  }
}

export class OpenAICompletionClient implements CompletionClient {
  constructor(
    private readonly client: OpenAI,
    private readonly model: string,
  ) {}

  async complete<T extends z.ZodObject<z.ZodRawShape>>(prompt: string, schema: T, signal?: AbortSignal): Promise<z.infer<T>> {
    const completion = await this.client.chat.completions.parse(
      {
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        response_format: zodResponseFormat(schema, 'result'),
      },
      { signal },
    );
    const parsed = completion.choices[0]?.message.parsed;
    if (!parsed) {
      throw new Error('The model did not return a structured answer.');
    }
    return parsed as z.infer<T>;
  }
}
