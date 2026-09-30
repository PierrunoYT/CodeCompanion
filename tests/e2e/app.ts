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

// Launches the built app (run `npm run build` first) with a throwaway profile. Pass `userData` to start again on the
// profile of an earlier launch, as after a restart; that folder is then left for the caller to remove.
export async function launchApp(env: Record<string, string> = {}, options: { userData?: string } = {}): Promise<RunningApp> {
  const userData = options.userData ?? mkdtempSync(join(tmpdir(), 'codecompanion-e2e-'));
  const root = resolve(__dirname, '../..');
  const app = await electron.launch({
    args: [root],
    cwd: root,
    env: {
      ...process.env,
      CODECOMPANION_USER_DATA: userData,
      // Invisible windows that never take focus, so a test run does not flash windows over your work.
      // Set E2E_SHOW_WINDOW=1 to watch the tests.
      ...(process.env.E2E_SHOW_WINDOW ? {} : { CODECOMPANION_E2E_QUIET: '1' }),
      ...env,
    } as Record<string, string>,
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
      if (!options.userData) rmSync(userData, { recursive: true, force: true });
    },
  };
}
