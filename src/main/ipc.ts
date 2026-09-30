import { BrowserWindow, ipcMain } from 'electron';
import type { EventChannel, EventMap, InvokeApi, InvokeChannel } from '@shared/ipc';
import { appLog } from './app_log';

type Handler<K extends InvokeChannel> = (
  ...args: Parameters<InvokeApi[K]>
) => ReturnType<InvokeApi[K]> | Promise<Awaited<ReturnType<InvokeApi[K]>>>;

export function handle<K extends InvokeChannel>(channel: K, handler: Handler<K>): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return await handler(...(args as Parameters<InvokeApi[K]>));
    } catch (error) {
      // Only the channel is logged, not the arguments, which can hold messages and file contents.
      appLog.error('ipc', error, { channel });
      throw error;
    }
  });
}

export function send<K extends EventChannel>(window: BrowserWindow | null, channel: K, payload: EventMap[K]): void {
  if (window && !window.isDestroyed()) {
    window.webContents.send(channel, payload);
  }
}
