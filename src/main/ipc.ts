import { BrowserWindow, ipcMain } from 'electron';
import type { EventChannel, EventMap, InvokeApi, InvokeChannel } from '@shared/ipc';

type Handler<K extends InvokeChannel> = (
  ...args: Parameters<InvokeApi[K]>
) => ReturnType<InvokeApi[K]> | Promise<Awaited<ReturnType<InvokeApi[K]>>>;

export function handle<K extends InvokeChannel>(channel: K, handler: Handler<K>): void {
  ipcMain.handle(channel, (_event, ...args) => handler(...(args as Parameters<InvokeApi[K]>)));
}

export function send<K extends EventChannel>(window: BrowserWindow | null, channel: K, payload: EventMap[K]): void {
  if (window && !window.isDestroyed()) {
    window.webContents.send(channel, payload);
  }
}
