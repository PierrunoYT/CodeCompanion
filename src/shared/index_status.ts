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
