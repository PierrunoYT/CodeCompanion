import type { WebContents } from 'electron';
import type { BrowserController, PageLoadResult } from '../tools/browser';

const LOAD_TIMEOUT_MS = 20_000;
// Screenshots are scaled down so they stay within the image size models accept.
const MAX_SCREENSHOT_WIDTH = 1280;
const MAX_CONSOLE_MESSAGES = 200;

// Controls the page shown in the browser panel. The renderer owns the <webview> element; its guest webContents is
// handed to this class when it attaches, so the agent can load pages, read console output and take screenshots.
export class BrowserService implements BrowserController {
  private guest: WebContents | null = null;
  private waiters: Array<() => void> = [];

  constructor(private readonly show: () => void) {}

  attach(guest: WebContents): void {
    this.guest = guest;
    guest.once('destroyed', () => {
      if (this.guest === guest) this.guest = null;
    });
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  get available(): boolean {
    return this.guest !== null && !this.guest.isDestroyed();
  }

  async open(url: string, signal: AbortSignal): Promise<PageLoadResult> {
    this.show();
    const guest = await this.waitForGuest();
    const console: string[] = [];
    let status: number | null = null;
    let error: string | undefined;

    const onConsole = (event: Electron.Event<Electron.WebContentsConsoleMessageEventParams>) => {
      if (console.length < MAX_CONSOLE_MESSAGES) console.push(`[${event.level}] ${event.message}`);
    };
    const onNavigate = (_event: Electron.Event, _url: string, code: number) => {
      status = code > 0 ? code : null;
    };
    const onFail = (_event: Electron.Event, code: number, description: string, _url: string, isMainFrame: boolean) => {
      // -3 is an aborted load, e.g. a redirect replacing it.
      if (isMainFrame && code !== -3) error = `${description} (${code})`;
    };
    guest.on('console-message', onConsole);
    guest.on('did-navigate', onNavigate);
    guest.on('did-fail-load', onFail);

    try {
      await Promise.race([
        guest.loadURL(url).catch((loadError: Error) => {
          error ??= loadError.message;
        }),
        new Promise((resolve) => setTimeout(resolve, LOAD_TIMEOUT_MS)),
        new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('Stopped.')), { once: true })),
      ]);
      // Let scripts that run right after load log their errors.
      await new Promise((resolve) => setTimeout(resolve, 500));
      return { url: guest.getURL(), title: guest.getTitle(), status, console: [...console], error };
    } finally {
      guest.off('console-message', onConsole);
      guest.off('did-navigate', onNavigate);
      guest.off('did-fail-load', onFail);
    }
  }

  async screenshot(): Promise<string> {
    const guest = await this.waitForGuest();
    let image = await guest.capturePage();
    const { width } = image.getSize();
    if (width > MAX_SCREENSHOT_WIDTH) image = image.resize({ width: MAX_SCREENSHOT_WIDTH });
    return image.toPNG().toString('base64');
  }

  // The panel may not have been shown yet; opening it creates the webview.
  private waitForGuest(): Promise<WebContents> {
    if (this.available) return Promise.resolve(this.guest!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The browser panel did not open.')), 5000);
      this.waiters.push(() => {
        clearTimeout(timer);
        resolve(this.guest!);
      });
    });
  }
}
