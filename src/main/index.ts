import { app, BrowserWindow, dialog, safeStorage } from 'electron';
import { join } from 'node:path';
import { SECRET_NAMES } from '@shared/settings';
import { ChatManager } from './chat_manager';
import { ChatStore } from './chat_store';
import { chatToMarkdown, exportFileName } from '@shared/export';
import { openInEditor, pickImages, saveTextFile } from './files';
import { handle, send } from './ipc';
import { LlmService } from './llm';
import { createOpenAIClient } from './llm/openai';
import { CodeIndex, openAIEmbedder, searchCodeTool } from './search/code_index';
import { buildMenu } from './menu';
import { ProjectStore } from './projects';
import { SettingsStore } from './settings';
import { Workspace } from './tools/workspace';
import type { IndexStatus } from '@shared/ipc';
import { BrowserService } from './panels/browser';
import { GitService } from './panels/git';
import { TerminalService } from './panels/terminal';
import { createMainWindow } from './window';

app.setName('CodeCompanion');

// Lets tests (and anyone who wants a throwaway profile) run with separate settings and history.
if (process.env.CODECOMPANION_USER_DATA) {
  app.setPath('userData', process.env.CODECOMPANION_USER_DATA);
}

let mainWindow: BrowserWindow | null = null;

function createSettings(): SettingsStore {
  return new SettingsStore(join(app.getPath('userData'), 'settings.json'), {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (encoded) => safeStorage.decryptString(Buffer.from(encoded, 'base64')),
  });
}

function start(): void {
  const userData = app.getPath('userData');
  const settings = createSettings();
  const projects = new ProjectStore(join(userData, 'projects.json'));
  const chats = new ChatStore(join(userData, 'chats'));
  const llm = new LlmService(settings);
  const browser = new BrowserService(() => send(mainWindow, 'panel:show', 'browser'));
  const terminal = new TerminalService(
    (data) => send(mainWindow, 'terminal:data', data),
    () => send(mainWindow, 'terminal:exit', null),
  );
  const git = () => {
    const project = projects.current();
    if (!project) throw new Error('No project is open.');
    return new GitService(project.path);
  };
  const codeIndexes = new Map<string, CodeIndex>();
  // A changed key or endpoint means new embeddings; drop cached indexes so they are rebuilt with the new client.
  settings.on('change', () => codeIndexes.clear());

  const indexFor = (workspace: Workspace): CodeIndex | null => {
    // Embeddings use the OpenAI API, so semantic search is offered only when that key is set.
    const key = settings.getSecret('openaiApiKey');
    if (!key) return null;
    let index = codeIndexes.get(workspace.root);
    if (!index) {
      const embedder = openAIEmbedder(createOpenAIClient(key, settings.get().openaiBaseUrl));
      index = new CodeIndex(workspace, embedder, join(userData, 'indexes'), () => settings.get().maxIndexedFiles);
      codeIndexes.set(workspace.root, index);
    }
    return index;
  };
  const indexStatus = (index: CodeIndex | null, reason?: string): IndexStatus =>
    index
      ? {
          available: true,
          indexed: index.fileCount > 0,
          indexing: index.isUpdating,
          progress: index.updateProgress,
          files: index.fileCount,
          chunks: index.chunkCount,
        }
      : { available: false, reason, indexed: false, indexing: false, progress: null, files: 0, chunks: 0 };
  const currentIndex = (): { index: CodeIndex | null; reason?: string } => {
    const project = projects.current();
    if (!project) return { index: null, reason: 'Open a project first.' };
    const index = indexFor(new Workspace(project.path));
    return index ? { index } : { index: null, reason: 'Set an OpenAI API key to enable code indexing.' };
  };

  const manager = new ChatManager({
    settings,
    projects,
    chats,
    llm,
    browser: () => browser,
    codeSearch: (workspace) => {
      const index = indexFor(workspace);
      return index ? { search: index, tools: [searchCodeTool(index)] } : null;
    },
    emit: (event, chatId) => send(mainWindow, 'chat:event', { chatId, event }),
    onSnapshot: (snapshot) => send(mainWindow, 'chat:snapshot', snapshot),
    onHistoryChanged: () => send(mainWindow, 'history:changed', chats.list()),
  });

  const openProject = (path: string) => {
    const project = projects.open(path);
    manager.projectChanged();
    terminal.stop();
    send(mainWindow, 'project:changed', project);
    return project;
  };

  handle('app:info', () => ({ version: app.getVersion(), platform: process.platform }));

  handle('settings:get', () => settings.view());
  handle('settings:update', (patch) => settings.update(patch));
  handle('settings:set-secret', (name, value) => {
    if (!SECRET_NAMES.includes(name)) throw new Error(`Unknown secret: ${name}`);
    return settings.setSecret(name, value);
  });
  settings.on('change', (view) => send(mainWindow, 'settings:changed', view));

  handle('index:status', () => {
    const { index, reason } = currentIndex();
    return indexStatus(index, reason);
  });
  handle('index:rebuild', async () => {
    const { index, reason } = currentIndex();
    if (!index) throw new Error(reason);
    await index.rebuild();
    return indexStatus(index);
  });

  handle('project:choose', async () => {
    const options = { properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'> };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    return result.canceled || !result.filePaths[0] ? null : openProject(result.filePaths[0]);
  });
  handle('project:open', (path) => openProject(path));
  handle('project:current', () => projects.current());
  handle('project:list', () => projects.list());
  handle('project:set-instructions', (path, instructions) => projects.setInstructions(path, instructions));
  handle('project:remove', (path) => {
    const wasCurrent = projects.current()?.path === path;
    projects.remove(path);
    if (wasCurrent) {
      manager.projectChanged();
      send(mainWindow, 'project:changed', null);
    }
    return projects.list();
  });

  handle('chat:snapshot', () => manager.snapshot());
  handle('chat:send', (message) => {
    // Returns once the chat has started; progress arrives as chat:event messages.
    manager.send(message).catch(() => {});
  });
  handle('chat:stop', () => manager.stop());
  handle('chat:new', () => manager.newChat());
  handle('chat:decide', (approvalId, decision) => manager.decide(approvalId, decision));
  handle('chat:export', () => {
    const chat = manager.snapshot();
    if (chat.transcript.length === 0) throw new Error('This chat is empty; there is nothing to export.');
    return saveTextFile(mainWindow, exportFileName(chat.title), chatToMarkdown(chat));
  });

  handle('history:list', () => chats.list());
  handle('history:open', (id) => {
    const snapshot = manager.open(id);
    send(mainWindow, 'project:changed', projects.current());
    return snapshot;
  });
  handle('history:delete', (id) => {
    chats.delete(id);
    return chats.list();
  });
  handle('history:search', (query) => chats.search(typeof query === 'string' ? query.slice(0, 200) : ''));
  handle('history:clear', () => {
    chats.deleteAll();
    return chats.list();
  });

  handle('files:pick-images', () => pickImages(mainWindow));
  handle('files:open-in-editor', (path) => {
    const project = projects.current();
    if (!project) throw new Error('No project is open.');
    openInEditor(settings.get().editorCommand, project.path, path);
  });

  handle('terminal:start', (cols, rows) => {
    const project = projects.current();
    if (!project) throw new Error('Open a project to use the terminal.');
    terminal.start(project.path, cols, rows);
  });
  handle('terminal:write', (data) => terminal.write(data));
  handle('terminal:resize', (cols, rows) => terminal.resize(cols, rows));

  handle('git:status', () => git().status());
  handle('git:diff', (path) => git().diff(path));
  handle('git:commit', (message) => git().commit(message));
  handle('git:discard', (path) => git().discard(path));
  handle('git:init', () => git().init());

  const openWindow = () => createMainWindow((guest) => browser.attach(guest));
  buildMenu(() => mainWindow);
  mainWindow = openWindow();
  mainWindow.on('closed', () => (mainWindow = null));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = openWindow();
    }
  });
  app.on('before-quit', () => {
    manager.dispose();
    terminal.stop();
  });
}

app.whenReady().then(start);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
