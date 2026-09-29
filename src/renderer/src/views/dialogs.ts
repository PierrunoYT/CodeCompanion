import { filterChats, type ChatSummary } from '@shared/chat';
import { MODEL_OPTIONS, type Effort } from '@shared/models';
import type { IndexStatus } from '@shared/ipc';
import type { ProjectInfo } from '@shared/project';
import type { SecretName, Settings, SettingsView } from '@shared/settings';
import { h, icon } from '../dom';

function dialog(title: string, body: HTMLElement, footer: HTMLElement): HTMLDialogElement {
  const element = h(
    'dialog',
    { class: 'app-dialog' },
    h(
      'form',
      { method: 'dialog', class: 'dialog-content' },
      h(
        'div',
        { class: 'dialog-header' },
        h('h2', { class: 'h5 m-0' }, title),
        h('button', { class: 'btn-close', type: 'button', 'aria-label': 'Close', onclick: () => element.close() }),
      ),
      h('div', { class: 'dialog-body' }, body),
      h('div', { class: 'dialog-footer' }, footer),
    ),
  );
  element.addEventListener('close', () => element.remove());
  document.body.appendChild(element);
  element.showModal();
  return element;
}

function field(label: string, control: HTMLElement, help?: string): HTMLElement {
  const id = `field-${Math.random().toString(36).slice(2)}`;
  // The label must point at the input itself, which may be wrapped (e.g. in an input group).
  const target = control.matches('input, select, textarea') ? control : control.querySelector('input, select, textarea');
  (target ?? control).id = id;
  return h(
    'div',
    { class: 'mb-3' },
    h('label', { class: 'form-label', for: id }, label),
    control,
    help ? h('div', { class: 'form-text' }, help) : null,
  );
}

const SECRET_LABELS: Record<SecretName, [string, string]> = {
  anthropicApiKey: ['Anthropic API key', 'Needed for Claude models.'],
  openaiApiKey: ['OpenAI API key', 'Needed for OpenAI models and for semantic code search (embeddings).'],
  googleApiKey: ['Google API key', 'Optional, for web search. Also set the search engine id below.'],
};

export interface SettingsDialogActions {
  update(patch: Partial<Settings>): Promise<SettingsView>;
  setSecret(name: SecretName, value: string): Promise<SettingsView>;
  indexStatus(): Promise<IndexStatus>;
  rebuildIndex(): Promise<IndexStatus>;
}

export function openSettingsDialog(settings: SettingsView, actions: SettingsDialogActions): void {
  const secretInputs = new Map<SecretName, HTMLInputElement>();
  const secretFields = (Object.keys(SECRET_LABELS) as SecretName[]).map((name) => {
    const [label, help] = SECRET_LABELS[name];
    const input = h('input', {
      type: 'password',
      class: 'form-control',
      autocomplete: 'off',
      placeholder: settings.secrets[name] ? 'Saved. Enter a new key to replace it.' : 'Not set',
    });
    secretInputs.set(name, input);
    const remove = settings.secrets[name]
      ? h(
          'button',
          {
            type: 'button',
            class: 'btn btn-outline-danger',
            onclick: async () => {
              await actions.setSecret(name, '');
              input.placeholder = 'Not set';
              remove?.remove();
            },
          },
          'Remove',
        )
      : null;
    return field(label, h('div', { class: 'input-group' }, input, remove), help);
  });

  const known = MODEL_OPTIONS.some((option) => option.id === settings.model);
  const modelSelect = h(
    'select',
    { class: 'form-select' },
    ...MODEL_OPTIONS.map((option) => h('option', { value: option.id, selected: option.id === settings.model }, option.label)),
    h('option', { value: '__custom', selected: !known }, 'Other model id…'),
  );
  const customModel = h('input', { class: 'form-control mt-2', value: known ? '' : settings.model, placeholder: 'e.g. claude-sonnet-5-5', hidden: known });
  modelSelect.addEventListener('change', () => (customModel.hidden = modelSelect.value !== '__custom'));

  const effort = h(
    'select',
    { class: 'form-select' },
    ...(['low', 'medium', 'high', 'xhigh', 'max'] as Effort[]).map((level) => h('option', { value: level, selected: level === settings.effort }, level)),
  );
  const approval = h(
    'select',
    { class: 'form-select' },
    h('option', { value: 'ask', selected: settings.approvalMode === 'ask' }, 'Ask before edits and commands'),
    h('option', { value: 'auto', selected: settings.approvalMode === 'auto' }, 'Run edits and commands without asking'),
  );
  const theme = h(
    'select',
    { class: 'form-select' },
    h('option', { value: 'dark', selected: settings.theme === 'dark' }, 'Dark'),
    h('option', { value: 'light', selected: settings.theme === 'light' }, 'Light'),
  );
  const baseUrl = h('input', { class: 'form-control', value: settings.openaiBaseUrl, placeholder: 'https://api.openai.com/v1' });
  const searchEngine = h('input', { class: 'form-control', value: settings.googleSearchEngineId });
  const editor = h('input', { class: 'form-control', value: settings.editorCommand });
  const maxFiles = h('input', { class: 'form-control', type: 'number', min: 1, value: String(settings.maxIndexedFiles) });
  const error = h('div', { class: 'text-danger me-auto small' });

  const indexText = h('span', { class: 'small text-body-secondary flex-grow-1' }, 'Checking…');
  const reindex = h('button', { type: 'button', class: 'btn btn-outline-secondary btn-sm', disabled: true }, 'Reindex');
  const showIndex = (status: IndexStatus) => {
    indexText.textContent = !status.available
      ? `Not available: ${status.reason ?? 'no project'}`
      : status.indexing
        ? 'Indexing…'
        : status.indexed
          ? `Indexed: ${status.files} files, ${status.chunks} chunks`
          : 'Not indexed yet';
    reindex.disabled = !status.available || status.indexing;
  };
  reindex.addEventListener('click', async () => {
    reindex.disabled = true;
    indexText.textContent = 'Indexing… this can take a while';
    try {
      showIndex(await actions.rebuildIndex());
    } catch (err) {
      indexText.textContent = `Indexing failed: ${err instanceof Error ? err.message : String(err)}`;
      reindex.disabled = false;
    }
  });
  actions.indexStatus().then(showIndex, () => (indexText.textContent = 'Status unavailable'));
  const indexSection = h(
    'div',
    { class: 'mb-3' },
    h('div', { class: 'form-label' }, 'Code index (current project)'),
    h('div', { class: 'd-flex align-items-center gap-2' }, indexText, reindex),
  );

  const body = h(
    'div',
    {},
    h('h3', { class: 'h6 text-body-secondary' }, 'API keys'),
    !settings.secretsEncrypted
      ? h('div', { class: 'alert alert-warning py-2 small' }, 'System encryption is unavailable, so keys are stored unencrypted.')
      : null,
    ...secretFields,
    h('h3', { class: 'h6 text-body-secondary mt-4' }, 'Assistant'),
    field('Model', h('div', {}, modelSelect, customModel)),
    field('Effort', effort, 'How much the model thinks before acting (current Claude and OpenAI models). Higher is slower and costs more.'),
    field('Approvals', approval),
    h('h3', { class: 'h6 text-body-secondary mt-4' }, 'Other'),
    field('Theme', theme),
    field('Editor command', editor, 'Opens files from the chat, e.g. code, cursor, subl.'),
    field('OpenAI-compatible base URL', baseUrl, 'Leave empty for api.openai.com.'),
    field('Google search engine id', searchEngine),
    field('Maximum files to index for code search', maxFiles),
    indexSection,
  );

  const save = h('button', { type: 'button', class: 'btn btn-primary' }, 'Save');
  const element = dialog('Settings', body, h('div', { class: 'd-flex w-100 align-items-center gap-2' }, error, h('button', { type: 'button', class: 'btn btn-outline-secondary', onclick: () => element.close() }, 'Cancel'), save));

  save.addEventListener('click', async () => {
    try {
      for (const [name, input] of secretInputs) {
        if (input.value.trim()) await actions.setSecret(name, input.value);
      }
      const model = modelSelect.value === '__custom' ? customModel.value.trim() : modelSelect.value;
      await actions.update({
        model,
        effort: effort.value as Effort,
        approvalMode: approval.value as Settings['approvalMode'],
        theme: theme.value as Settings['theme'],
        openaiBaseUrl: baseUrl.value.trim(),
        googleSearchEngineId: searchEngine.value.trim(),
        editorCommand: editor.value.trim(),
        maxIndexedFiles: Number(maxFiles.value),
      });
      element.close();
    } catch (err) {
      error.textContent = err instanceof Error ? err.message : String(err);
    }
  });
}

export function openInstructionsDialog(project: ProjectInfo, save: (text: string) => Promise<unknown>): void {
  const text = h('textarea', { class: 'form-control font-monospace', rows: 12, value: project.instructions });
  const button = h('button', { type: 'button', class: 'btn btn-primary' }, 'Save');
  const element = dialog(
    `Instructions for ${project.name}`,
    h(
      'div',
      {},
      h('p', { class: 'text-body-secondary small' }, 'Added to every new chat in this project, e.g. commands to run tests, coding conventions or things to avoid.'),
      text,
    ),
    button,
  );
  button.addEventListener('click', async () => {
    await save(text.value);
    element.close();
  });
}

export interface HistoryDialogActions {
  open(id: string): Promise<void>;
  delete(id: string): Promise<ChatSummary[]>;
  clear(): Promise<ChatSummary[]>;
}

export function openHistoryDialog(chats: ChatSummary[], actions: HistoryDialogActions): void {
  const list = h('div', { class: 'list-group history-list' });
  const search = h('input', {
    type: 'search',
    class: 'form-control mb-2',
    placeholder: 'Search chats by title or project',
    'aria-label': 'Search chats',
  }) as HTMLInputElement;
  let all = chats;
  const render = (items: ChatSummary[]) => {
    all = items;
    const shown = filterChats(items, search.value);
    list.replaceChildren(
      ...(shown.length === 0
        ? [h('div', { class: 'text-body-secondary p-3' }, items.length === 0 ? 'No saved chats yet.' : 'No chats match your search.')]
        : shown.map((chat) =>
            h(
              'div',
              { class: 'list-group-item list-group-item-action d-flex align-items-center gap-2' },
              h(
                'button',
                {
                  type: 'button',
                  class: 'btn btn-link text-start text-decoration-none flex-grow-1 p-0 text-body',
                  onclick: async () => {
                    await actions.open(chat.id);
                    element.close();
                  },
                },
                h('div', { class: 'fw-semibold text-truncate' }, chat.title),
                h(
                  'div',
                  { class: 'small text-body-secondary text-truncate' },
                  `${new Date(chat.updatedAt).toLocaleString()}${chat.projectPath ? ` · ${chat.projectPath}` : ''}`,
                ),
              ),
              h(
                'button',
                { type: 'button', class: 'btn btn-sm btn-outline-secondary', title: 'Delete', onclick: async () => render(await actions.delete(chat.id)) },
                icon('trash'),
              ),
            ),
          )),
    );
  };
  search.addEventListener('input', () => render(all));
  // The dialog is a form: Enter in the search box must not submit it and close the dialog.
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') event.preventDefault();
  });
  render(chats);
  const clearButton = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-outline-danger',
      onclick: async () => {
        if (confirm('Delete all saved chats?')) render(await actions.clear());
      },
    },
    icon('trash'),
    ' Delete all',
  );
  const element = dialog('Chat history', h('div', {}, search, list), clearButton);
  search.focus();
}
