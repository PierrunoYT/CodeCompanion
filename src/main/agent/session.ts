import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  applyChatEvent,
  type ApprovalDecision,
  type ChatEvent,
  type ChatSnapshot,
  type TranscriptItem,
  type UsageTotals,
  type UserMessage,
} from '@shared/chat';
import type { ApprovalMode } from '@shared/settings';
import type { CompletionClient, Conversation, SerializedConversation } from '../llm/types';
import type { AgentTool, ToolContext } from '../tools/types';
import { Agent } from './agent';

export interface SavedChat {
  version: 1;
  id: string;
  title: string;
  projectPath: string | null;
  createdAt: string;
  updatedAt: string;
  system: string;
  transcript: TranscriptItem[];
  usage: UsageTotals;
  conversation: SerializedConversation;
  readFiles: string[];
  agentFile?: string | null;
  resumable?: boolean;
}

export interface ChatSessionOptions {
  id?: string;
  title?: string;
  createdAt?: string;
  projectPath: string | null;
  conversation: Conversation;
  officialPricing?: boolean;
  system: string;
  agentFile: string | null;
  tools: () => AgentTool[];
  transcript?: TranscriptItem[];
  usage?: UsageTotals;
  readFiles?: string[];
  resumable?: boolean;
  approvalMode: () => ApprovalMode;
  isPreApproved?: (toolName: string, input: unknown) => boolean;
  toolContext: (base: Pick<ToolContext, 'signal' | 'readFiles' | 'onProgress'>) => ToolContext;
  smallModel: () => CompletionClient | null;
  onEvent: (event: ChatEvent) => void;
  // immediate is true when a task just finished, so the chat can be saved right away.
  onChange: (immediate: boolean) => void;
}

// One chat: its model conversation, transcript, pending approvals and the files read in it.
export class ChatSession {
  readonly id: string;
  readonly createdAt: string;
  title: string;
  private transcript: TranscriptItem[];
  private readonly readFiles: Set<string>;
  private readonly agent: Agent;
  private readonly approvals = new Map<string, (decision: ApprovalDecision) => void>();
  private controller: AbortController | null = null;
  private resumable: boolean;
  private stopRequested = false;
  private updatedAt: string;

  constructor(private readonly options: ChatSessionOptions) {
    this.id = options.id ?? randomUUID();
    this.createdAt = options.createdAt ?? new Date().toISOString();
    this.updatedAt = this.createdAt;
    this.title = options.title ?? 'New chat';
    this.transcript = options.transcript ?? [];
    this.readFiles = new Set(options.readFiles ?? []);
    this.resumable = options.resumable ?? false;
    this.agent = new Agent({
      conversation: options.conversation,
      system: options.system,
      tools: options.tools,
      approvalMode: options.approvalMode,
      isPreApproved: options.isPreApproved,
      requestApproval: (id, signal) => this.waitForApproval(id, signal),
      toolContext: (signal, onProgress) => options.toolContext({ signal, onProgress, readFiles: this.readFiles }),
      emit: (event) => this.emit(event),
    });
    if (options.usage) {
      const usage = { ...options.usage };
      // Older OpenAI totals included cache reads in input. Normalize once when loading the old shape.
      if (options.conversation.provider === 'openai' && usage.cacheWriteTokens === undefined) {
        usage.inputTokens = Math.max(0, usage.inputTokens - usage.cacheReadTokens);
      }
      this.agent.totals = usage;
    }
  }

  get busy(): boolean {
    return this.controller !== null;
  }

  get isEmpty(): boolean {
    return this.transcript.length === 0;
  }

  snapshot(): ChatSnapshot {
    return {
      id: this.id,
      title: this.title,
      projectPath: this.options.projectPath,
      model: this.options.conversation.model,
      officialPricing:
        this.options.officialPricing ?? this.options.conversation.provider === 'anthropic',
      transcript: this.transcript,
      busy: this.busy,
      resumable: this.resumable,
      usage: this.agent.totals,
      agentFile: this.options.agentFile,
    };
  }

  async send(message: UserMessage): Promise<void> {
    if (this.busy) throw new Error('The assistant is still working. Stop it or wait for it to finish.');
    const text = message.text.trim();
    if (!text && !message.images?.length) return;

    const isFirst = !this.transcript.some((item) => item.kind === 'user');
    this.setResumable(false);
    this.emit({ type: 'user', id: randomUUID(), text, imageCount: message.images?.length ?? 0 });
    if (isFirst) void this.generateTitle(text);

    return this.run((signal) => this.agent.send({ text: text || '(see attached images)', images: message.images }, signal));
  }

  async resume(): Promise<void> {
    if (this.busy) throw new Error('The assistant is still working. Stop it or wait for it to finish.');
    if (!this.resumable) throw new Error('There is no stopped run to resume.');
    this.setResumable(false);
    return this.run((signal) => this.agent.resume(signal));
  }

  private async run(work: (signal: AbortSignal) => Promise<boolean>): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    this.stopRequested = false;
    let interrupted = false;
    this.emit({ type: 'busy', busy: true });
    try {
      interrupted = await work(controller.signal);
    } catch (error) {
      if (controller.signal.aborted) {
        interrupted = true;
        this.emit({ type: 'notice', id: randomUUID(), text: 'Stopped.' });
      } else {
        this.emit({ type: 'error', id: randomUUID(), text: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      // A stop that arrives as the run finishes on its own leaves nothing to resume.
      const stopped = this.stopRequested && interrupted;
      this.controller = null;
      this.rejectPendingApprovals();
      if (stopped) this.setResumable(true);
      this.emit({ type: 'busy', busy: false });
    }
  }

  stop(): void {
    if (!this.controller) return;
    this.stopRequested = true;
    this.controller?.abort();
    this.rejectPendingApprovals();
  }

  decide(approvalId: string, decision: ApprovalDecision): void {
    this.approvals.get(approvalId)?.(decision);
  }

  serialize(): SavedChat {
    return {
      version: 1,
      id: this.id,
      title: this.title,
      projectPath: this.options.projectPath,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      system: this.options.system,
      transcript: this.transcript,
      usage: this.agent.totals,
      conversation: this.options.conversation.serialize(),
      readFiles: [...this.readFiles],
      agentFile: this.options.agentFile,
      resumable: this.resumable,
    };
  }

  private emit(event: ChatEvent): void {
    this.transcript = applyChatEvent(this.transcript, event);
    this.updatedAt = new Date().toISOString();
    this.options.onEvent(event);
    if (event.type !== 'assistant-delta' && event.type !== 'thinking-delta' && event.type !== 'tool-progress') {
      this.options.onChange(event.type === 'busy' && !event.busy);
    }
  }

  private setResumable(resumable: boolean): void {
    if (this.resumable === resumable) return;
    this.resumable = resumable;
    this.emit({ type: 'resumable', resumable });
  }

  private waitForApproval(id: string, signal: AbortSignal): Promise<ApprovalDecision> {
    if (signal.aborted) return Promise.resolve({ approved: false });
    return new Promise((resolve) => {
      this.approvals.set(id, (decision) => {
        this.approvals.delete(id);
        resolve(decision);
      });
    });
  }

  private rejectPendingApprovals(): void {
    for (const resolve of [...this.approvals.values()]) resolve({ approved: false });
  }

  private async generateTitle(firstMessage: string): Promise<void> {
    const fallback = firstMessage.split(/\s+/).slice(0, 6).join(' ') + (firstMessage.split(/\s+/).length > 6 ? '…' : '');
    let title = fallback || 'New chat';
    const model = this.options.smallModel();
    if (model) {
      try {
        const result = await model.complete(
          `Write a short title (2 to 5 words, no quotes or punctuation at the end) for a coding chat that starts with this request:\n\n${firstMessage.slice(0, 2000)}`,
          z.object({ title: z.string() }),
        );
        title = result.title.trim().slice(0, 80) || title;
      } catch {
        // Keep the fallback title; a missing title is not worth an error in the chat.
      }
    }
    this.title = title;
    this.emit({ type: 'title', title });
  }
}
