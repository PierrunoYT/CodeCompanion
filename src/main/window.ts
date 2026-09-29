import { BrowserWindow, screen, shell, type WebContents } from 'electron';
import { join } from 'node:path';

export function createMainWindow(onBrowserAttached: (guest: WebContents) => void): BrowserWindow {
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;

  const window = new BrowserWindow({
    show: false,
    width: Math.min(1400, Math.floor(screenWidth * 0.8)),
    height: Math.min(1000, Math.floor(screenHeight * 0.85)),
    minWidth: 800,
    minHeight: 500,
    title: 'CodeCompanion',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Needed for the built-in browser panel. Guests are locked down in hardenWebContents.
      webviewTag: true,
    },
  });

  hardenWebContents(window, onBrowserAttached);
  window.once('ready-to-show', () => window.show());

  if (process.env.ELECTRON_RENDERER_URL) {
    window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return window;
}

// The app page is the only content the main window may show. Links open in the system browser, and pages
// loaded in the built-in browser (<webview>) never get a preload script or Node access.
function hardenWebContents(window: BrowserWindow, onBrowserAttached: (guest: WebContents) => void): void {
  const openExternally = ({ url }: { url: string }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' as const };
  };

  window.webContents.setWindowOpenHandler(openExternally);

  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) {
      event.preventDefault();
      openExternally({ url });
    }
  });

  window.webContents.on('will-attach-webview', (_event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    params.allowpopups = 'false';
  });

  window.webContents.on('did-attach-webview', (_event, guest) => {
    // Popups from pages in the browser panel open in the panel itself.
    guest.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) guest.loadURL(url);
      return { action: 'deny' };
    });
    onBrowserAttached(guest);
  });
}
