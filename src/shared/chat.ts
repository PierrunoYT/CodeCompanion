// Chat transcript shown in the UI, and the events that build it. The main process applies every event to its own
// copy (for saving) and forwards it to the renderer, which applies it with the same reducer.

export interface ToolPreviewView {
  title: string;
  diff?: string;
  command?: string;
}

export type ToolStatus = 'awaiting-approval' | 'running' | 'done' | 'error' | 'declined';

export type TranscriptItem =
  | { kind: 'user'; id: string; text: string; imageCount: number }
  | { kind: 'assistant'; id: string; text: string; thinking: string; streaming: boolean }
  | {
      kind: 'tool';
      id: string;
      name: string;
      status: ToolStatus;
      preview?: ToolPreviewView;
      summary?: string;
      output?: string;
    }
  | { kind: 'error'; id: string; text: string }
  | { kind: 'notice'; id: string; text: string };

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export type ChatEvent =
  | { type: 'user'; id: string; text: string; imageCount: number }
  | { type: 'assistant-start'; id: string }
  | { type: 'assistant-delta'; id: string; text: string }
  | { type: 'thinking-delta'; id: string; text: string }
  | { type: 'assistant-restart'; id: string }
  // text replaces the streamed text when given (the final, complete answer).
  | { type: 'assistant-end'; id: string; text?: string }
  | { type: 'tool-start'; id: string; name: string; preview?: ToolPreviewView; awaitingApproval: boolean }
  | { type: 'tool-running'; id: string }
  | { type: 'tool-progress'; id: string; text: string }
  | { type: 'tool-end'; id: string; status: 'done' | 'error' | 'declined'; summary: string; output?: string }
  | { type: 'error'; id: string; text: string }
  | { type: 'notice'; id: string; text: string }
  | { type: 'busy'; busy: boolean }
  | { type: 'usage'; totals: UsageTotals }
  | { type: 'title'; title: string };

export interface ApprovalDecision {
  approved: boolean;
  // Sent back to the model when the user declines, so it can adjust instead of stopping.
  feedback?: string;
}

export interface ChatSnapshot {
  id: string;
  title: string;
  projectPath: string | null;
  model: string;
  transcript: TranscriptItem[];
  busy: boolean;
  usage: UsageTotals;
}

export interface ChatSummary {
  id: string;
  title: string;
  projectPath: string | null;
  updatedAt: string;
}

export interface UserMessage {
  text: string;
  images?: Array<{ mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; base64: string }>;
}

const MAX_TOOL_OUTPUT_IN_TRANSCRIPT = 20_000;

// Applies one event to a transcript, returning a new array. Events that only change session metadata (busy,
// usage, title) leave the transcript unchanged.
export function applyChatEvent(items: TranscriptItem[], event: ChatEvent): TranscriptItem[] {
  const update = (id: string, change: (item: TranscriptItem) => TranscriptItem) =>
    items.map((item) => (item.id === id ? change(item) : item));

  switch (event.type) {
    case 'user':
      return [...items, { kind: 'user', id: event.id, text: event.text, imageCount: event.imageCount }];
    case 'assistant-start':
      return [...items, { kind: 'assistant', id: event.id, text: '', thinking: '', streaming: true }];
    case 'assistant-delta':
      return update(event.id, (item) => (item.kind === 'assistant' ? { ...item, text: item.text + event.text } : item));
    case 'thinking-delta':
      return update(event.id, (item) =>
        item.kind === 'assistant' ? { ...item, thinking: item.thinking + event.text } : item,
      );
    case 'assistant-restart':
      return update(event.id, (item) => (item.kind === 'assistant' ? { ...item, text: '', thinking: '' } : item));
    case 'assistant-end': {
      const ended = update(event.id, (item) =>
        item.kind === 'assistant' ? { ...item, text: event.text ?? item.text, streaming: false } : item,
      );
      // Tool-only turns produce no text; drop the empty bubble.
      return ended.filter((item) => !(item.kind === 'assistant' && item.id === event.id && !item.text && !item.thinking));
    }
    case 'tool-start':
      return [
        ...items,
        {
          kind: 'tool',
          id: event.id,
          name: event.name,
          preview: event.preview,
          status: event.awaitingApproval ? 'awaiting-approval' : 'running',
        },
      ];
    case 'tool-running':
      return update(event.id, (item) => (item.kind === 'tool' ? { ...item, status: 'running' } : item));
    case 'tool-progress':
      return update(event.id, (item) =>
        item.kind === 'tool'
          ? { ...item, output: ((item.output ?? '') + event.text).slice(-MAX_TOOL_OUTPUT_IN_TRANSCRIPT) }
          : item,
      );
    case 'tool-end':
      return update(event.id, (item) =>
        item.kind === 'tool'
          ? {
              ...item,
              status: event.status,
              summary: event.summary,
              output: (event.output ?? item.output)?.slice(-MAX_TOOL_OUTPUT_IN_TRANSCRIPT),
            }
          : item,
      );
    case 'error':
      return [...items, { kind: 'error', id: event.id, text: event.text }];
    case 'notice':
      return [...items, { kind: 'notice', id: event.id, text: event.text }];
    default:
      return items;
  }
}
