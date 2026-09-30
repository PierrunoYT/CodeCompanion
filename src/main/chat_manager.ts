import { platform } from 'node:os';
import type { ApprovalDecision, ChatEvent, ChatSnapshot, UserMessage } from '@shared/chat';
import { loadAgentFile } from './agent/agent_file';
import { isCommandAllowed } from './agent/allowed_commands';
import { isNetworkUrlAllowed } from './agent/allowed_network_hosts';
import type { DroppedFieldError } from './agent/agent';
import { buildSystemPrompt } from './agent/system_prompt';
import { ChatSession, type SavedChat } from './agent/session';
import type { ChatStore } from './chat_store';
import type { LlmService } from './llm';
import type { ProjectStore } from './projects';
import type { SettingsStore } from './settings';
import { availableTools } from './tools/registry';
import { ShellRunner, shellName } from './tools/shell';
import { confineFileUrl, type BrowserController } from './tools/browser';
import type { AgentTool, CodeSearch, ToolContext } from './tools/types';
import { Workspace } from './tools/workspace';

export interface ChatManagerDeps {
  settings: SettingsStore;
  projects: ProjectStore;
  chats: ChatStore;
  llm: LlmService;
  browser: () => BrowserController | null;
  codeSearch: (workspace: Workspace) => { search: CodeSearch; tools: AgentTool[] } | null;
  emit: (event: ChatEvent, chatId: string) => void;
  onSnapshot: (snapshot: ChatSnapshot) => void;
  onHistoryChanged: () => void;
  onDroppedFields?: (error: DroppedFieldError) => void;
}

const SAVE_DELAY_MS = 500;

interface ProjectChat {
  session: ChatSession | null;
  workspace: Workspace | null;
  shell: ShellRunner | null;
}

// Owns the active chat. A chat's model conversation is created on the first message, so the model and project in
// effect at that moment are the ones the chat keeps.
export class ChatManager {
  private session: ChatSession | null = null;
  private workspace: Workspace | null = null;
  private shell: ShellRunner | null = null;
  private projectPath: string | null = null;
  private readonly parked = new Map<string, ProjectChat>();
  private readonly saveTimers = new Map<ChatSession, NodeJS.Timeout>();

  constructor(private readonly deps: ChatManagerDeps) {}

  snapshot(): ChatSnapshot {
    return (
      this.session?.snapshot() ?? {
        id: '',
        title: 'New chat',
        projectPath: this.deps.projects.current()?.path ?? null,
        model: this.deps.settings.get().model,
        transcript: [],
        busy: false,
        resumable: false,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
        agentFile: this.pendingAgentFile(),
      }
    );
  }

  get busy(): boolean {
    return this.session?.busy ?? false;
  }

  // Setup problems (no project, missing API key, already busy) throw immediately; the returned promise settles when
  // the agent finishes. Errors during the run are shown in the transcript instead.
  send(message: UserMessage): Promise<void> {
    if (this.busy) throw new Error('The assistant is still working. Stop it or wait for it to finish.');
    if (!this.session) {
      this.session = this.createSession();
      this.deps.onSnapshot(this.session.snapshot());
    }
    return this.session.send(message);
  }

  stop(): void {
    this.session?.stop();
  }

  resume(): Promise<void> {
    if (this.busy) throw new Error('The assistant is still working. Stop it or wait for it to finish.');
    if (!this.session?.snapshot().resumable) throw new Error('There is no stopped run to resume.');
    return this.session.resume();
  }

  decide(approvalId: string, decision: ApprovalDecision): void {
    this.session?.decide(approvalId, decision);
  }

  newChat(): ChatSnapshot {
    this.requireIdle();
    this.closeSession();
    const snapshot = this.snapshot();
    this.deps.onSnapshot(snapshot);
    return snapshot;
  }

  // Reopens a saved chat and its project. The chat keeps the model and system prompt it started with.
  open(id: string): ChatSnapshot {
    this.requireIdle();
    const saved = this.deps.chats.load(id);
    if (!saved) throw new Error('That chat could not be found.');
    if (!saved.projectPath) throw new Error('That chat has no project.');
    this.deps.projects.open(saved.projectPath);
    this.projectChanged();
    if (this.session?.id === id) return this.snapshot();
    this.closeSession();
    this.session = this.createSession(saved);
    const snapshot = this.session.snapshot();
    this.deps.onSnapshot(snapshot);
    return snapshot;
  }

  // Keep idle chats and their workspace-bound shell runners separate while switching the active project.
  projectChanged(): void {
    this.requireIdle();
    const next = this.deps.projects.current()?.path ?? null;
    if (next === this.projectPath) {
      this.deps.onSnapshot(this.snapshot());
      return;
    }
    if (this.projectPath) {
      if (this.session) this.save(this.session);
      this.parked.set(this.projectPath, { session: this.session, workspace: this.workspace, shell: this.shell });
    }
    const retained = next ? this.parked.get(next) : undefined;
    if (next) this.parked.delete(next);
    this.session = retained?.session ?? null;
    this.workspace = retained?.workspace ?? null;
    this.shell = retained?.shell ?? null;
    this.projectPath = next;
    this.deps.onSnapshot(this.snapshot());
  }

  requireIdle(): void {
    if (this.busy) throw new Error('Stop the current task and wait for it to finish before switching chats or projects.');
  }

  closeProject(path: string): void {
    if (path === this.projectPath) {
      this.requireIdle();
      this.closeSession();
      this.shell?.stopAll();
      this.shell = null;
      this.workspace = null;
      this.projectPath = null;
    } else {
      const retained = this.parked.get(path);
      if (retained?.session) this.save(retained.session);
      retained?.shell?.stopAll();
      this.parked.delete(path);
    }
  }

  dispose(): void {
    this.closeSession();
    for (const path of [...this.parked.keys()]) this.closeProject(path);
    for (const timer of this.saveTimers.values()) clearTimeout(timer);
    this.saveTimers.clear();
  }

  private createSession(saved?: SavedChat): ChatSession {
    const project = this.deps.projects.current();
    if (!project) throw new Error('Open a project folder first (File → Open Project).');
    const workspace = this.currentWorkspace(project.path);
    const shell = this.currentShell(workspace);
    // Read again on every turn: keys and panels can change while a chat is open.
    const capabilities = () => {
      const settings = this.deps.settings.get();
      const googleApiKey = this.deps.settings.getSecret('googleApiKey');
      return {
        codeSearch: this.deps.codeSearch(workspace),
        browser: this.deps.browser(),
        webSearch:
          googleApiKey && settings.googleSearchEngineId
            ? { googleApiKey, googleSearchEngineId: settings.googleSearchEngineId }
            : null,
      };
    };
    const conversation = saved
      ? this.deps.llm.restoreConversation(saved.conversation)
      : this.deps.llm.createConversation();
    // A saved chat keeps the system prompt it started with, including the agent file as it was then.
    const agentFile = saved ? null : loadAgentFile(workspace);
    const system =
      saved?.system ??
      buildSystemPrompt({
        workspace,
        shell: shellName(),
        platform: platform(),
        date: new Date().toISOString().slice(0, 10),
        customInstructions: project.instructions,
        agentFile,
      });

    const session: ChatSession = new ChatSession({
      id: saved?.id,
      title: saved?.title,
      createdAt: saved?.createdAt,
      projectPath: project.path,
      conversation,
      officialPricing: conversation.provider === 'anthropic' || !this.deps.settings.get().openaiBaseUrl.trim(),
      system,
      agentFile: saved ? (saved.agentFile ?? null) : (agentFile?.name ?? null),
      tools: () => {
        const { codeSearch, browser, webSearch } = capabilities();
        return availableTools({ browser, codeSearch: codeSearch?.search ?? null, webSearch }, codeSearch?.tools ?? []);
      },
      transcript: saved?.transcript,
      usage: saved?.usage,
      readFiles: saved?.readFiles,
      resumable: saved?.resumable,
      approvalMode: () => this.deps.settings.get().approvalMode,
      isPreApproved: (toolName, input) => {
        if (toolName === 'run_command' && typeof (input as { command?: unknown })?.command === 'string') {
          return isCommandAllowed((input as { command: string }).command, this.deps.settings.get().allowedCommands);
        }
        if ((toolName === 'fetch_url' || toolName === 'browser') && typeof (input as { url?: unknown })?.url === 'string') {
          const url = (input as { url: string }).url;
          if (toolName === 'browser' && /^file:/i.test(url)) {
            try {
              confineFileUrl(url, workspace);
              return true;
            } catch {
              return false;
            }
          }
          return isNetworkUrlAllowed(url, this.deps.settings.get().allowedNetworkHosts);
        }
        return false;
      },
      toolContext: (base): ToolContext => {
        const { codeSearch, browser, webSearch } = capabilities();
        return { ...base, workspace, shell, browser, codeSearch: codeSearch?.search ?? null, webSearch };
      },
      smallModel: () => this.deps.llm.smallModel(),
      onDroppedFields: this.deps.onDroppedFields,
      onEvent: (event) => this.deps.emit(event, session.id),
      onChange: (immediate) => (immediate ? this.save(session) : this.scheduleSave(session)),
    });
    return session;
  }

  // The agent file a new chat in the current project would start with, shown before the first message.
  private pendingAgentFile(): string | null {
    const project = this.deps.projects.current();
    if (!project) return null;
    try {
      return loadAgentFile(new Workspace(project.path))?.name ?? null;
    } catch {
      return null;
    }
  }

  private currentWorkspace(path: string): Workspace {
    if (!this.workspace || this.workspace.root !== new Workspace(path).root) {
      this.workspace = new Workspace(path);
      this.shell?.stopAll();
      this.shell = null;
    }
    return this.workspace;
  }

  private currentShell(workspace: Workspace): ShellRunner {
    this.shell ??= new ShellRunner(() => workspace.root);
    return this.shell;
  }

  private scheduleSave(session: ChatSession): void {
    if (session.isEmpty) return;
    clearTimeout(this.saveTimers.get(session));
    this.saveTimers.set(session, setTimeout(() => this.save(session), SAVE_DELAY_MS));
  }

  private save(session: ChatSession): void {
    clearTimeout(this.saveTimers.get(session));
    this.saveTimers.delete(session);
    if (session.isEmpty) return;
    this.deps.chats.save(session.serialize());
    this.deps.onHistoryChanged();
  }

  private closeSession(): void {
    if (!this.session) return;
    this.session.stop();
    this.save(this.session);
    this.session = null;
    this.shell?.stopAll();
  }
}
