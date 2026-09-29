import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchApp, type RunningApp } from './app';

describe('window security', () => {
  let running: RunningApp;

  beforeAll(async () => {
    running = await launchApp();
  });

  afterAll(async () => {
    await running?.close();
  });

  it('exposes only the preload api to the page', async () => {
    const globals = await running.page.evaluate(() => ({
      require: typeof (window as any).require,
      process: typeof (window as any).process,
      api: typeof window.api,
    }));
    expect(globals).toEqual({ require: 'undefined', process: 'undefined', api: 'object' });
  });

  it('answers typed invoke calls', async () => {
    const info = await running.page.evaluate(() => window.api.invoke('app:info'));
    expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('rejects channels outside the contract', async () => {
    const result = await running.page.evaluate(() =>
      (window.api.invoke as any)('not:a-channel').then(
        () => 'resolved',
        (error: Error) => error.message,
      ),
    );
    expect(result).toContain('Blocked IPC channel');
  });

  it('does not navigate the app window away', async () => {
    const before = running.page.url();
    await running.page.evaluate(() => {
      location.href = 'file:///definitely-not-the-app.html';
    });
    await running.page.waitForTimeout(500);
    expect(running.page.url()).toBe(before);
  });

  it('runs without renderer errors', () => {
    expect(running.errors).toEqual([]);
  });
});
