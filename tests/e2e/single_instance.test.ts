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
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    second.stderr!.on('data', (data: Buffer) => (stderr += data.toString()));
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
      const timer = setTimeout(() => {
        second.kill();
        reject(new Error('the second instance did not quit within 20 s'));
      }, 20_000);
      second.on('exit', (code, signal) => {
        clearTimeout(timer);
        resolveExit({ code, signal });
      });
    });

    expect(exit, stderr.slice(-2000)).toEqual({ code: 0, signal: null });
    // The first instance still answers.
    const info = await running.page.evaluate(() => window.api.invoke('app:info'));
    expect(info.version).toBeTruthy();
  });
});
