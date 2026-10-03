// Checks that a packaged build works: `node scripts/smoke-packaged.mjs <app executable> [args...]`.
// It starts the app on a throwaway profile with Chromium's remote debugging (the packaged app's fuses turn off the
// Node inspector Playwright's Electron support needs), opens a project, lists its files and runs a command in the
// terminal panel, which loads node-pty. Exits non-zero, with what it saw, when anything fails.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const [executable, ...extraArgs] = process.argv.slice(2);
if (!executable) {
  console.error('Usage: node scripts/smoke-packaged.mjs <app executable> [args...]');
  process.exit(2);
}
const expectedVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const port = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), 'patch-smoke-profile-'));
const project = mkdtempSync(join(tmpdir(), 'patch-smoke-project-'));
writeFileSync(join(project, 'hello.txt'), 'hello\n');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const child = spawn(executable, [...extraArgs, `--remote-debugging-port=${port}`], {
  env: { ...process.env, PATCH_USER_DATA: profile },
  stdio: ['ignore', 'pipe', 'pipe'],
  // Its own process group, so the whole app can be stopped at the end.
  detached: true,
});
let output = '';
child.stdout.on('data', (data) => (output += data));
child.stderr.on('data', (data) => (output += data));
let exited = null;
child.on('exit', (code, signal) => (exited = { code, signal }));

const seen = {};
let failure = null;
const deadline = setTimeout(() => {
  failure ??= 'Timed out after 120 s.';
  finish();
}, 120_000);

try {
  let browser;
  for (let attempt = 0; attempt < 120 && !browser; attempt++) {
    if (exited) throw new Error(`The app exited at start: ${JSON.stringify(exited)}`);
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 5_000 });
    } catch {
      await delay(500);
    }
  }
  if (!browser) throw new Error('Could not connect to the app.');
  let page;
  for (let attempt = 0; attempt < 80 && !page; attempt++) {
    page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url().endsWith('/renderer/index.html'));
    if (!page) await delay(250);
  }
  if (!page) throw new Error('The app window did not load its page.');
  page.setDefaultTimeout(20_000);
  await page.waitForLoadState('domcontentloaded');
  seen.title = await page.title();
  seen.info = await page.evaluate(() => window.api.invoke('app:info'));
  if (seen.info.version !== expectedVersion)
    throw new Error(`Version ${seen.info.version}, expected ${expectedVersion}.`);

  await page.evaluate((path) => window.api.invoke('project:open', path), project);
  seen.files = await page.evaluate(() => window.api.invoke('files:list'));
  if (!seen.files.includes('hello.txt')) throw new Error('The project files were not listed.');

  await page.evaluate(() => {
    window.__smokeTerminal = '';
    window.api.on('terminal:data', (data) => (window.__smokeTerminal += data));
  });
  await page.evaluate(() => window.api.invoke('terminal:start', 80, 24));
  await page.evaluate(() => window.api.invoke('terminal:write', 'echo SMOKE-$((6*7))\r'));
  await page.waitForFunction(() => window.__smokeTerminal.includes('SMOKE-42'));
  seen.terminal = 'ran a command';
  await page.screenshot({ path: process.env.SMOKE_SCREENSHOT || join(tmpdir(), 'patch-smoke.png') });
  await browser.close();
} catch (error) {
  failure ??= error instanceof Error ? error.message : String(error);
}
await finish();

async function finish() {
  clearTimeout(deadline);
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill();
  }
  console.log(JSON.stringify(seen, null, 2));
  if (failure) {
    console.error(`Smoke test failed: ${failure}`);
    console.error(`App output:\n${output.slice(-4000) || '(none)'}`);
  } else {
    console.log('Smoke test passed.');
  }
  // The app writes to its profile while it quits.
  for (let waited = 0; !exited && waited < 10_000; waited += 250) await delay(250);
  for (const folder of [project, profile]) {
    try {
      rmSync(folder, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // A leftover temp folder is not a failure of the app.
    }
  }
  process.exit(failure ? 1 : 0);
}
