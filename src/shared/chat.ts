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
      // Project-relative file the tool read or changed.
      path?: string;
      // For edits: whether a backup exists to undo them, and whether that was done.
      undo?: 'available' | 'undone';
    }
  | { kind: 'error'; id: string; text: string }
  | { kind: 'notice'; id: string; text: string };

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  // Optional so chats saved before cache-write accounting remain valid.
  cacheWriteTokens?: number;
  // Size of the last request's prompt (input, cache reads and cache writes), which is how full the model's context
  // is. Unset before the first request and after a compaction, until the next request reports a new size.
  contextTokens?: number;
  // GPT-6 requests over 272K input tokens are priced as a whole at long-context rates. Keeping that per-request
  // classification here avoids incorrectly selecting a tier from aggregate chat usage.
  longContext?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
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
  | {
      type: 'tool-end';
      id: string;
      status: 'done' | 'error' | 'declined';
      summary: string;
      output?: string;
      path?: string;
      // A backup of the file was kept, so the edit can be undone.
      undoable?: boolean;
    }
  // The edit of this tool card was undone.
  | { type: 'tool-undone'; id: string }
  | { type: 'error'; id: string; text: string }
  | { type: 'notice'; id: string; text: string }
  | { type: 'busy'; busy: boolean }
  | { type: 'resumable'; resumable: boolean }
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
  // False for OpenAI-compatible custom endpoints, whose prices may differ even when model ids match.
  officialPricing?: boolean;
  transcript: TranscriptItem[];
  busy: boolean;
  // A user-stopped run can be continued without sending the original message again.
  resumable: boolean;
  usage: UsageTotals;
  // Name of the project instruction file (AGENTS.md) that is part of the system prompt, if any.
  agentFile: string | null;
}

export interface ChatSummary {
  id: string;
  title: string;
  projectPath: string | null;
  updatedAt: string;
  // Only in search results: an excerpt of a message that matched, when the title and project did not.
  snippet?: string;
}

// What is searched in a saved chat besides its title: the user's and the assistant's messages.
export function transcriptSearchText(transcript: TranscriptItem[]): string {
  return transcript
    .flatMap((item) => (item.kind === 'user' || item.kind === 'assistant' ? [item.text] : []))
    .join('\n');
}

// A short single-line excerpt around the first query word found in the text, for showing why a chat matched.
export function searchSnippet(text: string, words: string[], radius = 50): string | undefined {
  const lower = text.toLowerCase();
  const hits = words.map((word) => lower.indexOf(word)).filter((index) => index >= 0);
  if (hits.length === 0) return undefined;
  const at = Math.min(...hits);
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + radius * 2);
  const excerpt = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${excerpt}${end < text.length ? '…' : ''}`;
}

// Case-insensitive match on the title or the project path; every word of the query must appear.
export function filterChats(chats: ChatSummary[], query: string): ChatSummary[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return chats;
  return chats.filter((chat) => {
    const haystack = `${chat.title} ${chat.projectPath ?? ''}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
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
              path: event.path,
              output: (event.output ?? item.output)?.slice(-MAX_TOOL_OUTPUT_IN_TRANSCRIPT),
              ...(event.undoable && event.status === 'done' ? { undo: 'available' as const } : {}),
            }
          : item,
      );
    case 'tool-undone':
      return update(event.id, (item) => (item.kind === 'tool' && item.undo === 'available' ? { ...item, undo: 'undone' } : item));
    case 'error':
      return [...items, { kind: 'error', id: event.id, text: event.text }];
    case 'notice':
      return [...items, { kind: 'notice', id: event.id, text: event.text }];
    default:
      return items;
  }
}
