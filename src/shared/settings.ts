import { DEFAULT_MODEL, type Effort } from './models';

export type Theme = 'dark' | 'light';

// 'ask': file edits and shell commands wait for approval. 'auto': the agent runs them directly.
export type ApprovalMode = 'ask' | 'auto';

export interface Settings {
  model: string;
  // How much the model thinks before acting (current Claude models and OpenAI via the Responses API).
  effort: Effort;
  approvalMode: ApprovalMode;
  // Commands that run without approval in 'ask' mode, one per line; a line also allows the command with arguments
  // ("npm test" allows "npm test -- foo"). Commands with shell operators (; & | > < ` $() are never allowed this way.
  allowedCommands: string;
  // Exact http(s) URL hostnames that network tools may contact without asking, one per line.
  allowedNetworkHosts: string;
  theme: Theme;
  // Base URL for an OpenAI-compatible API. Empty means api.openai.com.
  openaiBaseUrl: string;
  // Command used to open files from chat links, e.g. "code" or "cursor". The file path is appended.
  editorCommand: string;
  maxIndexedFiles: number;
  googleSearchEngineId: string;
}

export const DEFAULT_SETTINGS: Settings = {
  model: DEFAULT_MODEL,
  effort: 'high',
  approvalMode: 'ask',
  allowedCommands: '',
  allowedNetworkHosts: '',
  theme: 'dark',
  openaiBaseUrl: '',
  editorCommand: 'code',
  maxIndexedFiles: 2000,
  googleSearchEngineId: '',
};

export type SecretName = 'anthropicApiKey' | 'openaiApiKey' | 'googleApiKey';

export const SECRET_NAMES: SecretName[] = ['anthropicApiKey', 'openaiApiKey', 'googleApiKey'];

// What the renderer sees. Secrets never leave the main process; the UI only learns whether each one is set.
export interface SettingsView extends Settings {
  secrets: Record<SecretName, boolean>;
  secretsEncrypted: boolean;
}
