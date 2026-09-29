import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';
import { claudeCapabilities, type Effort } from '@shared/models';
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

type MessageParam = Anthropic.Beta.BetaMessageParam;
type ContentBlockParam = Anthropic.Beta.BetaContentBlockParam;

const MAX_OUTPUT_TOKENS = 64_000;
// A tool input that is not parseable JSON makes finalMessage() reject; the turn is re-issued this many times.
const MAX_JSON_RETRIES = 2;
// Compaction and pause_turn return control mid-turn; the turn is continued this many times at most.
const MAX_CONTINUATIONS = 5;

// The SDK runs in the Electron main process (Node), never in the renderer. baseURL is only overridden in tests.
export function createAnthropicClient(apiKey: string, baseURL?: string): Anthropic {
  return new Anthropic({ apiKey, baseURL, maxRetries: 3 });
}

export interface AnthropicConversationOptions {
  model: string;
  effort: Effort;
  messages?: MessageParam[];
}

// History is append-only: assistant turns are stored exactly as returned (thinking, compaction and fallback
// blocks included) because Claude rejects or ignores edited history. Long chats are shortened by the API's
// server-side compaction instead of by rewriting old messages.
export class AnthropicConversation implements Conversation {
  readonly provider = 'anthropic' as const;
  readonly model: string;
  private readonly effort: Effort;
  private readonly messages: MessageParam[];

  constructor(
    private readonly client: Anthropic,
    options: AnthropicConversationOptions,
  ) {
    this.model = options.model;
    this.effort = options.effort;
    this.messages = options.messages ?? [];
  }

  addUserMessage(input: UserInput): void {
    const content: ContentBlockParam[] = [
      ...(input.images ?? []).map(
        (image): ContentBlockParam => ({
          type: 'image',
          source: { type: 'base64', media_type: image.mediaType, data: image.base64 },
        }),
      ),
      { type: 'text', text: input.text },
    ];
    this.messages.push({ role: 'user', content });
  }

  // All results of one assistant turn go back in a single user message, as the API expects for parallel calls.
  addToolResults(results: ToolResult[]): void {
    const content: ContentBlockParam[] = results.map((result) => ({
      type: 'tool_result',
      tool_use_id: result.id,
      is_error: result.isError || undefined,
      content: [
        ...(result.images ?? []).map((image) => ({
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: image.mediaType, data: image.base64 },
        })),
        { type: 'text' as const, text: result.content || '(no output)' },
      ],
    }));
    this.messages.push({ role: 'user', content });
  }

  async runTurn(request: TurnRequest): Promise<TurnResult> {
    const text: string[] = [];
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let jsonRetries = 0;
    let continuations = 0;

    while (true) {
      const stream = this.client.beta.messages.stream(this.buildParams(request), { signal: request.signal });
      stream.on('text', (delta) => request.callbacks.onText(delta));
      stream.on('thinking', (delta) => request.callbacks.onThinking?.(delta));

      let message: Anthropic.Beta.BetaMessage;
      try {
        message = await stream.finalMessage();
      } catch (error) {
        // Only an unparseable streamed tool input is retried; API and abort errors propagate.
        if (error instanceof Anthropic.APIError || request.signal.aborted || jsonRetries++ >= MAX_JSON_RETRIES) {
          throw error;
        }
        request.callbacks.onRestart?.();
        continue;
      }

      usage.inputTokens += message.usage.input_tokens;
      usage.outputTokens += message.usage.output_tokens;
      usage.cacheReadTokens += message.usage.cache_read_input_tokens ?? 0;
      usage.cacheWriteTokens += message.usage.cache_creation_input_tokens ?? 0;
      this.messages.push({ role: 'assistant', content: message.content as ContentBlockParam[] });

      for (const block of message.content) {
        if (block.type === 'text') text.push(block.text);
      }

      if ((message.stop_reason === 'compaction' || message.stop_reason === 'pause_turn') && continuations < MAX_CONTINUATIONS) {
        continuations++;
        continue;
      }

      const toolCalls: ToolCall[] = message.content
        .filter((block): block is Anthropic.Beta.BetaToolUseBlock => block.type === 'tool_use')
        .map((block) => ({ id: block.id, name: block.name, input: block.input }));

      return {
        text: text.join('\n\n'),
        toolCalls,
        stopReason: mapStopReason(message.stop_reason),
        usage,
        refusal:
          message.stop_reason === 'refusal'
            ? (message.stop_details?.explanation ?? 'The model declined to continue this request.')
            : undefined,
      };
    }
  }

  serialize(): SerializedConversation {
    return { provider: this.provider, model: this.model, messages: this.messages };
  }

  // Exposed for tests.
  buildParams(request: Pick<TurnRequest, 'system' | 'tools'>): Anthropic.Beta.MessageCreateParamsStreaming {
    const capabilities = claudeCapabilities(this.model);
    const betas: Anthropic.Beta.AnthropicBeta[] = [];

    const params: Anthropic.Beta.MessageCreateParamsStreaming = {
      model: this.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      stream: true,
      system: [{ type: 'text', text: request.system }],
      messages: this.messages,
      tools: request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: toolInputSchema(tool),
        // Stream large inputs (file contents) as they are generated. The API no longer validates them, so the
        // agent validates every input against the tool's schema before running it.
        eager_input_streaming: true,
      })),
      // Caches the stable prefix (tools, system prompt, earlier turns) between turns.
      cache_control: { type: 'ephemeral' },
    };

    if (capabilities.adaptiveThinking) {
      params.thinking = { type: 'adaptive', display: 'summarized' };
      params.output_config = { effort: this.effort };
    }
    if (capabilities.compaction) {
      betas.push('compact-2026-01-12');
      params.context_management = { edits: [{ type: 'compact_20260112' }] };
    }
    if (capabilities.refusalFallback) {
      betas.push('server-side-fallback-2026-07-01');
      params.fallbacks = 'default';
    }
    if (betas.length > 0) {
      params.betas = betas;
    }
    return params;
  }
}

function mapStopReason(reason: Anthropic.Beta.BetaStopReason | null): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    case 'model_context_window_exceeded':
      return 'context_exceeded';
    default:
      return 'other';
  }
}

export class AnthropicCompletionClient implements CompletionClient {
  constructor(
    private readonly client: Anthropic,
    private readonly model: string,
  ) {}

  async complete<T extends z.ZodObject<z.ZodRawShape>>(prompt: string, schema: T, signal?: AbortSignal): Promise<z.infer<T>> {
    const response = await this.client.messages.parse(
      {
        model: this.model,
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
        output_config: { format: zodOutputFormat(schema) },
      },
      { signal },
    );
    if (response.stop_reason === 'refusal' || !response.parsed_output) {
      throw new Error('The model did not return a structured answer.');
    }
    return response.parsed_output as z.infer<T>;
  }
}
