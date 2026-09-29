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
}

export interface ChatSessionOptions {
  id?: string;
  title?: string;
  createdAt?: string;
  projectPath: string | null;
  conversation: Conversation;
  system: string;
  tools: () => AgentTool[];
  transcript?: TranscriptItem[];
  usage?: UsageTotals;
  readFiles?: string[];
  approvalMode: () => ApprovalMode;
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
  private updatedAt: string;

  constructor(private readonly options: ChatSessionOptions) {
    this.id = options.id ?? randomUUID();
    this.createdAt = options.createdAt ?? new Date().toISOString();
    this.updatedAt = this.createdAt;
    this.title = options.title ?? 'New chat';
    this.transcript = options.transcript ?? [];
    this.readFiles = new Set(options.readFiles ?? []);
    this.agent = new Agent({
      conversation: options.conversation,
      system: options.system,
      tools: options.tools,
      approvalMode: options.approvalMode,
      requestApproval: (id, signal) => this.waitForApproval(id, signal),
      toolContext: (signal, onProgress) => options.toolContext({ signal, onProgress, readFiles: this.readFiles }),
      emit: (event) => this.emit(event),
    });
    if (options.usage) this.agent.totals = options.usage;
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
      transcript: this.transcript,
      busy: this.busy,
      usage: this.agent.totals,
    };
  }

  async send(message: UserMessage): Promise<void> {
    if (this.busy) throw new Error('The assistant is still working. Stop it or wait for it to finish.');
    const text = message.text.trim();
    if (!text && !message.images?.length) return;

    const isFirst = !this.transcript.some((item) => item.kind === 'user');
    this.emit({ type: 'user', id: randomUUID(), text, imageCount: message.images?.length ?? 0 });
    if (isFirst) void this.generateTitle(text);

    const controller = new AbortController();
    this.controller = controller;
    this.emit({ type: 'busy', busy: true });
    try {
      await this.agent.send({ text: text || '(see attached images)', images: message.images }, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) {
        this.emit({ type: 'notice', id: randomUUID(), text: 'Stopped.' });
      } else {
        this.emit({ type: 'error', id: randomUUID(), text: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      this.controller = null;
      this.rejectPendingApprovals();
      this.emit({ type: 'busy', busy: false });
    }
  }

  stop(): void {
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
