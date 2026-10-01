// The dev server URL to load the app page from, or null to load the built page from disk. electron-vite sets
// ELECTRON_RENDERER_URL during `npm run dev`. A packaged app ignores it: anyone who could set it when starting Patch
// would otherwise get a remote page loaded with the app's preload and its full IPC access.
export function devRendererUrl(isPackaged: boolean, env: NodeJS.ProcessEnv): string | null {
  if (isPackaged) return null;
  return env.ELECTRON_RENDERER_URL || null;
}
