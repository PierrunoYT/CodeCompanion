// The complete contract between the main process and the renderer.
//
// InvokeApi: request/response calls from the renderer (ipcRenderer.invoke -> ipcMain.handle).
// EventMap:  one-way pushes from the main process to the renderer (webContents.send -> ipcRenderer.on).
//
// Both sides are typed from these maps, so a renamed channel or changed payload is a compile error.
import type { ApprovalDecision, ChatEvent, ChatSnapshot, ChatSummary, UserMessage } from './chat';
import type { GitStatus, PanelName } from './panels';
import type { ProjectInfo } from './project';
import type { SecretName, Settings, SettingsView } from './settings';

export interface AppInfo {
  version: string;
  platform: string;
}

export type MenuCommand = 'open-project' | 'new-chat' | 'stop' | 'settings';

export type ImageAttachment = NonNullable<UserMessage['images']>[number] & { name: string };

export interface InvokeApi {
  'app:info': () => AppInfo;

  'settings:get': () => SettingsView;
  'settings:update': (patch: Partial<Settings>) => SettingsView;
  'settings:set-secret': (name: SecretName, value: string) => SettingsView;

  'project:choose': () => ProjectInfo | null;
  'project:open': (path: string) => ProjectInfo;
  'project:current': () => ProjectInfo | null;
  'project:list': () => ProjectInfo[];
  'project:set-instructions': (path: string, instructions: string) => ProjectInfo;
  'project:remove': (path: string) => ProjectInfo[];

  'chat:snapshot': () => ChatSnapshot;
  'chat:send': (message: UserMessage) => void;
  'chat:stop': () => void;
  'chat:new': () => ChatSnapshot;
  'chat:decide': (approvalId: string, decision: ApprovalDecision) => void;

  'history:list': () => ChatSummary[];
  'history:open': (id: string) => ChatSnapshot;
  'history:delete': (id: string) => ChatSummary[];
  'history:clear': () => ChatSummary[];

  'files:pick-images': () => ImageAttachment[];
  'files:open-in-editor': (path: string) => void;

  'terminal:start': (cols: number, rows: number) => void;
  'terminal:write': (data: string) => void;
  'terminal:resize': (cols: number, rows: number) => void;

  'git:status': () => GitStatus;
  'git:diff': (path: string | null) => string;
  'git:commit': (message: string) => GitStatus;
  'git:discard': (path: string) => GitStatus;
  'git:init': () => GitStatus;
}

export interface EventMap {
  'menu:command': MenuCommand;
  'app:notice': string;
  'settings:changed': SettingsView;
  'project:changed': ProjectInfo | null;
  'chat:event': { chatId: string; event: ChatEvent };
  'chat:snapshot': ChatSnapshot;
  'history:changed': ChatSummary[];
  'terminal:data': string;
  'terminal:exit': null;
  'panel:show': PanelName;
}

export type InvokeChannel = keyof InvokeApi;
export type EventChannel = keyof EventMap;

// Channels the preload script is allowed to forward. Written as records so that adding a channel to the contract
// without listing it here is a compile error.
const INVOKE: Record<InvokeChannel, true> = {
  'app:info': true,
  'settings:get': true,
  'settings:update': true,
  'settings:set-secret': true,
  'project:choose': true,
  'project:open': true,
  'project:current': true,
  'project:list': true,
  'project:set-instructions': true,
  'project:remove': true,
  'chat:snapshot': true,
  'chat:send': true,
  'chat:stop': true,
  'chat:new': true,
  'chat:decide': true,
  'history:list': true,
  'history:open': true,
  'history:delete': true,
  'history:clear': true,
  'files:pick-images': true,
  'files:open-in-editor': true,
  'terminal:start': true,
  'terminal:write': true,
  'terminal:resize': true,
  'git:status': true,
  'git:diff': true,
  'git:commit': true,
  'git:discard': true,
  'git:init': true,
};

const EVENTS: Record<EventChannel, true> = {
  'menu:command': true,
  'app:notice': true,
  'settings:changed': true,
  'project:changed': true,
  'chat:event': true,
  'chat:snapshot': true,
  'history:changed': true,
  'terminal:data': true,
  'terminal:exit': true,
  'panel:show': true,
};

export const INVOKE_CHANNELS = Object.keys(INVOKE) as InvokeChannel[];
export const EVENT_CHANNELS = Object.keys(EVENTS) as EventChannel[];
