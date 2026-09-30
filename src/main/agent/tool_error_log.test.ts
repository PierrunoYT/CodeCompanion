import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DroppedFieldError } from './agent';
import { ToolErrorLog } from './tool_error_log';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-toolerrors-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const entry = (tool = 'edit_file'): DroppedFieldError => ({
  tool,
  model: 'm',
  missing: ['new_string'],
  invalid: [],
  received: ['path', 'old_string'],
});

const lines = (file: string) =>
  readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

describe('ToolErrorLog', () => {
  it('appends one JSON line per error with a timestamp, creating the folder', () => {
    const file = join(dir, 'logs', 'tool-input-errors.jsonl');
    const log = new ToolErrorLog(file);
    log.record(entry());
    log.record(entry('write_file'));

    const written = lines(file);
    expect(written).toHaveLength(2);
    expect(written[0]).toEqual({ time: expect.stringMatching(/^\d{4}-\d\d-\d\dT/), ...entry() });
    expect(written[1].tool).toBe('write_file');
  });

  it('starts a new file once the log is large, keeping the previous one', () => {
    const file = join(dir, 'log.jsonl');
    writeFileSync(file, `${'x'.repeat(600 * 1024)}\n`);
    new ToolErrorLog(file).record(entry());

    expect(readFileSync(`${file}.old`, 'utf8')).toMatch(/^x+\n$/);
    expect(lines(file)).toHaveLength(1);
  });

  it('never throws when the log cannot be written', () => {
    // A file where the log folder should be.
    writeFileSync(join(dir, 'logs'), '');
    expect(() => new ToolErrorLog(join(dir, 'logs', 'log.jsonl')).record(entry())).not.toThrow();
    expect(existsSync(join(dir, 'logs', 'log.jsonl'))).toBe(false);
  });
});
