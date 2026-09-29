import { contextBridge, ipcRenderer } from 'electron';
import { EVENT_CHANNELS, INVOKE_CHANNELS, type EventChannel, type InvokeChannel } from '@shared/ipc';
import type { PreloadApi } from './api';

const api: PreloadApi = {
  invoke(channel, ...args) {
    if (!INVOKE_CHANNELS.includes(channel as InvokeChannel)) {
      return Promise.reject(new Error(`Blocked IPC channel: ${channel}`));
    }
    return ipcRenderer.invoke(channel, ...args);
  },
  on(channel, listener) {
    if (!EVENT_CHANNELS.includes(channel as EventChannel)) {
      throw new Error(`Blocked IPC channel: ${channel}`);
    }
    const handler = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof listener>[0]) => listener(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
};

contextBridge.exposeInMainWorld('api', api);
