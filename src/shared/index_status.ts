import type { IndexStatus } from './ipc';

// One line for Settings describing the code index, including progress while it is being built.
export function describeIndexStatus(status: IndexStatus): string {
  if (!status.available) return `Not available: ${status.reason ?? 'no project'}`;
  if (status.indexing) {
    const { progress } = status;
    if (!progress || progress.total === 0) return 'Indexing… scanning files';
    const percent = Math.floor((progress.embedded / progress.total) * 100);
    return `Indexing… ${progress.embedded} of ${progress.total} chunks (${percent}%)`;
  }
  return status.indexed ? `Indexed: ${status.files} files, ${status.chunks} chunks` : 'Not indexed yet';
}

// The short form for the status bar ("Index: 100% (Ready)") and the chat list ("Indexed").
export function indexStatusLabel(status: IndexStatus): { bar: string; short: string; ready: boolean } {
  if (!status.available) return { bar: 'Index: off', short: 'Search off', ready: false };
  if (status.indexing) {
    const { progress } = status;
    const percent = progress && progress.total > 0 ? Math.floor((progress.embedded / progress.total) * 100) : 0;
    return { bar: `Index: ${percent}% (Indexing)`, short: 'Indexing', ready: false };
  }
  return status.indexed
    ? { bar: 'Index: 100% (Ready)', short: 'Indexed', ready: true }
    : { bar: 'Index: 0% (Not built)', short: 'Not indexed', ready: false };
}
