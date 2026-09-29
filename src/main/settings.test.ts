import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { SettingsStore, type SecretCipher } from './settings';

const reversingCipher: SecretCipher = {
  isAvailable: () => true,
  encrypt: (plain) => Buffer.from([...plain].reverse().join('')).toString('base64'),
  decrypt: (encoded) => [...Buffer.from(encoded, 'base64').toString()].reverse().join(''),
};

const noCipher: SecretCipher = {
  isAvailable: () => false,
  encrypt: () => {
    throw new Error('unavailable');
  },
  decrypt: () => {
    throw new Error('unavailable');
  },
};

describe('SettingsStore', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-settings-'));
    file = join(dir, 'settings.json');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('starts from defaults', () => {
    const store = new SettingsStore(file, reversingCipher);
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    expect(store.view().secrets).toEqual({ anthropicApiKey: false, openaiApiKey: false, googleApiKey: false });
    expect(store.get().allowedNetworkHosts).toBe('');
  });

  it('uses the safe network default for older settings files', () => {
    writeFileSync(file, JSON.stringify({ settings: { allowedCommands: 'npm test' }, secrets: {} }));
    expect(new SettingsStore(file, reversingCipher).get().allowedNetworkHosts).toBe('');
  });

  it('persists updates and ignores unknown keys', () => {
    new SettingsStore(file, reversingCipher).update({ theme: 'light', bogus: 1 } as never);
    const reloaded = new SettingsStore(file, reversingCipher);
    expect(reloaded.get().theme).toBe('light');
    expect(reloaded.get()).not.toHaveProperty('bogus');
  });

  it('replaces invalid values with defaults', () => {
    const store = new SettingsStore(file, reversingCipher);
    store.update({ approvalMode: 'yolo' as never, maxIndexedFiles: -5, model: '  ' });
    expect(store.get().approvalMode).toBe('ask');
    expect(store.get().maxIndexedFiles).toBe(1);
    expect(store.get().model).toBe(DEFAULT_SETTINGS.model);
  });

  it('stores secrets encrypted and never exposes them in the view', () => {
    const store = new SettingsStore(file, reversingCipher);
    const view = store.setSecret('anthropicApiKey', ' sk-ant-123 ');
    expect(view.secrets.anthropicApiKey).toBe(true);
    expect(JSON.stringify(view)).not.toContain('sk-ant-123');
    expect(readFileSync(file, 'utf8')).not.toContain('sk-ant-123');
    expect(new SettingsStore(file, reversingCipher).getSecret('anthropicApiKey')).toBe('sk-ant-123');
  });

  it('clears a secret when set to an empty string', () => {
    const store = new SettingsStore(file, reversingCipher);
    store.setSecret('openaiApiKey', 'sk-1');
    store.setSecret('openaiApiKey', '');
    expect(store.getSecret('openaiApiKey')).toBe('');
    expect(store.view().secrets.openaiApiKey).toBe(false);
  });

  it('falls back to plain storage when encryption is unavailable', () => {
    const store = new SettingsStore(file, noCipher);
    store.setSecret('googleApiKey', 'g-key');
    expect(store.view().secretsEncrypted).toBe(false);
    expect(new SettingsStore(file, noCipher).getSecret('googleApiKey')).toBe('g-key');
  });

  it('emits change events', () => {
    const store = new SettingsStore(file, reversingCipher);
    const seen: string[] = [];
    store.on('change', (view) => seen.push(view.theme));
    store.update({ theme: 'light' });
    expect(seen).toEqual(['light']);
  });
});
