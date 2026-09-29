import { app, BrowserWindow } from 'electron';
import { handle } from './ipc';
import { buildMenu } from './menu';
import { createMainWindow } from './window';

app.setName('CodeCompanion');

// Lets tests (and anyone who wants a throwaway profile) run with separate settings and history.
if (process.env.CODECOMPANION_USER_DATA) {
  app.setPath('userData', process.env.CODECOMPANION_USER_DATA);
}

let mainWindow: BrowserWindow | null = null;

function registerHandlers(): void {
  handle('app:info', () => ({ version: app.getVersion(), platform: process.platform }));
}

app.whenReady().then(() => {
  registerHandlers();
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
