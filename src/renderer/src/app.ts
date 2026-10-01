import { applyChatEvent, type ChatEvent, type ChatSnapshot } from '@shared/chat';
import type { ImageAttachment } from '@shared/ipc';
import {
  acceptsImages,
  COMPACT_SUGGESTED_TOKENS,
  estimateCost,
  formatCost,
  imagesNotSupportedMessage,
  MODEL_OPTIONS,
  providerForModel,
} from '@shared/models';
import type { ProjectInfo } from '@shared/project';
import type { SettingsView } from '@shared/settings';
import { h, icon, setChildren } from './dom';
import { Composer } from './views/composer';
import { openHistoryDialog, openProjectSettingsDialog, openSettingsDialog } from './views/dialogs';
import { Panels } from './views/panels';
import { Sidebar } from './views/sidebar';
import { TranscriptView } from './views/transcript';

const api = window.api;

export class App {
  private settings!: SettingsView;
  private project: ProjectInfo | null = null;
  private chat!: ChatSnapshot;
  private pendingEvents: ChatEvent[] = [];
  private frame = 0;
  private welcomeGeneration = 0;
  private projectGeneration = 0;
  private readonly drafts = new Map<string, ReturnType<Composer['getDraft']>>();
  private readonly projectTabs = h('nav', { class: 'project-tabs', 'aria-label': 'Open projects', hidden: true });

  private readonly transcript = new TranscriptView({
    decide: (id, decision) => void api.invoke('chat:decide', id, decision),
    openFile: (path) => void api.invoke('files:open-in-editor', path).catch((error) => this.toast(error)),
    undoEdit: (id, path) => void this.undoEdit(id, path),
    theme: () => this.settings.theme,
  });
  private readonly composer = new Composer({
    send: (text, images) => this.send(text, images),
    stop: () => void api.invoke('chat:stop'),
    resume: () => void api.invoke('chat:resume').catch((error) => this.toast(error)),
    pickImages: () => api.invoke('files:pick-images').catch((error) => (this.toast(error), [])),
    notice: (message) => this.toast(message),
  });

  private readonly sidebar = new Sidebar({
    list: () => api.invoke('history:list'),
    search: (query) => api.invoke('history:search', query),
    open: (id) => void api.invoke('history:open', id).catch((error) => this.toast(error)),
    newChat: () => void this.newChat(),
  });
  private readonly projectButton = h('button', {
    class: 'btn btn-sm btn-ghost project-button',
    onclick: () => this.toggleProjectMenu(),
  });
  private readonly projectMenu = h('div', { class: 'dropdown-menu project-menu' });
  private readonly modelSelect = h('select', {
    class: 'form-select form-select-sm model-select',
    'aria-label': 'Model',
    onchange: () => void this.chooseModel(),
  }) as HTMLSelectElement;
  private readonly askButton = h(
    'button',
    { class: 'mode-option', onclick: () => void this.setMode('ask') },
    icon('shield-check'),
    ' Ask first',
  );
  private readonly autoButton = h(
    'button',
    { class: 'mode-option', onclick: () => void this.setMode('auto') },
    icon('lightning-charge'),
    ' Auto',
  );
  private readonly planSwitch = h('input', {
    type: 'checkbox',
    role: 'switch',
    class: 'form-check-input',
    id: 'plan-mode-switch',
    onchange: () => void this.setPlanMode(),
  }) as HTMLInputElement;
  private readonly branchLabel = h('span', { class: 'status-item', hidden: true });
  private readonly agentLabel = h('span', { class: 'status-item' });
  private readonly contextMeter = h('span', { class: 'context-meter', 'aria-hidden': 'true' }, h('span'));
  private readonly contextText = h('span');
  private readonly contextLabel = h(
    'span',
    { class: 'status-item context-item ms-auto', hidden: true },
    this.contextText,
    this.contextMeter,
  );
  private readonly usageLabel = h('span', { class: 'status-item' });
  private branchGeneration = 0;
  private readonly chatScroll = h('div', { class: 'chat-scroll' });
  private readonly welcome = h('div', { class: 'welcome' });
  private readonly toastArea = h('div', { class: 'toast-area' });
  private readonly panels = new Panels(
    () => this.settings.theme,
    (error) => this.toast(error),
    () => this.project !== null,
  );
  private readonly compactButton = h(
    'button',
    { class: 'btn btn-sm btn-ghost', 'aria-label': 'Compact chat', onclick: () => void this.compactChat() },
    icon('arrows-collapse'),
  );
  private readonly exportButton = h(
    'button',
    {
      class: 'btn btn-sm btn-ghost',
      title: 'Export this chat as Markdown',
      'aria-label': 'Export chat',
      onclick: () => void this.exportChat(),
    },
    icon('download'),
  );
  private readonly panelHost = h('div', { class: 'panel-host' }, this.panels.element);
  private readonly panelButton = h(
    'button',
    { class: 'btn btn-sm btn-ghost', title: 'Show or hide the side panel', onclick: () => this.togglePanel() },
    icon('layout-sidebar-reverse'),
  );
  private readonly sidebarButton = h(
    'button',
    { class: 'btn btn-sm btn-ghost', title: 'Show or hide the chat list', onclick: () => this.toggleSidebar() },
    icon('layout-sidebar'),
  );

  async start(root: HTMLElement): Promise<void> {
    [this.settings, this.project, this.chat] = await Promise.all([
      api.invoke('settings:get'),
      api.invoke('project:current'),
      api.invoke('chat:snapshot'),
    ]);

    root.replaceChildren(this.layout());
    this.applyTheme();
    this.renderAll();
    void this.renderProjects();
    void this.sidebar.refresh();
    void this.renderBranch();

    api.on('history:changed', (chats) => this.sidebar.update(chats));
    api.on('settings:changed', (settings) => {
      this.settings = settings;
      this.applyTheme();
      this.renderHeader();
      void this.renderWelcome();
    });
    api.on('project:changed', (project) => {
      if (project?.path !== this.project?.path) {
        if (this.project) this.drafts.set(this.project.path, this.composer.getDraft());
        this.composer.setDraft(this.drafts.get(project?.path ?? '') ?? { text: '', images: [] });
      }
      this.project = project;
      this.panels.projectChanged();
      void this.renderBranch();
      this.renderHeader();
      void this.renderWelcome();
      void this.renderProjects();
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
    this.setSidebarVisible(readPreference('sidebarVisible') !== 'false');
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
        h(
          'span',
          { class: 'brand' },
          h('span', { class: 'brand-mark', role: 'img', 'aria-label': 'Patch' }),
          h('span', { class: 'brand-name', 'aria-hidden': 'true' }, 'Patch'),
        ),
        h('span', { class: 'header-divider', 'aria-hidden': 'true' }),
        h('div', { class: 'project-picker' }, this.projectButton, this.projectMenu),
        this.projectTabs,
        h(
          'div',
          { class: 'header-controls' },
          this.modelSelect,
          h(
            'div',
            { class: 'mode-toggle', role: 'group', 'aria-label': 'Approval mode' },
            this.askButton,
            this.autoButton,
          ),
          h(
            'div',
            {
              class: 'form-check form-switch plan-switch',
              title: 'Plan mode: before multi-step changes, the assistant shows its plan for approval',
            },
            this.planSwitch,
            h('label', { class: 'form-check-label', for: 'plan-mode-switch' }, 'Plan'),
          ),
        ),
        h(
          'div',
          { class: 'header-actions' },
          this.compactButton,
          this.exportButton,
          h(
            'button',
            { class: 'btn btn-sm btn-ghost', title: 'Chat history', onclick: () => void this.openHistory() },
            icon('clock-history'),
          ),
          h('span', { class: 'header-divider', 'aria-hidden': 'true' }),
          this.sidebarButton,
          this.panelButton,
          h(
            'button',
            { class: 'btn btn-sm btn-ghost', title: 'Settings (Ctrl+,)', onclick: () => this.openSettings() },
            icon('gear'),
          ),
        ),
      ),
      h(
        'main',
        { class: 'app-main' },
        this.sidebar.element,
        h(
          'section',
          { class: 'chat-pane' },
          h('div', { class: 'chat-scroll-wrap' }, this.chatScroll),
          this.composer.element,
        ),
        this.panelHost,
      ),
      h('footer', { class: 'app-footer' }, this.branchLabel, this.agentLabel, this.contextLabel, this.usageLabel),
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
      if (event.type === 'busy') {
        this.chat.busy = event.busy;
        if (!event.busy) void this.renderBranch();
      }
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
    // With a project open, its tab shows the name; the button keeps it for screen readers and as the menu's label.
    this.projectButton.replaceChildren(
      icon(this.project ? 'folder2-open' : 'folder2'),
      h('span', { class: this.project ? 'visually-hidden' : '' }, ` ${this.project?.name ?? 'Open project'}`),
      ' ',
      icon('chevron-down', 'small'),
    );
    this.projectButton.title = this.project ? `Projects (${this.project.path})` : 'Open a project folder';
    this.sidebar.setActive(this.chat.id);
    this.exportButton.disabled = this.chat.transcript.length === 0;

    // How full the context is: the size of the last request's prompt. Nudge towards compacting once it is large.
    const contextTokens = this.chat.usage.contextTokens;
    const nearLimit = contextTokens !== undefined && contextTokens >= COMPACT_SUGGESTED_TOKENS;
    this.compactButton.disabled = this.chat.transcript.length === 0 || this.chat.busy;
    this.compactButton.className = `btn btn-sm ${nearLimit ? 'btn-warning' : 'btn-ghost'}`;
    this.compactButton.title = nearLimit
      ? `The prompt is about ${format(contextTokens)} tokens. Summarize the older messages to free up context.`
      : 'Compact chat: summarize the older messages to free up context';
    this.contextLabel.hidden = contextTokens === undefined;
    // Whichever of the two comes first on the right pushes them there.
    this.usageLabel.classList.toggle('ms-auto', this.contextLabel.hidden);
    this.contextText.textContent =
      contextTokens === undefined
        ? ''
        : `Context: ${format(contextTokens)}${nearLimit ? ' · consider compacting' : ''}`;
    // The bar fills up towards the size at which compacting is suggested.
    const fill = Math.min(1, (contextTokens ?? 0) / COMPACT_SUGGESTED_TOKENS);
    (this.contextMeter.firstElementChild as HTMLElement).style.width = `${Math.round(fill * 100)}%`;
    this.contextLabel.title = `Size of the latest prompt; compacting is suggested from ${format(COMPACT_SUGGESTED_TOKENS)} tokens.`;
    this.contextLabel.classList.toggle('text-warning-emphasis', nearLimit);
    this.contextLabel.classList.toggle('near-limit', nearLimit);

    const auto = this.settings.approvalMode === 'auto';
    this.askButton.classList.toggle('active', !auto);
    this.askButton.setAttribute('aria-pressed', String(!auto));
    this.askButton.title = 'Edits and commands wait for your approval.';
    this.autoButton.classList.toggle('active', auto);
    this.autoButton.setAttribute('aria-pressed', String(auto));
    this.autoButton.title = 'Edits and commands run without asking. MCP tools and plans still ask.';
    this.planSwitch.checked = this.settings.planMode;

    // A chat keeps its model; the picker sets the model for new chats, so it is locked once the chat has started.
    const started = this.chat.transcript.length > 0;
    const model = started ? this.chat.model : this.settings.model;
    const options = MODEL_OPTIONS.some((option) => option.id === model)
      ? MODEL_OPTIONS
      : [...MODEL_OPTIONS, { id: model, label: model }];
    // Rebuilt only when the model changes: the header is rendered on every streamed frame, and a rebuilt list would
    // close the picker while it is open.
    if (this.modelSelect.value !== model || this.modelSelect.options.length !== options.length) {
      this.modelSelect.replaceChildren(...options.map((option) => h('option', { value: option.id }, option.label)));
      this.modelSelect.value = model;
    }
    this.modelSelect.disabled = started || this.chat.busy;
    this.modelSelect.title = started
      ? 'A chat keeps its model. Start a new chat to use another one.'
      : 'Model for this chat';
    this.composer.setImagesBlocked(acceptsImages(model) ? null : imagesNotSupportedMessage(model));

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
      setChildren(
        this.welcome,
        h('span', { class: 'brand-mark large', 'aria-hidden': 'true' }),
        h('h1', { class: 'h4' }, 'Open a project to start'),
        h(
          'p',
          { class: 'text-body-secondary' },
          'Patch works inside a project folder: it reads and edits files there and runs commands in it.',
        ),
        h(
          'button',
          { class: 'btn btn-primary', onclick: () => void this.chooseProject() },
          icon('folder-plus'),
          ' Open folder…',
        ),
        projects.length > 0 ? h('h2', { class: 'h6 mt-4 text-body-secondary' }, 'Recent') : null,
        h(
          'div',
          { class: 'list-group recent-projects' },
          ...projects.map((project) => this.recentProjectItem(project)),
        ),
      );
      return;
    }

    const provider = providerForModel(this.settings.model);
    const missingKey =
      provider === 'anthropic' ? !this.settings.secrets.anthropicApiKey : !this.settings.secrets.openaiApiKey;
    setChildren(
      this.welcome,
      h('span', { class: 'brand-mark large', 'aria-hidden': 'true' }),
      h('h1', { class: 'h4' }, this.project.name),
      h('p', { class: 'text-body-secondary small font-monospace' }, this.project.path),
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
        h(
          'li',
          {},
          this.settings.approvalMode === 'ask'
            ? 'You approve each file change and command before it runs.'
            : 'Auto mode is on: changes and commands run without asking.',
        ),
        !this.settings.secrets.openaiApiKey
          ? h('li', {}, 'Add an OpenAI key in settings to enable semantic code search.')
          : null,
      ),
      h(
        'button',
        { class: 'btn btn-sm btn-outline-secondary', onclick: () => this.editProjectSettings() },
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
        {
          class: 'btn btn-link text-start text-decoration-none flex-grow-1 p-0 text-body',
          onclick: () => void this.openProject(project.path),
        },
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
        h(
          'button',
          { class: 'dropdown-item', disabled, onclick: () => (this.projectMenu.classList.remove('show'), action()) },
          label,
        );
      setChildren(
        this.projectMenu,
        item(h('span', {}, icon('folder-plus'), ' Open folder…'), () => void this.chooseProject()),
        item(
          h('span', {}, icon('journal-text'), ' Project settings…'),
          () => this.editProjectSettings(),
          !this.project,
        ),
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
    try {
      await api.invoke('chat:new');
      this.composer.focus();
    } catch (error) {
      this.toast(error);
    }
  }

  private async renderProjects(): Promise<void> {
    const generation = ++this.projectGeneration;
    const projects = await api.invoke('project:opened');
    if (generation !== this.projectGeneration) return;
    for (const path of this.drafts.keys()) {
      if (!projects.some((project) => project.path === path)) this.drafts.delete(path);
    }
    this.projectTabs.hidden = projects.length === 0;
    this.projectTabs.replaceChildren(
      ...projects.map((project) =>
        h(
          'div',
          { class: `project-tab${project.path === this.project?.path ? ' active' : ''}` },
          h(
            'button',
            {
              title: project.path,
              'aria-pressed': String(project.path === this.project?.path),
              onclick: () => void this.openProject(project.path),
            },
            project.name,
          ),
          h(
            'button',
            {
              'aria-label': `Close project ${project.name}`,
              onclick: () => void api.invoke('project:close', project.path).catch((error) => this.toast(error)),
            },
            icon('x-lg'),
          ),
        ),
      ),
      h(
        'button',
        { class: 'project-tab-add', title: 'Open another project…', onclick: () => void this.chooseProject() },
        icon('plus-lg'),
      ),
    );
  }

  private async setMode(mode: 'ask' | 'auto'): Promise<void> {
    if (mode === this.settings.approvalMode) return;
    // Switching to Auto asks for confirmation in the main process; cancelling it rejects and leaves the mode as it was.
    await api.invoke('settings:update', { approvalMode: mode }).catch((error) => this.toast(error));
  }

  private async setPlanMode(): Promise<void> {
    const planMode = this.planSwitch.checked;
    await api.invoke('settings:update', { planMode }).catch((error) => {
      this.planSwitch.checked = !planMode;
      this.toast(error);
    });
  }

  private async chooseModel(): Promise<void> {
    const model = this.modelSelect.value;
    await api.invoke('settings:update', { model }).catch((error) => {
      this.modelSelect.value = this.settings.model;
      this.toast(error);
    });
  }

  // The current branch in the status bar; refreshed when the project changes and after each run.
  private async renderBranch(): Promise<void> {
    const generation = ++this.branchGeneration;
    // Without a project the main process would reject the call (and log an error), so do not ask.
    const status = this.project ? await api.invoke('git:status').catch(() => null) : null;
    if (generation !== this.branchGeneration) return;
    const branch = status?.isRepo ? (status.branch ?? 'detached') : null;
    this.branchLabel.hidden = branch === null;
    this.branchLabel.title = branch && status?.files.length ? `${status.files.length} changed file(s)` : '';
    this.branchLabel.replaceChildren(...(branch ? [icon('git'), ` ${branch}${status?.files.length ? ' *' : ''}`] : []));
  }

  private openSettings(): void {
    openSettingsDialog(this.settings, {
      update: (patch) => api.invoke('settings:update', patch),
      setSecret: (name, value) => api.invoke('settings:set-secret', name, value),
      indexStatus: () => api.invoke('index:status'),
      rebuildIndex: () => api.invoke('index:rebuild'),
      mcpStatus: () => api.invoke('mcp:status'),
    });
  }

  private async undoEdit(id: string, path: string | undefined): Promise<void> {
    // Said before asking, not after the user has confirmed.
    if (this.chat.busy) {
      this.toast('Stop the current task, or wait for it to finish, before undoing an edit.');
      return;
    }
    if (!confirm(`Undo this change to ${path ?? 'the file'}? The file goes back to how it was before the edit.`))
      return;
    try {
      const result = await api.invoke('edit:undo', id);
      this.toast(result.action === 'deleted' ? `Deleted ${result.path}` : `Restored ${result.path}`, 'success');
      // Files changed outside a tool call, so the Git view has to be refreshed here.
      this.panels.filesChanged();
    } catch (error) {
      this.toast(error);
    }
  }

  private async compactChat(): Promise<void> {
    try {
      await api.invoke('chat:compact');
    } catch (error) {
      this.toast(error);
    }
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

  private editProjectSettings(): void {
    const project = this.project;
    if (!project) return;
    openProjectSettingsDialog(project, async (settings) => {
      const updated = await api.invoke('project:update-settings', project.path, settings);
      // The user may have switched projects while the dialog was open.
      if (this.project?.path === updated.path) this.project = updated;
      void this.renderWelcome();
    });
  }

  private togglePanel(): void {
    this.setPanelVisible(this.panelHost.hidden);
  }

  private toggleSidebar(): void {
    this.setSidebarVisible(this.sidebar.element.hidden);
  }

  private setSidebarVisible(visible: boolean): void {
    this.sidebar.element.hidden = !visible;
    this.sidebarButton.classList.toggle('active', visible);
    writePreference('sidebarVisible', String(visible));
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
    const message =
      error instanceof Error
        ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
        : String(error);
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
