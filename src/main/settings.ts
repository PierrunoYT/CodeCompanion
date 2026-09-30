import { EventEmitter } from 'node:events';
import {
  DEFAULT_SETTINGS,
  sanitizeMcpServers,
  SECRET_NAMES,
  parseMcpServers,
  type McpServerConfig,
  type McpServerView,
  type SecretName,
  type Settings,
  type SettingsView,
} from '@shared/settings';
import { readJson, writeJson } from './storage/json_file';

// Encrypts secrets at rest. In the app this is Electron's safeStorage (OS keychain / DPAPI); tests inject
// their own.
export interface SecretCipher {
  isAvailable(): boolean;
  encrypt(plain: string): string;
  decrypt(encoded: string): string;
}

interface StoredSettings {
  settings: Partial<Settings>;
  // Base64 ciphertext when encryption is available, otherwise plain text marked with a "plain:" prefix.
  secrets: Partial<Record<SecretName, string>>;
  // env and headers of MCP servers, encrypted the same way. Keyed by server name.
  mcpSecrets?: Record<string, { env?: Record<string, string>; headers?: Record<string, string> }>;
}

export class SettingsStore extends EventEmitter {
  private settings: Settings;
  private secrets: Partial<Record<SecretName, string>>;
  private mcpSecrets: Record<string, { env?: Record<string, string>; headers?: Record<string, string> }>;

  constructor(
    private readonly path: string,
    private readonly cipher: SecretCipher,
  ) {
    super();
    const stored = readJson<StoredSettings>(path, { settings: {}, secrets: {} });
    this.settings = sanitize({ ...DEFAULT_SETTINGS, ...stored.settings });
    this.secrets = stored.secrets ?? {};
    this.mcpSecrets = stored.mcpSecrets ?? {};
    this.migratePlainSecrets();
  }

  get(): Settings {
    return { ...this.settings };
  }

  view(): SettingsView {
    this.migratePlainSecrets();
    const secrets = Object.fromEntries(SECRET_NAMES.map((name) => [name, Boolean(this.secrets[name])])) as Record<
      SecretName,
      boolean
    >;
    const stored = Object.values(this.secrets).filter(Boolean);
    const secretsEncrypted =
      stored.length > 0 ? stored.every((value) => !value.startsWith('plain:')) : this.cipher.isAvailable();
    const { mcpServers, ...rest } = this.settings;
    return { ...rest, mcpServers: mcpServers.map((server) => this.mcpView(server)), secrets, secretsEncrypted };
  }

  // The full server config, including decrypted env and headers, for the process that connects to the servers.
  mcpServers(): McpServerConfig[] {
    return this.settings.mcpServers.map((server) => ({
      ...server,
      env: this.decryptMap(this.mcpSecrets[server.name]?.env),
      headers: this.decryptMap(this.mcpSecrets[server.name]?.headers),
    }));
  }

  update(patch: Partial<Settings>): SettingsView {
    const known = pickKnown(patch);
    // User-entered server config is validated up front so the dialog can show the problem; a silent drop would
    // hide typos.
    if ('mcpServers' in known) this.validateMcpServers(known.mcpServers);
    const next = sanitize({ ...this.settings, ...known });
    if ('mcpServers' in known) this.storeMcpSecrets(next.mcpServers);
    next.mcpServers = next.mcpServers.map(({ env: _env, headers: _headers, ...server }) => server);
    this.persist(next, this.secrets);
    return this.view();
  }

  getSecret(name: SecretName): string {
    this.migratePlainSecrets();
    const stored = this.secrets[name];
    if (!stored) return '';
    if (stored.startsWith('plain:')) return stored.slice('plain:'.length);
    try {
      return this.cipher.decrypt(stored);
    } catch {
      return '';
    }
  }

  setSecret(name: SecretName, value: string): SettingsView {
    const trimmed = value.trim();
    const secrets = { ...this.secrets };
    if (!trimmed) {
      delete secrets[name];
    } else if (this.cipher.isAvailable()) {
      secrets[name] = this.cipher.encrypt(trimmed);
    } else {
      secrets[name] = `plain:${trimmed}`;
    }
    this.persist(this.settings, secrets);
    return this.view();
  }

  private migratePlainSecrets(): void {
    if (!this.cipher.isAvailable() || !Object.values(this.secrets).some((value) => value?.startsWith('plain:'))) return;
    // Stage the complete migration before writing or changing memory. A failed cipher or write must leave keys usable.
    try {
      const secrets = { ...this.secrets };
      for (const name of SECRET_NAMES) {
        const value = secrets[name];
        if (value?.startsWith('plain:')) secrets[name] = this.cipher.encrypt(value.slice('plain:'.length));
      }
      writeJson(this.path, { settings: this.settings, secrets } satisfies StoredSettings);
      this.secrets = secrets;
    } catch {
      // Retain the original storage representation; a later access can retry when encryption/storage recovers.
    }
  }

  private persist(settings: Settings, secrets: Partial<Record<SecretName, string>>): void {
    writeJson(this.path, { settings, secrets, mcpSecrets: this.mcpSecrets } satisfies StoredSettings);
    this.settings = settings;
    this.secrets = secrets;
    this.emit('change', this.view());
  }

  private storeMcpSecrets(servers: McpServerConfig[]): void {
    const next: typeof this.mcpSecrets = {};
    for (const server of servers) {
      const previous = this.mcpSecrets[server.name];
      next[server.name] = {
        // A missing map means the caller did not edit it, so the stored secrets stay. An empty value for a key that
        // is present keeps that one secret, so the dialog can show the key without the user retyping it.
        env: server.env ? this.encryptMap(server.env, previous?.env) : previous?.env,
        headers: server.headers ? this.encryptMap(server.headers, previous?.headers) : previous?.headers,
      };
    }
    this.mcpSecrets = next;
  }

  // An empty value keeps the stored secret, so saving the dialog without retyping a key does not clear it.
  private encryptMap(
    incoming: Record<string, string> | undefined,
    previous: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    if (!incoming) return undefined;
    const stored: Record<string, string> = {};
    for (const [key, value] of Object.entries(incoming)) {
      if (!value) {
        if (previous?.[key]) stored[key] = previous[key];
        continue;
      }
      stored[key] = this.cipher.isAvailable() ? this.cipher.encrypt(value) : `plain:${value}`;
    }
    return Object.keys(stored).length > 0 ? stored : undefined;
  }

  private decryptMap(stored: Record<string, string> | undefined): Record<string, string> | undefined {
    if (!stored) return undefined;
    const plain: Record<string, string> = {};
    for (const [key, value] of Object.entries(stored)) {
      if (value.startsWith('plain:')) plain[key] = value.slice('plain:'.length);
      else {
        try {
          plain[key] = this.cipher.decrypt(value);
        } catch {
          // A secret that cannot be decrypted is omitted rather than sent to the server as ciphertext.
        }
      }
    }
    return Object.keys(plain).length > 0 ? plain : undefined;
  }

  private mcpView(server: McpServerConfig): McpServerView {
    const stored = this.mcpSecrets[server.name];
    return {
      name: server.name,
      transport: server.transport,
      command: server.command,
      args: server.args,
      url: server.url,
      envKeys: Object.keys(stored?.env ?? {}),
      headerKeys: Object.keys(stored?.headers ?? {}),
    };
  }

  private validateMcpServers(value: unknown): McpServerConfig[] {
    try {
      return parseMcpServers(JSON.stringify(value));
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  }
}

function pickKnown(patch: Partial<Settings>): Partial<Settings> {
  const known = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[];
  return Object.fromEntries(Object.entries(patch).filter(([key]) => known.includes(key as keyof Settings)));
}

// Falls back to defaults for values of the wrong type, e.g. from a hand-edited settings file.
function sanitize(settings: Settings): Settings {
  const result = { ...settings };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    if (typeof result[key] !== typeof DEFAULT_SETTINGS[key]) {
      (result as Record<string, unknown>)[key] = DEFAULT_SETTINGS[key];
    }
  }
  if (!['ask', 'auto'].includes(result.approvalMode)) result.approvalMode = DEFAULT_SETTINGS.approvalMode;
  if (!['dark', 'light'].includes(result.theme)) result.theme = DEFAULT_SETTINGS.theme;
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(result.effort)) result.effort = DEFAULT_SETTINGS.effort;
  result.maxIndexedFiles = Math.max(1, Math.floor(result.maxIndexedFiles));
  result.model = result.model.trim() || DEFAULT_SETTINGS.model;
  result.mcpServers = sanitizeMcpServers(result.mcpServers);
  return result;
}
