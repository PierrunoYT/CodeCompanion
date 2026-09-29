// The complete contract between the main process and the renderer.
//
// InvokeApi: request/response calls from the renderer (ipcRenderer.invoke -> ipcMain.handle).
// EventMap:  one-way pushes from the main process to the renderer (webContents.send -> ipcRenderer.on).
//
// Both sides are typed from these maps, so a renamed channel or changed payload is a compile error.
import type { SecretName, Settings, SettingsView } from './settings';

export interface AppInfo {
  version: string;
  platform: string;
}

export type MenuCommand = 'open-project' | 'new-chat' | 'save-chat' | 'stop';

export interface InvokeApi {
  'app:info': () => AppInfo;
  'settings:get': () => SettingsView;
  'settings:update': (patch: Partial<Settings>) => SettingsView;
  'settings:set-secret': (name: SecretName, value: string) => SettingsView;
}

export interface EventMap {
  'menu:command': MenuCommand;
  'app:notice': string;
  'settings:changed': SettingsView;
}

export type InvokeChannel = keyof InvokeApi;
export type EventChannel = keyof EventMap;

// Channels the preload script is allowed to forward. Keeping explicit lists means the renderer can never
// reach an ipcMain handler that is not part of the contract.
export const INVOKE_CHANNELS: InvokeChannel[] = ['app:info', 'settings:get', 'settings:update', 'settings:set-secret'];
export const EVENT_CHANNELS: EventChannel[] = ['menu:command', 'app:notice', 'settings:changed'];
