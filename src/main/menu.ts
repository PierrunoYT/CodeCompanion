import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron';
import type { MenuCommand } from '@shared/ipc';
import { send } from './ipc';

export function buildMenu(getWindow: () => BrowserWindow | null): void {
  const command = (name: MenuCommand) => () => send(getWindow(), 'menu:command', name);
  const isMac = process.platform === 'darwin';

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: command('open-project') },
        { label: 'New Chat', accelerator: 'CmdOrCtrl+N', click: command('new-chat') },
        { label: 'Save Chat…', accelerator: 'CmdOrCtrl+S', click: command('save-chat') },
        { type: 'separator' },
        { label: 'Stop', accelerator: 'CmdOrCtrl+.', click: command('stop') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit', click: () => app.quit() },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
