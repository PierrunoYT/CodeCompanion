import { z } from 'zod';
import type { ToolSpec } from './types';

export interface JsonObjectSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

// JSON Schema for a tool's input, shared by both providers.
export function toolInputSchema(tool: ToolSpec): JsonObjectSchema {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(tool.schema) as Record<string, unknown>;
  return { ...schema, type: 'object' };
}
