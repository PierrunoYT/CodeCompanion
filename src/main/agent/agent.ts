import { randomUUID } from 'node:crypto';
import type { ApprovalDecision, ChatEvent, UsageTotals } from '@shared/chat';
import type { ApprovalMode } from '@shared/settings';
import type { Conversation, ToolCall, ToolResult, UserInput } from '../llm/types';
import { toToolSpecs } from '../tools/registry';
import { ToolError, type AgentTool, type ToolContext, type ToolPreview } from '../tools/types';

// Safety net against a model that never stops calling tools.
const MAX_TURNS = 200;
const RESUME_INSTRUCTION =
  'Continue the task that I stopped. Use the completed conversation and tool results above; do not repeat the original request. Some interrupted tool actions may have completed even when their result says they were stopped, so inspect the current state before repeating any action with side effects.';

export interface AgentOptions {
  conversation: Conversation;
  system: string;
  // Asked for on every turn, so tools that become available mid-chat (e.g. after an API key is saved) are offered.
  tools: () => AgentTool[];
  approvalMode: () => ApprovalMode;
  // True for a call the user allowed in advance (see the allowedCommands setting); it then skips the approval card.
  isPreApproved?: (toolName: string, input: unknown) => boolean;
  requestApproval: (id: string, signal: AbortSignal) => Promise<ApprovalDecision>;
  toolContext: (signal: AbortSignal, onProgress: (text: string) => void) => ToolContext;
  emit: (event: ChatEvent) => void;
}

// Runs the model/tool loop for one user message: call the model, run the tools it asks for (with approval where
// needed), send the results back, and repeat until the model answers without tool calls.
export class Agent {
  private usage: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

  constructor(private readonly options: AgentOptions) {}

  get totals(): UsageTotals {
    return { ...this.usage, ...(this.usage.longContext ? { longContext: { ...this.usage.longContext } } : {}) };
  }

  set totals(value: UsageTotals) {
    this.usage = { ...value, cacheWriteTokens: value.cacheWriteTokens ?? 0 };
  }

  async send(input: UserInput, signal: AbortSignal): Promise<void> {
    this.options.conversation.addUserMessage(input);
    await this.run(signal);
  }

  async resume(signal: AbortSignal): Promise<void> {
    this.options.conversation.addUserMessage({ text: RESUME_INSTRUCTION });
    await this.run(signal);
  }

  private async run(signal: AbortSignal): Promise<void> {
    const { conversation, emit } = this.options;

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (signal.aborted) return;
      const tools = this.options.tools();
      const messageId = randomUUID();
      emit({ type: 'assistant-start', id: messageId });

      let result;
      try {
        result = await conversation.runTurn({
          system: this.options.system,
          tools: toToolSpecs(tools),
          signal,
          callbacks: {
            onText: (text) => emit({ type: 'assistant-delta', id: messageId, text }),
            onThinking: (text) => emit({ type: 'thinking-delta', id: messageId, text }),
            onRestart: () => emit({ type: 'assistant-restart', id: messageId }),
          },
        });
      } catch (error) {
        // Keep whatever was streamed before the failure.
        emit({ type: 'assistant-end', id: messageId });
        throw error;
      }
      emit({ type: 'assistant-end', id: messageId, text: result.text });

      this.usage.inputTokens += result.usage.inputTokens;
      this.usage.outputTokens += result.usage.outputTokens;
      this.usage.cacheReadTokens += result.usage.cacheReadTokens;
      this.usage.cacheWriteTokens = (this.usage.cacheWriteTokens ?? 0) + (result.usage.cacheWriteTokens ?? 0);
      if (result.usage.longContext) {
        const long = this.usage.longContext
          ? { ...this.usage.longContext }
          : {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            };
        long.inputTokens += result.usage.inputTokens;
        long.outputTokens += result.usage.outputTokens;
        long.cacheReadTokens += result.usage.cacheReadTokens;
        long.cacheWriteTokens += result.usage.cacheWriteTokens ?? 0;
        this.usage.longContext = long;
      }
      emit({ type: 'usage', totals: this.totals });

      if (result.stopReason === 'refusal') {
        emit({ type: 'notice', id: randomUUID(), text: result.refusal ?? 'The model declined this request.' });
      }
      if (result.stopReason === 'context_exceeded') {
        emit({
          type: 'notice',
          id: randomUUID(),
          text: 'The conversation is too long for the model. Start a new chat.',
        });
      }
      if (result.toolCalls.length === 0 || result.stopReason === 'refusal') {
        if (result.stopReason === 'max_tokens') {
          emit({ type: 'notice', id: randomUUID(), text: 'The response hit the output limit and may be incomplete.' });
        }
        return;
      }

      const { results, stop } = await this.runTools(
        tools,
        result.toolCalls,
        result.stopReason === 'max_tokens',
        signal,
      );
      conversation.addToolResults(results);
      if (stop || signal.aborted) return;
    }

    emit({ type: 'notice', id: randomUUID(), text: `Stopped after ${MAX_TURNS} steps.` });
  }

  // Every tool call gets a result, even when skipped, because the API requires one per call.
  private async runTools(
    tools: AgentTool[],
    calls: ToolCall[],
    truncated: boolean,
    signal: AbortSignal,
  ): Promise<{ results: ToolResult[]; stop: boolean }> {
    const results: ToolResult[] = [];
    let stop = false;

    for (const call of calls) {
      if (signal.aborted) {
        results.push({ id: call.id, content: 'Not run: the user stopped the task.', isError: true });
        continue;
      }
      if (stop) {
        results.push({ id: call.id, content: 'Not run: the user declined an earlier action.', isError: true });
        continue;
      }
      if (truncated) {
        results.push({
          id: call.id,
          content:
            'Not run: your response hit the output limit and this tool input may be cut off. Retry with smaller changes.',
          isError: true,
        });
        continue;
      }

      const outcome = await this.runTool(tools, call, signal);
      results.push(outcome.result);
      if (outcome.declinedWithoutFeedback) stop = true;
    }
    return { results, stop };
  }

  private async runTool(
    tools: AgentTool[],
    call: ToolCall,
    signal: AbortSignal,
  ): Promise<{ result: ToolResult; declinedWithoutFeedback?: boolean }> {
    const { emit } = this.options;
    const tool = tools.find((candidate) => candidate.name === call.name);
    const eventId = call.id || randomUUID();

    if (!tool) {
      return { result: { id: call.id, content: `Unknown tool: ${call.name}`, isError: true } };
    }

    // Streamed tool inputs are not validated by the API, so check them here before doing anything.
    const parsed = tool.schema.safeParse(call.input);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => {
          const name = issue.path.join('.') || 'input';
          return /received undefined/.test(issue.message)
            ? `${name}: required but missing`
            : `${name}: ${issue.message}`;
        })
        .join('; ');
      const received =
        call.input && typeof call.input === 'object' && !Array.isArray(call.input)
          ? ` Received fields: ${Object.keys(call.input).join(', ') || '(none)'}.`
          : '';
      return {
        result: {
          id: call.id,
          content: `Invalid input for ${call.name}: ${issues}.${received} Send every required field and try again.`,
          isError: true,
        },
      };
    }
    const input = parsed.data;
    const onProgress = (text: string) => emit({ type: 'tool-progress', id: eventId, text });
    const context = this.options.toolContext(signal, onProgress);

    const needsApproval =
      tool.requiresApproval && this.options.approvalMode() === 'ask' && !this.options.isPreApproved?.(tool.name, input);
    let preview: ToolPreview | undefined;
    if (tool.preview) {
      try {
        preview = await tool.preview(input, context);
      } catch (error) {
        // A preview that cannot be built (e.g. edit target missing) means the call would fail anyway.
        const message = error instanceof Error ? error.message : String(error);
        emit({ type: 'tool-start', id: eventId, name: tool.name, awaitingApproval: false });
        emit({ type: 'tool-end', id: eventId, status: 'error', summary: `${tool.name} failed`, output: message });
        return { result: { id: call.id, content: message, isError: true } };
      }
    }

    emit({ type: 'tool-start', id: eventId, name: tool.name, preview, awaitingApproval: needsApproval });

    if (needsApproval) {
      const decision = await this.options.requestApproval(eventId, signal);
      if (signal.aborted) {
        const content =
          'Stopped by the user before this action was approved. Do not assume it ran; inspect the current state before attempting it again.';
        emit({ type: 'tool-end', id: eventId, status: 'error', summary: 'Stopped', output: content });
        return { result: { id: call.id, content, isError: true } };
      }
      if (!decision.approved) {
        const feedback = decision.feedback?.trim();
        emit({ type: 'tool-end', id: eventId, status: 'declined', summary: 'Declined', output: feedback });
        return {
          result: {
            id: call.id,
            content: feedback
              ? `The user declined this action and said: ${feedback}`
              : 'The user declined this action. Wait for further instructions.',
            isError: true,
          },
          declinedWithoutFeedback: !feedback,
        };
      }
      emit({ type: 'tool-running', id: eventId });
    }

    try {
      const output = await tool.run(input, context);
      emit({
        type: 'tool-end',
        id: eventId,
        status: output.isError ? 'error' : 'done',
        summary: output.summary ?? tool.name,
        path: output.path,
        output: tool.name === 'run_command' || tool.name === 'command_output' ? output.content : undefined,
      });
      return { result: { id: call.id, content: output.content, isError: output.isError, images: output.images } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const expected = error instanceof ToolError;
      emit({ type: 'tool-end', id: eventId, status: 'error', summary: `${tool.name} failed`, output: message });
      return { result: { id: call.id, content: expected ? message : `Error: ${message}`, isError: true } };
    }
  }
}
