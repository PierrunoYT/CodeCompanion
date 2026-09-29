import { app, BrowserWindow, dialog, safeStorage } from 'electron';
import { join } from 'node:path';
import { SECRET_NAMES } from '@shared/settings';
import { ChatManager } from './chat_manager';
import { ChatStore } from './chat_store';
import { openInEditor, pickImages } from './files';
import { handle, send } from './ipc';
import { LlmService } from './llm';
import { createOpenAIClient } from './llm/openai';
import { CodeIndex, openAIEmbedder, searchCodeTool } from './search/code_index';
import { buildMenu } from './menu';
import { ProjectStore } from './projects';
import { SettingsStore } from './settings';
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
  const codeIndexes = new Map<string, CodeIndex>();
  // A changed key or endpoint means new embeddings; drop cached indexes so they are rebuilt with the new client.
  settings.on('change', () => codeIndexes.clear());

  const manager = new ChatManager({
    settings,
    projects,
    chats,
    llm,
    browser: () => null,
    codeSearch: (workspace) => {
      // Embeddings use the OpenAI API, so semantic search is offered only when that key is set.
      const key = settings.getSecret('openaiApiKey');
      if (!key) return null;
      let index = codeIndexes.get(workspace.root);
      if (!index) {
        const embedder = openAIEmbedder(createOpenAIClient(key, settings.get().openaiBaseUrl));
        index = new CodeIndex(workspace, embedder, join(userData, 'indexes'), () => settings.get().maxIndexedFiles);
        codeIndexes.set(workspace.root, index);
      }
      return { search: index, tools: [searchCodeTool(index)] };
    },
    emit: (event, chatId) => send(mainWindow, 'chat:event', { chatId, event }),
    onSnapshot: (snapshot) => send(mainWindow, 'chat:snapshot', snapshot),
    onHistoryChanged: () => send(mainWindow, 'history:changed', chats.list()),
  });

  const openProject = (path: string) => {
    const project = projects.open(path);
    manager.projectChanged();
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

  buildMenu(() => mainWindow);
  mainWindow = createMainWindow();
  mainWindow.on('closed', () => (mainWindow = null));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
    }
  });
  app.on('before-quit', () => manager.dispose());
}

app.whenReady().then(start);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
