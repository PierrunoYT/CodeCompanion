import { applyChatEvent, type ChatEvent, type ChatSnapshot } from '@shared/chat';
import type { ImageAttachment } from '@shared/ipc';
import { estimateCost, formatCost, MODEL_OPTIONS, providerForModel } from '@shared/models';
import type { ProjectInfo } from '@shared/project';
import type { SettingsView } from '@shared/settings';
import { h, icon, setChildren } from './dom';
import { Composer } from './views/composer';
import { openHistoryDialog, openInstructionsDialog, openSettingsDialog } from './views/dialogs';
import { Panels } from './views/panels';
import { TranscriptView } from './views/transcript';

const api = window.api;

export class App {
  private settings!: SettingsView;
  private project: ProjectInfo | null = null;
  private chat!: ChatSnapshot;
  private pendingEvents: ChatEvent[] = [];
  private frame = 0;
  private welcomeGeneration = 0;

  private readonly transcript = new TranscriptView({
    decide: (id, decision) => void api.invoke('chat:decide', id, decision),
    openFile: (path) => void api.invoke('files:open-in-editor', path).catch((error) => this.toast(error)),
    theme: () => this.settings.theme,
  });
  private readonly composer = new Composer({
    send: (text, images) => this.send(text, images),
    stop: () => void api.invoke('chat:stop'),
    resume: () => void api.invoke('chat:resume').catch((error) => this.toast(error)),
    pickImages: () => api.invoke('files:pick-images').catch((error) => (this.toast(error), [])),
  });

  private readonly projectButton = h('button', { class: 'btn btn-sm btn-outline-secondary project-button', onclick: () => this.toggleProjectMenu() });
  private readonly projectMenu = h('div', { class: 'dropdown-menu project-menu' });
  private readonly modelLabel = h('span', { class: 'status-item' });
  private readonly agentLabel = h('span', { class: 'status-item' });
  private readonly modeButton = h('button', { class: 'btn btn-sm mode-button', onclick: () => this.toggleMode() });
  private readonly titleLabel = h('span', { class: 'chat-title text-truncate' });
  private readonly usageLabel = h('span', { class: 'status-item ms-auto' });
  private readonly chatScroll = h('div', { class: 'chat-scroll' });
  private readonly welcome = h('div', { class: 'welcome' });
  private readonly toastArea = h('div', { class: 'toast-area' });
  private readonly panels = new Panels(
    () => this.settings.theme,
    (error) => this.toast(error),
    () => this.project !== null,
  );
  private readonly exportButton = h('button', { class: 'btn btn-sm btn-outline-secondary', title: 'Export this chat as Markdown', 'aria-label': 'Export chat', onclick: () => void this.exportChat() }, icon('download'));
  private readonly panelHost = h('div', { class: 'panel-host' }, this.panels.element);
  private readonly panelButton = h('button', { class: 'btn btn-sm btn-outline-secondary', title: 'Show or hide the side panel', onclick: () => this.togglePanel() }, icon('layout-sidebar-reverse'));

  async start(root: HTMLElement): Promise<void> {
    [this.settings, this.project, this.chat] = await Promise.all([
      api.invoke('settings:get'),
      api.invoke('project:current'),
      api.invoke('chat:snapshot'),
    ]);

    root.replaceChildren(this.layout());
    this.applyTheme();
    this.renderAll();

    api.on('settings:changed', (settings) => {
      this.settings = settings;
      this.applyTheme();
      this.renderHeader();
      void this.renderWelcome();
    });
    api.on('project:changed', (project) => {
      this.project = project;
      this.panels.projectChanged();
      this.renderHeader();
      void this.renderWelcome();
    });
    api.on('chat:snapshot', (snapshot) => {
      this.chat = snapshot;
      this.pendingEvents = [];
      this.transcript.reset();
      this.renderAll();
    });
    api.on('chat:event', ({ chatId, event }) => {
      if (chatId !== this.chat.id) return;
      this.pendingEvents.push(event);
      if (event.type === 'tool-end') this.panels.filesChanged();
      // Stream deltas arrive quickly; apply them in batches once per frame.
      this.frame ||= requestAnimationFrame(() => this.flushEvents());
    });
    api.on('menu:command', (command) => {
      if (command === 'open-project') void this.chooseProject();
      else if (command === 'new-chat') void this.newChat();
      else if (command === 'stop') void api.invoke('chat:stop');
      else if (command === 'settings') this.openSettings();
    });
    api.on('panel:show', (name) => {
      this.setPanelVisible(true);
      this.panels.show(name);
    });
    this.setPanelVisible(readPreference('panelVisible') !== 'false');
    this.panels.show('terminal');
    document.addEventListener('click', (event) => {
      if (!this.projectMenu.contains(event.target as Node) && !this.projectButton.contains(event.target as Node)) {
        this.projectMenu.classList.remove('show');
      }
      // Links in rendered markdown: http(s) opens in the system browser via the main process; others do nothing.
      const link = (event.target as HTMLElement).closest('a');
      if (link && !/^https?:/i.test(link.getAttribute('href') ?? '')) event.preventDefault();
    });

    this.composer.focus();
  }

  private layout(): HTMLElement {
    return h(
      'div',
      { class: 'app' },
      h(
        'header',
        { class: 'app-header' },
        h('div', { class: 'project-picker' }, this.projectButton, this.projectMenu),
        this.titleLabel,
        h(
          'div',
          { class: 'header-actions' },
          this.modeButton,
          this.panelButton,
          h('button', { class: 'btn btn-sm btn-outline-secondary', title: 'New chat (Ctrl+N)', onclick: () => void this.newChat() }, icon('plus-lg'), ' New chat'),
          this.exportButton,
          h('button', { class: 'btn btn-sm btn-outline-secondary', title: 'Chat history', onclick: () => void this.openHistory() }, icon('clock-history')),
          h('button', { class: 'btn btn-sm btn-outline-secondary', title: 'Settings (Ctrl+,)', onclick: () => this.openSettings() }, icon('gear')),
        ),
      ),
      h(
        'main',
        { class: 'app-main' },
        h('section', { class: 'chat-pane' }, h('div', { class: 'chat-scroll-wrap' }, this.chatScroll), this.composer.element),
        this.panelHost,
      ),
      h('footer', { class: 'app-footer' }, this.modelLabel, this.agentLabel, this.usageLabel),
      this.toastArea,
    );
  }

  private renderAll(): void {
    this.chatScroll.replaceChildren(this.welcome, this.transcript.element, this.transcript.announcer);
    this.transcript.render(this.chat.transcript);
    this.composer.setState(this.chat.busy, this.chat.resumable);
    this.renderHeader();
    void this.renderWelcome();
  }

  private flushEvents(): void {
    this.frame = 0;
    const events = this.pendingEvents;
    this.pendingEvents = [];
    let transcript = this.chat.transcript;
    for (const event of events) {
      transcript = applyChatEvent(transcript, event);
      if (event.type === 'busy') this.chat.busy = event.busy;
      if (event.type === 'resumable') this.chat.resumable = event.resumable;
      if (event.type === 'usage') this.chat.usage = event.totals;
      if (event.type === 'title') this.chat.title = event.title;
    }
    this.chat = { ...this.chat, transcript };
    this.transcript.render(transcript);
    this.composer.setState(this.chat.busy, this.chat.resumable);
    this.renderHeader();
    this.welcome.hidden = transcript.length > 0;
  }

  private renderHeader(): void {
    this.projectButton.replaceChildren(icon('folder2'), ' ', this.project?.name ?? 'Open project', ' ', icon('chevron-down', 'small'));
    this.projectButton.title = this.project?.path ?? 'Open a project folder';

    this.titleLabel.textContent = this.chat.transcript.length > 0 ? this.chat.title : '';
    this.exportButton.disabled = this.chat.transcript.length === 0;

    const auto = this.settings.approvalMode === 'auto';
    this.modeButton.className = `btn btn-sm mode-button ${auto ? 'btn-warning' : 'btn-outline-secondary'}`;
    this.modeButton.setAttribute('aria-pressed', String(auto));
    this.modeButton.replaceChildren(icon(auto ? 'lightning-charge' : 'shield-check'), auto ? ' Auto' : ' Ask first');
    this.modeButton.title = auto
      ? 'Edits and commands run without asking. Click to require approval.'
      : 'Edits and commands wait for your approval. Click to run them automatically.';

    const model = this.chat.transcript.length > 0 ? this.chat.model : this.settings.model;
    const label = MODEL_OPTIONS.find((option) => option.id === model)?.label ?? model;
    this.modelLabel.replaceChildren(icon('cpu'), ` ${label}`, this.settings.approvalMode === 'ask' ? '' : ' · auto');

    const agentFile = this.chat.agentFile;
    this.agentLabel.hidden = !agentFile;
    this.agentLabel.title = agentFile ? `${agentFile} from the project is included in this chat's instructions` : '';
    this.agentLabel.replaceChildren(...(agentFile ? [icon('file-earmark-check'), ` ${agentFile} loaded`] : []));

    const { inputTokens, outputTokens, cacheReadTokens } = this.chat.usage;
    const cacheWriteTokens = this.chat.usage.cacheWriteTokens ?? 0;
    const officialProvider =
      this.chat.officialPricing ?? (providerForModel(model) === 'anthropic' || !this.settings.openaiBaseUrl.trim());
    const cost = estimateCost(model, this.chat.usage, officialProvider);
    this.usageLabel.title = cost === null ? '' : 'Estimated from official list prices.';
    this.usageLabel.textContent =
      inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens > 0
        ? `Tokens: ${format(inputTokens)} in · ${format(cacheReadTokens)} read · ${format(cacheWriteTokens)} written · ${format(outputTokens)} out${cost === null ? '' : ` · ≈ ${formatCost(cost)}`}`
        : '';
  }

  private async renderWelcome(): Promise<void> {
    // Several updates can arrive together (new chat + project change); only the latest render may finish.
    const generation = ++this.welcomeGeneration;
    this.welcome.hidden = this.chat.transcript.length > 0;
    if (this.welcome.hidden) return;

    if (!this.project) {
      const projects = await api.invoke('project:list');
      if (generation !== this.welcomeGeneration) return;
      setChildren(this.welcome, 
        h('h1', { class: 'h4' }, 'Open a project to start'),
        h('p', { class: 'text-body-secondary' }, 'CodeCompanion works inside a project folder: it reads and edits files there and runs commands in it.'),
        h('button', { class: 'btn btn-primary', onclick: () => void this.chooseProject() }, icon('folder-plus'), ' Open folder…'),
        projects.length > 0 ? h('h2', { class: 'h6 mt-4 text-body-secondary' }, 'Recent') : null,
        h('div', { class: 'list-group recent-projects' }, ...projects.map((project) => this.recentProjectItem(project))),
      );
      return;
    }

    const provider = providerForModel(this.settings.model);
    const missingKey = provider === 'anthropic' ? !this.settings.secrets.anthropicApiKey : !this.settings.secrets.openaiApiKey;
    setChildren(this.welcome, 
      h('h1', { class: 'h4' }, this.project.name),
      h('p', { class: 'text-body-secondary small' }, this.project.path),
      missingKey
        ? h(
            'div',
            { class: 'alert alert-warning' },
            `Add your ${provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} API key to start. `,
            h('button', { class: 'btn btn-sm btn-warning ms-2', onclick: () => this.openSettings() }, 'Open settings'),
          )
        : null,
      h(
        'ul',
        { class: 'text-body-secondary tips' },
        h('li', {}, 'Describe a task: "Add input validation to the signup form and a test for it."'),
        h('li', {}, 'Ask about the code: "How does authentication work here?"'),
        h('li', {}, this.settings.approvalMode === 'ask' ? 'You approve each file change and command before it runs.' : 'Auto mode is on: changes and commands run without asking.'),
        !this.settings.secrets.openaiApiKey ? h('li', {}, 'Add an OpenAI key in settings to enable semantic code search.') : null,
      ),
      h(
        'button',
        { class: 'btn btn-sm btn-outline-secondary', onclick: () => this.editInstructions() },
        icon('journal-text'),
        this.project.instructions ? ' Edit project instructions' : ' Add project instructions',
      ),
    );
  }

  private recentProjectItem(project: ProjectInfo): HTMLElement {
    return h(
      'div',
      { class: 'list-group-item d-flex align-items-center gap-2' },
      h(
        'button',
        { class: 'btn btn-link text-start text-decoration-none flex-grow-1 p-0 text-body', onclick: () => void this.openProject(project.path) },
        h('div', { class: 'fw-semibold' }, project.name),
        h('div', { class: 'small text-body-secondary text-truncate' }, project.path),
      ),
      h(
        'button',
        {
          class: 'btn btn-sm btn-outline-secondary',
          title: 'Remove from recent',
          onclick: async () => {
            await api.invoke('project:remove', project.path);
            void this.renderWelcome();
          },
        },
        icon('x-lg'),
      ),
    );
  }

  private async toggleProjectMenu(): Promise<void> {
    if (this.projectMenu.classList.toggle('show')) {
      const projects = await api.invoke('project:list');
      const item = (label: HTMLElement | string, action: () => void, disabled = false) =>
        h('button', { class: 'dropdown-item', disabled, onclick: () => (this.projectMenu.classList.remove('show'), action()) }, label);
      setChildren(this.projectMenu, 
        item(h('span', {}, icon('folder-plus'), ' Open folder…'), () => void this.chooseProject()),
        item(h('span', {}, icon('journal-text'), ' Project instructions…'), () => this.editInstructions(), !this.project),
        projects.length > 0 ? h('div', { class: 'dropdown-divider' }) : null,
        ...projects.map((project) =>
          item(
            h('span', {}, project.path === this.project?.path ? icon('check2') : icon('folder2'), ` ${project.name}`),
            () => void this.openProject(project.path),
          ),
        ),
      );
    }
  }

  private async send(text: string, images: ImageAttachment[]): Promise<boolean> {
    try {
      await api.invoke('chat:send', { text, images: images.map(({ mediaType, base64 }) => ({ mediaType, base64 })) });
      return true;
    } catch (error) {
      this.toast(error);
      return false;
    }
  }

  private async chooseProject(): Promise<void> {
    try {
      await api.invoke('project:choose');
    } catch (error) {
      this.toast(error);
    }
  }

  private async openProject(path: string): Promise<void> {
    try {
      await api.invoke('project:open', path);
    } catch (error) {
      this.toast(error);
    }
  }

  private async newChat(): Promise<void> {
    await api.invoke('chat:new');
    this.composer.focus();
  }

  private async toggleMode(): Promise<void> {
    await api.invoke('settings:update', { approvalMode: this.settings.approvalMode === 'ask' ? 'auto' : 'ask' });
  }

  private openSettings(): void {
    openSettingsDialog(this.settings, {
      update: (patch) => api.invoke('settings:update', patch),
      setSecret: (name, value) => api.invoke('settings:set-secret', name, value),
      indexStatus: () => api.invoke('index:status'),
      rebuildIndex: () => api.invoke('index:rebuild'),
    });
  }

  private async exportChat(): Promise<void> {
    try {
      const path = await api.invoke('chat:export');
      if (path) this.toast(`Saved ${path}`, 'success');
    } catch (error) {
      this.toast(error);
    }
  }

  private async openHistory(): Promise<void> {
    openHistoryDialog(await api.invoke('history:list'), {
      open: async (id) => {
        try {
          await api.invoke('history:open', id);
        } catch (error) {
          this.toast(error);
        }
      },
      delete: (id) => api.invoke('history:delete', id),
      clear: () => api.invoke('history:clear'),
      search: (query) => api.invoke('history:search', query),
    });
  }

  private editInstructions(): void {
    const project = this.project;
    if (!project) return;
    openInstructionsDialog(project, async (text) => {
      this.project = await api.invoke('project:set-instructions', project.path, text);
      void this.renderWelcome();
    });
  }

  private togglePanel(): void {
    this.setPanelVisible(this.panelHost.hidden);
  }

  private setPanelVisible(visible: boolean): void {
    this.panelHost.hidden = !visible;
    this.panelButton.classList.toggle('active', visible);
    writePreference('panelVisible', String(visible));
  }

  private applyTheme(): void {
    document.documentElement.dataset.bsTheme = this.settings.theme;
  }

  toast(error: unknown, kind: 'danger' | 'success' = 'danger'): void {
    const message = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error);
    const toast = h('div', { class: `app-toast alert alert-${kind} shadow`, role: 'alert' }, message);
    this.toastArea.appendChild(toast);
    setTimeout(() => toast.remove(), 6000);
  }
}

function format(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 100_000 ? 0 : 1)}k` : String(tokens);
}

// UI conveniences only (panel visibility); the app works the same when storage is unavailable.
function readPreference(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePreference(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Ignore.
  }
}
