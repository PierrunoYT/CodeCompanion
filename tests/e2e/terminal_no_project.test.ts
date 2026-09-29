import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchApp, type RunningApp } from './app';

describe('terminal without a project', () => {
  let running: RunningApp;

  beforeAll(async () => {
    running = await launchApp();
  });

  afterAll(async () => {
    await running?.close();
  });

  it('explains that a project is needed without asking the main process to start a shell', async () => {
    await running.page.locator('.panel-tab', { hasText: 'Terminal' }).click();
    await running.page
      .locator('.terminal-panel .xterm-rows', { hasText: 'Open a project to use the terminal.' })
      .waitFor({ timeout: 10_000 });
    // Give a rejected IPC call time to be logged if the renderer had made one.
    await running.page.waitForTimeout(500);
    expect(running.mainErrors.join('')).not.toContain('terminal:start');
    expect(running.errors.join('\n')).toBe('');
  });
});
