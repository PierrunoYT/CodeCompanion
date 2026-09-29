import { app, BrowserWindow, safeStorage } from 'electron';
import { join } from 'node:path';
import { SECRET_NAMES } from '@shared/settings';
import { handle, send } from './ipc';
import { buildMenu } from './menu';
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

function registerHandlers(settings: SettingsStore): void {
  handle('app:info', () => ({ version: app.getVersion(), platform: process.platform }));
  handle('settings:get', () => settings.view());
  handle('settings:update', (patch) => settings.update(patch));
  handle('settings:set-secret', (name, value) => {
    if (!SECRET_NAMES.includes(name)) throw new Error(`Unknown secret: ${name}`);
    return settings.setSecret(name, value);
  });

  settings.on('change', (view) => send(mainWindow, 'settings:changed', view));
}

app.whenReady().then(() => {
  const settings = createSettings();
  registerHandlers(settings);
  buildMenu(() => mainWindow);
  mainWindow = createMainWindow();
  mainWindow.on('closed', () => (mainWindow = null));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
