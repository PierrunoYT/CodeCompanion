import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServerConfig, McpStatus } from '@shared/settings';
import type { JsonObjectSchema } from '../llm/types';
import { ToolError, truncateOutput, type AgentTool, type ToolOutput } from './types';

const CONNECT_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 120_000;

interface ServerState {
  config: McpServerConfig;
  client: Client | null;
  // Set while a connection attempt is in flight, so a timeout or a later stop can close what it spawned.
  connecting: Client | null;
  error?: string;
  // The server's own tool descriptions, named only after every server has connected so names cannot collide.
  listed: McpToolDescription[];
  tools: AgentTool[];
}

interface McpToolDescription {
  name: string;
  description?: string;
  inputSchema?: JsonObjectSchema;
}

// Connects to the configured Model Context Protocol servers and exposes their tools to the agent. Connections are
// refreshed in the background; the per-turn tool callback needs a synchronous list, so it reads the cache.
export class McpHub {
  private readonly states = new Map<string, ServerState>();
  private updating: Promise<void> | null = null;
  private stopped = false;
  private dirty = false;

  constructor(
    private readonly getServers: () => McpServerConfig[],
    private readonly onToolsChanged: () => void,
    private readonly clientInfo = { name: 'CodeCompanion', version: '0.1.0' },
  ) {}

  // Reconnects every configured server in the background. Called at startup and when the servers setting changes.
  start(): void {
    void this.refresh();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.updating;
    await Promise.all([...this.states.values()].map((state) => closeClient(state)));
    this.states.clear();
  }

  tools(): AgentTool[] {
    return [...this.states.values()].flatMap((state) => state.tools);
  }

  status(): McpStatus[] {
    return this.getServers().map((config) => {
      const state = this.states.get(config.name);
      if (!state || state.connecting) return { name: config.name, state: 'connecting' as const, tools: [] };
      return {
        name: config.name,
        state: state.client ? ('connected' as const) : ('error' as const),
        error: state.error,
        tools: state.tools.map((tool) => tool.name),
      };
    });
  }

  async refresh(): Promise<void> {
    // A config change that arrives while a refresh is connecting must not be lost: the in-flight one read the old
    // config. One follow-up covers every waiter, so several changes collapse into a single extra refresh.
    if (this.updating) {
      this.dirty = true;
      return this.updating;
    }
    this.updating = this.refreshNow().finally(() => (this.updating = null));
    await this.updating;
    if (this.dirty && !this.stopped) {
      this.dirty = false;
      return this.refresh();
    }
  }

  private async refreshNow(): Promise<void> {
    const configs = this.getServers();
    for (const [name, state] of [...this.states]) {
      if (!configs.some((config) => config.name === name)) {
        await closeClient(state);
        this.states.delete(name);
      }
    }
    await Promise.all(configs.map((config) => this.connectOne(config)));
    this.assignToolNames();
    this.onToolsChanged();
  }

  private async connectOne(config: McpServerConfig): Promise<void> {
    const existing = this.states.get(config.name);
    if (existing?.client && JSON.stringify(existing.config) === JSON.stringify(config)) return;
    if (existing) {
      await closeClient(existing);
      existing.client = null;
      existing.tools = [];
    }
    const state: ServerState = existing ?? { config, client: null, connecting: null, listed: [], tools: [] };
    state.config = config;
    state.listed = [];
    this.states.set(config.name, state);

    const client = new Client(this.clientInfo, { capabilities: {} });
    state.connecting = client;
    try {
      const transport =
        config.transport === 'stdio'
          ? new StdioClientTransport({
              command: config.command!,
              args: config.args ?? [],
              env: { ...getDefaultEnvironment(), ...config.env },
              cwd: config.cwd,
            })
          : new StreamableHTTPClientTransport(new URL(config.url!), { requestInit: { headers: config.headers } });
      await withTimeout(client.connect(transport), `connecting to ${config.name} timed out`);
      const listed = await withTimeout(client.listTools(), `listing tools of ${config.name} timed out`);
      if (this.stopped) {
        await closeClient(state);
        return;
      }
      state.client = client;
      state.error = undefined;
      state.listed = listed.tools as McpToolDescription[];
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      state.tools = [];
      await closeClient(state);
    } finally {
      state.connecting = null;
    }
  }

  // Names are assigned in config order once every server has connected, so two servers that connect in parallel
  // cannot both claim the same name.
  private assignToolNames(): void {
    const taken = new Set<string>();
    for (const state of this.states.values()) {
      state.tools = state.listed.map((tool) => this.toAgentTool(state.config, state, tool, taken));
    }
  }

  private toAgentTool(
    config: McpServerConfig,
    state: ServerState,
    tool: McpToolDescription,
    taken: Set<string>,
  ): AgentTool {
    const name = qualifiedToolName(config.name, tool.name, taken);
    taken.add(name);
    return {
      name,
      description: tool.description ?? '',
      jsonSchema: tool.inputSchema ?? { type: 'object' },
      // MCP tools come from outside the app and run programs the user configured, so they ask even in Auto mode.
      requiresApproval: true,
      alwaysAsk: true,
      run: async (input, context) => {
        const client = state.client;
        if (!client) throw new ToolError(`The MCP server "${config.name}" is not connected.`);
        const result = await client.callTool({ name: tool.name, arguments: input }, undefined, {
          timeout: CALL_TIMEOUT_MS,
          signal: context.signal,
        });
        return toToolOutput(result as McpToolResult);
      },
    };
  }
}

// Namespaced tool name the model sees: mcp_<server>_<tool>, sanitized to what the provider APIs accept. The suffix
// that disambiguates a collision is budgeted inside the 64-character limit.
function qualifiedToolName(server: string, tool: string, taken: Set<string>): string {
  const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32);
  const base = `mcp_${sanitize(server)}_${sanitize(tool)}`;
  for (let suffix = 1; ; suffix++) {
    const extra = suffix === 1 ? '' : `_${suffix}`;
    const name = base.slice(0, 64 - extra.length) + extra;
    if (!taken.has(name)) return name;
  }
}

interface McpToolResult {
  content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

function toToolOutput(result: McpToolResult): ToolOutput {
  const blocks = result.content ?? [];
  const text = blocks
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
  const images = blocks.flatMap((block) =>
    block.type === 'image' && block.data && isSupportedImage(block.mimeType)
      ? [{ mediaType: block.mimeType as 'image/png', base64: block.data }]
      : [],
  );
  const skipped = [...new Set(blocks.map((block) => block.type))].filter((type) => type !== 'text' && type !== 'image');
  const note = skipped.length > 0 ? '\n(' + skipped.join(', ') + ' content was not forwarded)' : '';
  return { content: truncateOutput(text + note) || '(no output)', isError: result.isError || undefined, images };
}

function isSupportedImage(mimeType: unknown): mimeType is 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' {
  return mimeType === 'image/png' || mimeType === 'image/jpeg' || mimeType === 'image/gif' || mimeType === 'image/webp';
}

async function closeClient(state: ServerState): Promise<void> {
  const client = state.client ?? state.connecting;
  const pid = client ? stdioPid(client) : undefined;
  try {
    await client?.close();
  } catch {
    // A server that will not close cleanly is killed below; the process is going away anyway.
  }
  killProcessTree(pid);
  state.client = null;
  state.connecting = null;
}

function stdioPid(client: Client): number | undefined {
  const transport = (client as unknown as { transport?: { pid?: number | null } }).transport;
  return typeof transport?.pid === 'number' ? transport.pid : undefined;
}

// close() kills the spawned process but not what it started. `npx` runs under cmd.exe on Windows, and killing that
// leaves the node grandchild running, so the whole tree goes.
function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    // Already gone.
  }
}

async function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), CONNECT_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
