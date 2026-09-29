import type OpenAI from 'openai';
import type { Effort } from '@shared/models';
import { toolInputSchema } from './tool_schema';
import type {
  Conversation,
  SerializedConversation,
  StopReason,
  ToolCall,
  ToolResult,
  TurnRequest,
  TurnResult,
  UserInput,
} from './types';

type InputItem = OpenAI.Responses.ResponseInputItem;

// OpenAI's own API, through the Responses API. Used instead of Chat Completions because current OpenAI models
// (GPT-6) only support function calling there with reasoning enabled.
//
// Nothing is stored on OpenAI's side (store: false). Reasoning items come back encrypted and are sent back
// unchanged with the rest of the history, so the model keeps its reasoning across tool calls. When the history
// outgrows the context window, truncation: 'auto' drops the oldest items.
export class OpenAIResponsesConversation implements Conversation {
  readonly provider = 'openai' as const;

  constructor(
    private readonly client: OpenAI,
    readonly model: string,
    private readonly effort: Effort,
    private readonly items: InputItem[] = [],
  ) {}

  addUserMessage(input: UserInput): void {
    this.items.push({
      role: 'user',
      content: [
        ...(input.images ?? []).map((image) => ({
          type: 'input_image' as const,
          image_url: `data:${image.mediaType};base64,${image.base64}`,
          detail: 'auto' as const,
        })),
        { type: 'input_text' as const, text: input.text },
      ],
    });
  }

  addToolResults(results: ToolResult[]): void {
    for (const result of results) {
      const prefix = result.isError ? 'Error: ' : '';
      this.items.push({ type: 'function_call_output', call_id: result.id, output: prefix + (result.content || '(no output)') });
    }
    const images = results.flatMap((result) => result.images ?? []);
    if (images.length > 0) {
      this.addUserMessage({ text: 'Images returned by the tool calls above.', images });
    }
  }

  async runTurn(request: TurnRequest): Promise<TurnResult> {
    const stream = this.client.responses.stream(
      {
        model: this.model,
        instructions: request.system,
        input: this.items,
        tools: request.tools.map((tool) => ({
          type: 'function' as const,
          name: tool.name,
          description: tool.description,
          parameters: toolInputSchema(tool),
          // Optional fields are allowed in tool inputs, which strict mode does not support.
          strict: false,
        })),
        reasoning: { effort: this.effort, summary: 'auto' },
        include: ['reasoning.encrypted_content'],
        store: false,
        truncation: 'auto',
      },
      { signal: request.signal },
    );
    stream.on('response.output_text.delta', (event) => request.callbacks.onText(event.delta));
    stream.on('response.reasoning_summary_text.delta', (event) => request.callbacks.onThinking?.(event.delta));

    const response = await stream.finalResponse();
    // Output items (reasoning, messages, function calls) are valid input items for the next request.
    this.items.push(...(response.output as unknown as InputItem[]));

    const toolCalls: ToolCall[] = response.output.flatMap((item) =>
      item.type === 'function_call' ? [{ id: item.call_id, name: item.name, input: parseArguments(item.arguments) }] : [],
    );

    const refusal = response.output
      .flatMap((item) => (item.type === 'message' ? item.content : []))
      .find((part) => part.type === 'refusal');

    const inputTokens = response.usage?.input_tokens ?? 0;
    const cacheReadTokens = response.usage?.input_tokens_details?.cached_tokens ?? 0;
    const cacheWriteTokens = response.usage?.input_tokens_details?.cache_write_tokens ?? 0;

    return {
      text: response.output_text ?? '',
      toolCalls,
      stopReason: stopReason(response, toolCalls.length > 0, Boolean(refusal)),
      usage: {
        inputTokens: Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens),
        outputTokens: response.usage?.output_tokens ?? 0,
        cacheReadTokens,
        cacheWriteTokens,
        longContext: inputTokens > 272_000,
      },
      refusal: refusal?.type === 'refusal' ? refusal.refusal : undefined,
    };
  }

  serialize(): SerializedConversation {
    return { provider: this.provider, api: 'responses', model: this.model, messages: this.items };
  }
}

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return { __invalidJson: raw };
  }
}

function stopReason(response: OpenAI.Responses.Response, hasToolCalls: boolean, refused: boolean): StopReason {
  if (response.status === 'incomplete') {
    const reason = response.incomplete_details?.reason;
    if (reason === 'max_output_tokens') return 'max_tokens';
    if (reason === 'content_filter') return 'refusal';
    return 'other';
  }
  if (refused) return 'refusal';
  if (hasToolCalls) return 'tool_use';
  return 'end_turn';
}
