import { JsonlLog } from '../storage/jsonl_log';
import type { DroppedFieldError } from './agent';

// Local record of tool calls that arrived with required fields missing. It holds tool and field names only, never
// field values, and is never sent anywhere.
export class ToolErrorLog {
  private readonly log: JsonlLog;

  constructor(file: string) {
    this.log = new JsonlLog(file);
  }

  record(error: DroppedFieldError): void {
    this.log.append({ ...error });
  }
}
