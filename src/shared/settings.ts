import { DEFAULT_MODEL } from './models';

export type Theme = 'dark' | 'light';

// 'ask': file edits and shell commands wait for approval. 'auto': the agent runs them directly.
export type ApprovalMode = 'ask' | 'auto';

export interface Settings {
  model: string;
  approvalMode: ApprovalMode;
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
  approvalMode: 'ask',
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
