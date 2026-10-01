import { describe, expect, it } from 'vitest';
import { describeIndexStatus, indexStatusLabel } from './index_status';
import type { IndexStatus } from './ipc';

const status = (overrides: Partial<IndexStatus>): IndexStatus => ({
  available: true,
  indexed: false,
  indexing: false,
  progress: null,
  files: 0,
  chunks: 0,
  ...overrides,
});

describe('describeIndexStatus', () => {
  it('explains why the index is not available', () => {
    expect(describeIndexStatus(status({ available: false, reason: 'Open a project first.' }))).toBe(
      'Not available: Open a project first.',
    );
    expect(describeIndexStatus(status({ available: false }))).toBe('Not available: no project');
  });

  it('shows the file scan, then the embedding progress', () => {
    expect(describeIndexStatus(status({ indexing: true }))).toBe('Indexing… scanning files');
    expect(describeIndexStatus(status({ indexing: true, progress: { embedded: 0, total: 0 } }))).toBe(
      'Indexing… scanning files',
    );
    expect(describeIndexStatus(status({ indexing: true, progress: { embedded: 120, total: 480 } }))).toBe(
      'Indexing… 120 of 480 chunks (25%)',
    );
  });

  it('shows the finished index or that there is none', () => {
    expect(describeIndexStatus(status({ indexed: true, files: 12, chunks: 90 }))).toBe('Indexed: 12 files, 90 chunks');
    expect(describeIndexStatus(status({}))).toBe('Not indexed yet');
  });
});

describe('indexStatusLabel', () => {
  it('gives the status bar and chat list labels', () => {
    expect(indexStatusLabel(status({ indexed: true }))).toEqual({
      bar: 'Index: 100% (Ready)',
      short: 'Indexed',
      ready: true,
    });
    expect(indexStatusLabel(status({ indexing: true, progress: { embedded: 1, total: 3 } })).bar).toBe(
      'Index: 33% (Indexing)',
    );
    expect(indexStatusLabel(status({ indexing: true })).bar).toBe('Index: 0% (Indexing)');
    expect(indexStatusLabel(status({})).bar).toBe('Index: 0% (Not built)');
    expect(indexStatusLabel(status({ available: false })).short).toBe('Search off');
  });
});
