import { z } from 'zod';
import type { ChatEvent, UsageTotals } from '@shared/chat';
import type { Conversation, SerializedConversation, UserInput } from '../llm/types';
import { Agent, SUBAGENT_MAX_TURNS } from '../agent/agent';
import { defineTool, ToolError, truncateOutput, type AgentTool, type ToolContext } from './types';

export interface TaskToolOptions {
  // A fresh conversation per subagent run, on the chat's own model (not the current Settings model).
  createConversation: () => Conversation;
  // The chat's system prompt. A short preamble is added in front so the subagent knows it is read-only.
  system: string;
  // The parent's tool list; only the read-only subset is offered to the subagent.
  tools: () => AgentTool[];
  // Adds the subagent's token usage to the chat totals, so the status bar and cost estimate include delegated work.
  recordUsage?: (usage: UsageTotals) => void;
}

// An empty conversation on the parent chat's own model and API, for one subagent run. The parent's compaction state
// is not carried over: requests are built from `messages.slice(keepFrom)`, which would drop the subagent's own first
// messages (its question) and send the parent's summary instead.
export function subagentConversation(
  parent: Conversation,
  restore: (saved: SerializedConversation) => Conversation,
): Conversation {
  const { compaction: _compaction, ...saved } = parent.serialize();
  return restore({ ...saved, messages: [] });
}

// load_skill only reads project skill files, and the subagent gets the parent's prompt, which lists the skills.
const READ_ONLY_TOOLS = new Set(['read_file', 'list_directory', 'grep', 'search_code', 'load_skill']);

const SUBAGENT_PREAMBLE = `You are a read-only research subagent. Another agent delegated one question to you.
- You can only read files, list directories, grep and use semantic code search. You cannot edit files, run commands, use the browser or fetch pages, and you have no web access.
- Do not try tools you were not given; a missing tool means you cannot do that, so answer from what you can read.
- Answer the delegated question directly. Your last message, the one with no tool call, is the only thing the other agent receives, so include the paths and line numbers it needs.
- Do not start the work yourself and do not propose a plan for it. Report what you found.`;

// Runs a read-only subagent: a nested agent that can inspect the project (read files, grep, semantic search) but
// cannot change anything, run commands or reach the network. Its answer comes back as the tool result; its
// progress streams into the parent transcript while it works. Read-only scope means no approval cards are needed
// inside the subagent, and no nesting: the task tool is not part of its tool list. Its reads go into its own set,
// so a file it read does not count as read by the parent (the parent still has to read a file before editing it).
export function createTaskTool(options: TaskToolOptions): AgentTool {
  return defineTool({
    name: 'task',
    description:
      'Delegate a research question to a read-only subagent that has its own context window. It can read files, list directories, grep and use semantic code search in the current project, but cannot edit files, run commands or use the web. Give it a self-contained question and the paths or symbols to start from; its answer arrives as your tool result. A file it reads does not count as read by you: read it yourself before editing it. Use it for broad surveys (find every caller, summarize a subsystem) so your own context stays small.',
    schema: z.object({
      task: z.string().describe('A self-contained research question, with concrete starting points (paths, symbols).'),
    }),
    requiresApproval: false,
    run: async ({ task }, context) => runSubagent(options, task, context),
  });
}

async function runSubagent(options: TaskToolOptions, task: string, context: ToolContext) {
  let partial = '';
  const agent = new Agent({
    conversation: options.createConversation(),
    system: `${SUBAGENT_PREAMBLE}\n\n${options.system}`,
    tools: () => options.tools().filter((tool) => READ_ONLY_TOOLS.has(tool.name)),
    // Read-only tools never ask for approval; the subagent cannot escalate. The fallback declines, so even an
    // unexpected approval request cannot turn into a silent side effect.
    approvalMode: () => 'auto' as const,
    requestApproval: () => Promise.resolve({ approved: false }),
    // Own read set: a file the subagent read is not a file the parent has read, so the read-before-edit guard holds.
    toolContext: (signal, onProgress) => ({ ...context, signal, onProgress, readFiles: new Set() }),
    maxTurns: SUBAGENT_MAX_TURNS,
    emit: (event) => {
      // Interim text (a turn that also called tools) is only progress. The answer is taken from the outcome below.
      // Every turn replaces it, so a final turn without text is not answered with an earlier turn's text.
      if (event.type === 'assistant-end') partial = event.text ?? '';
      forwardProgress(event, context.onProgress);
    },
  });

  const input: UserInput = { text: task };
  let outcome: ReturnType<Agent['outcome']>;
  try {
    outcome = (await agent.send(input, context.signal)) ? 'stopped' : agent.outcome();
  } catch (error) {
    if (context.signal.aborted) throw new ToolError('The subagent was stopped.');
    throw new ToolError(`The subagent failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    // Also after a failure: the turns that did run were billed.
    options.recordUsage?.(agent.totals);
  }
  const usage = agent.totals;
  const usageLine = `(Subagent token usage: ${usage.inputTokens} in / ${usage.outputTokens} out.)`;
  if (outcome === 'answer' && partial.trim()) {
    return {
      content: `${truncateOutput(partial.trim())}\n\n${usageLine}`,
      summary: `Subagent: ${truncate(task, 60)}`,
    };
  }

  const why = unfinishedReason(outcome);
  const excerpt = partial.trim() ? `\n\nLast text before it stopped:\n${truncateOutput(partial.trim())}` : '';
  return {
    content: `The subagent did not finish: ${why}.${excerpt}\n\n${usageLine}`,
    summary: `Subagent stopped: ${truncate(task, 60)}`,
    isError: true,
  };
}

function unfinishedReason(outcome: ReturnType<Agent['outcome']>): string {
  switch (outcome) {
    case 'turn-cap':
      return `it reached the ${SUBAGENT_MAX_TURNS}-step limit`;
    case 'context':
      return 'its context window filled up';
    case 'max-tokens':
      return 'its last response was cut off at the output limit';
    case 'refusal':
      return 'the model declined the question';
    case 'stopped':
      return 'it was stopped';
    default:
      return 'it ended without an answer';
  }
}

// The nested events are not transcript items in the parent; the interesting parts stream as progress lines.
function forwardProgress(event: ChatEvent, onProgress: (text: string) => void): void {
  if (event.type === 'tool-end') onProgress(`[${event.status}] ${event.summary}\n`);
  if (event.type === 'assistant-end' && event.text) onProgress(`${truncate(event.text, 500)}\n`);
  if (event.type === 'notice') onProgress(`${event.text}\n`);
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}
