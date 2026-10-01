import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchApp, type RunningApp } from './app';

// Two instances on one profile would overwrite each other's settings, projects and chat index (issue #31).
describe('single instance per profile', () => {
  let running: RunningApp;

  beforeAll(async () => {
    running = await launchApp();
  });

  afterAll(async () => {
    await running?.close();
  });

  it('quits a second start on the same profile and keeps the first one running', async () => {
    // The development Electron binary, as launchApp uses: `require('electron')` resolves to its path in Node.
    const electronPath = (await import('electron')).default as unknown as string;
    const root = resolve(__dirname, '../..');
    const second = spawn(electronPath, [root], {
      cwd: root,
      env: { ...process.env, PATCH_USER_DATA: running.userData, PATCH_E2E_QUIET: '1' },
      stdio: 'ignore',
      windowsHide: true,
    });
    const exitCode = await new Promise<number | null>((resolveExit, reject) => {
      const timer = setTimeout(() => {
        second.kill();
        reject(new Error('the second instance did not quit within 20 s'));
      }, 20_000);
      second.on('exit', (code) => {
        clearTimeout(timer);
        resolveExit(code);
      });
    });

    expect(exitCode).toBe(0);
    // The first instance still answers.
    const info = await running.page.evaluate(() => window.api.invoke('app:info'));
    expect(info.version).toBeTruthy();
  });
});
