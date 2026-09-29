import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';

export interface RunningApp {
  app: ElectronApplication;
  page: Page;
  userData: string;
  errors: string[];
  // Output the main process wrote to stderr (e.g. errors from IPC handlers).
  mainErrors: string[];
  close(): Promise<void>;
}

// Launches the built app (run `npm run build` first) with a throwaway profile.
export async function launchApp(env: Record<string, string> = {}): Promise<RunningApp> {
  const userData = mkdtempSync(join(tmpdir(), 'codecompanion-e2e-'));
  const root = resolve(__dirname, '../..');
  const app = await electron.launch({
    args: [root],
    cwd: root,
    env: { ...process.env, CODECOMPANION_USER_DATA: userData, ...env } as Record<string, string>,
  });
  const page = await app.firstWindow();
  const mainErrors: string[] = [];
  app.process().stderr?.on('data', (data: Buffer) => mainErrors.push(data.toString()));
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.waitForLoadState('domcontentloaded');

  return {
    app,
    page,
    userData,
    errors,
    mainErrors,
    async close() {
      await app.close();
      rmSync(userData, { recursive: true, force: true });
    },
  };
}
