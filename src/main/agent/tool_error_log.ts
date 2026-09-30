import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DroppedFieldError } from './agent';

// Keeps the log small: past this size the current file becomes `<file>.old` and a new one starts.
const MAX_BYTES = 512 * 1024;

// Local, append-only record (one JSON object per line) of tool calls that arrived with required fields missing.
// It holds tool and field names only, never field values, and is never sent anywhere.
export class ToolErrorLog {
  constructor(private readonly file: string) {}

  record(error: DroppedFieldError): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      this.rotate();
      appendFileSync(this.file, `${JSON.stringify({ time: new Date().toISOString(), ...error })}\n`, 'utf8');
    } catch {
      // A log that cannot be written must never break the chat.
    }
  }

  private rotate(): void {
    try {
      if (statSync(this.file).size > MAX_BYTES) renameSync(this.file, `${this.file}.old`);
    } catch {
      // No log yet.
    }
  }
}
