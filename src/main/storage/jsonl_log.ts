import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

// Keeps a log small: past this size the current file becomes `<file>.old` and a new one starts.
const MAX_BYTES = 512 * 1024;

// Append-only local log with one JSON object per line. Writing never throws: a log that cannot be written must not
// break the app.
export class JsonlLog {
  constructor(private file: string | null) {}

  // Sets or changes the file after construction, for logs that exist before the user data folder is known.
  setFile(file: string | null): void {
    this.file = file;
  }

  append(entry: Record<string, unknown>): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      this.rotate(this.file);
      appendFileSync(this.file, `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`, 'utf8');
    } catch {
      // Ignored on purpose, see above.
    }
  }

  private rotate(file: string): void {
    try {
      if (statSync(file).size > MAX_BYTES) renameSync(file, `${file}.old`);
    } catch {
      // No log yet.
    }
  }
}
