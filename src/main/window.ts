import { app, BrowserWindow, screen, session, shell, type WebContents } from 'electron';
import { join } from 'node:path';
import { appLog } from './app_log';

// Set by the end-to-end tests: the window is fully transparent, has no taskbar entry and never takes focus. It is still
// shown, so the page renders and animation frames run as they do for a user.
const quietTestRun = process.env.CODECOMPANION_E2E_QUIET === '1';

export function createMainWindow(onBrowserAttached: (guest: WebContents) => void): BrowserWindow {
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;

  const window = new BrowserWindow({
    show: false,
    width: Math.min(1400, Math.floor(screenWidth * 0.8)),
    height: Math.min(1000, Math.floor(screenHeight * 0.85)),
    minWidth: 800,
    minHeight: 500,
    title: 'CodeCompanion',
    icon: join(app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'build'), 'icon.png'),
    ...(quietTestRun ? { opacity: 0, skipTaskbar: true } : {}),
    webPreferences: {
      // A test window may sit behind others; it must not be slowed down for it.
      backgroundThrottling: !quietTestRun,
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Needed for the built-in browser panel. Guests are locked down in hardenWebContents.
      webviewTag: true,
    },
  });

  hardenWebContents(window, onBrowserAttached);
  logWindowProblems(window);
  // Electron grants every permission request (camera, microphone, location, notifications) unless told otherwise.
  // Neither the app page nor pages in the browser panel need any.
  for (const target of [session.defaultSession, session.fromPartition('persist:browser')]) {
    target.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    target.setPermissionCheckHandler(() => false);
  }
  window.once('ready-to-show', () => (quietTestRun ? window.showInactive() : window.show()));

  if (process.env.ELECTRON_RENDERER_URL) {
    window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return window;
}

// A window that hangs, or an app page that fails to load, is otherwise invisible to anyone but the person looking at it.
function logWindowProblems(window: BrowserWindow): void {
  window.on('unresponsive', () => appLog.warn('window', 'The window stopped responding.'));
  window.on('responsive', () => appLog.info('window', 'The window is responding again.'));
  window.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    // -3 is a navigation that was cancelled on purpose.
    if (isMainFrame && code !== -3) appLog.error('window', `The app page failed to load: ${description}`, { code });
  });
  window.webContents.on('preload-error', (_event, path, error) => appLog.error('preload', error, { path }));
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

  window.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    // The panel starts on about:blank and the app navigates it itself; never attach a guest to anything else.
    if (params.src && params.src !== 'about:blank' && !/^https?:\/\//i.test(params.src)) {
      event.preventDefault();
      return;
    }
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    params.allowpopups = 'false';
  });

  window.webContents.on('did-attach-webview', (_event, guest) => {
    // Programmatic loadURL bypasses will-navigate. Deny popups rather than letting a page escape the
    // browser tool's approved-host policy through window.open or a target=_blank link.
    guest.setWindowOpenHandler(() => ({ action: 'deny' }));
    onBrowserAttached(guest);
  });
}
