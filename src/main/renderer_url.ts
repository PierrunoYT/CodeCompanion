// The dev server URL to load the app page from, or null to load the built page from disk. electron-vite sets
// ELECTRON_RENDERER_URL during `npm run dev`. A packaged app ignores it: anyone who could set it when starting Patch
// would otherwise get a remote page loaded with the app's preload and its full IPC access.
export function devRendererUrl(isPackaged: boolean, env: NodeJS.ProcessEnv): string | null {
  if (isPackaged) return null;
  return env.ELECTRON_RENDERER_URL || null;
}

// Whether a frame URL is the app page: the built renderer/index.html from disk, or the dev server in development.
// IPC handlers only answer calls from it, so a future iframe, second window or wrongly loaded page cannot use them.
export function isAppPageUrl(url: string, isPackaged: boolean, env: NodeJS.ProcessEnv): boolean {
  const dev = devRendererUrl(isPackaged, env);
  if (dev && url.startsWith(dev)) return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'file:' && parsed.pathname.endsWith('/renderer/index.html');
  } catch {
    return false;
  }
}
