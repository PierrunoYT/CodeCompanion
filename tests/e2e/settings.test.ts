import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchApp, type RunningApp } from './app';

describe('settings over IPC', () => {
  let running: RunningApp;

  beforeAll(async () => {
    running = await launchApp();
  });

  afterAll(async () => {
    await running?.close();
  });

  it('returns defaults with no secrets set', async () => {
    const view = await running.page.evaluate(() => window.api.invoke('settings:get'));
    expect(view.approvalMode).toBe('ask');
    expect(view.allowedNetworkHosts).toBe('');
    expect(Object.values(view.secrets).every((set) => set === false)).toBe(true);
  });

  it('updates settings and pushes a change event', async () => {
    const theme = await running.page.evaluate(
      () =>
        new Promise<string>((resolve) => {
          const off = window.api.on('settings:changed', (view) => {
            off();
            resolve(view.theme);
          });
          window.api.invoke('settings:update', { theme: 'light' });
        }),
    );
    expect(theme).toBe('light');
  });

  it('keeps secrets out of the renderer and off disk in plain text', async () => {
    const view = await running.page.evaluate(() =>
      window.api.invoke('settings:set-secret', 'anthropicApiKey', 'sk-ant-e2e-secret'),
    );
    expect(view.secrets.anthropicApiKey).toBe(true);
    expect(JSON.stringify(view)).not.toContain('sk-ant-e2e-secret');

    const onDisk = readFileSync(join(running.userData, 'settings.json'), 'utf8');
    if (view.secretsEncrypted) {
      expect(onDisk).not.toContain('sk-ant-e2e-secret');
    }
  });

  it('rejects unknown secret names', async () => {
    const message = await running.page.evaluate(() =>
      (window.api.invoke as any)('settings:set-secret', 'nope', 'x').catch((error: Error) => error.message),
    );
    expect(message).toContain('Unknown secret');
  });
});
