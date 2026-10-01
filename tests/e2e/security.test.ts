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

  it('confirms dangerous setting changes in the main process', async () => {
    const { app, page } = running;
    const confirmations = () =>
      app.evaluate(() => (globalThis as unknown as { __patchConfirmations: string[] }).__patchConfirmations.slice());
    const setResponse = (response: number) =>
      app.evaluate((_electron, value) => {
        (globalThis as unknown as { __patchConfirmResponse: number }).__patchConfirmResponse = value;
      }, response);
    const update = (patch: object) =>
      page.evaluate(
        (value) =>
          window.api.invoke('settings:update', value).then(
            (view) => ({ ok: true, approvalMode: view.approvalMode, editorCommand: view.editorCommand }),
            (error: Error) => ({ ok: false, error: error.message }),
          ),
        patch,
      );

    // Cancelling the native dialog leaves the setting unchanged.
    await setResponse(1);
    expect(await update({ editorCommand: 'calc' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('cancelled'),
    });
    expect((await page.evaluate(() => window.api.invoke('settings:get'))).editorCommand).toBe('code');
    await setResponse(0);

    const before = (await confirmations()).length;
    expect(await update({ approvalMode: 'auto' })).toMatchObject({ ok: true, approvalMode: 'auto' });
    expect(await update({ approvalMode: 'ask' })).toMatchObject({ ok: true, approvalMode: 'ask' });
    // Auto mode is confirmed once per session; ordinary settings never ask.
    expect(await update({ approvalMode: 'auto', theme: 'light' })).toMatchObject({ ok: true, approvalMode: 'auto' });
    const asked = (await confirmations()).slice(before);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('Auto mode');
    await update({ approvalMode: 'ask', theme: 'dark' });
  });

  it('runs without renderer errors', () => {
    expect(running.errors).toEqual([]);
  });
});
