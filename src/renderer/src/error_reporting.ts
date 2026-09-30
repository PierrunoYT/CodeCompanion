import type { RendererErrorReport } from '@shared/ipc';

// Sends errors that reach the top of the page (uncaught errors and unhandled promise rejections) to `report`, so the
// main process can keep them in its local log. Identical errors are sent once and at most `limit` per page load.
export function installErrorReporting(
  target: EventTarget,
  report: (error: RendererErrorReport) => void,
  limit = 20,
): void {
  const seen = new Set<string>();

  const send = (error: RendererErrorReport) => {
    const key = `${error.source}\n${error.message}\n${error.stack ?? ''}`;
    if (seen.has(key) || seen.size >= limit) return;
    seen.add(key);
    report(error);
  };

  target.addEventListener('error', (event) => {
    const { message, error } = event as ErrorEvent;
    send({
      source: 'error',
      message: message || (error instanceof Error ? error.message : String(error)),
      stack: error instanceof Error ? error.stack : undefined,
    });
  });

  target.addEventListener('unhandledrejection', (event) => {
    const { reason } = event as PromiseRejectionEvent;
    send({
      source: 'unhandledrejection',
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });
}
