export interface Chunk {
  startLine: number; // 1-based, inclusive
  endLine: number; // inclusive
  text: string;
}

const CHUNK_LINES = 60;
const OVERLAP_LINES = 10;
// Embedding inputs are capped; very long lines (minified code) are cut so one chunk cannot exceed the limit.
const MAX_CHUNK_CHARS = 6000;

// Splits a file into overlapping line windows. The path is part of each chunk's text so that searches for a file
// or module name also match its contents.
export function chunkFile(path: string, content: string): Chunk[] {
  const lines = content.split(/\r?\n/);
  if (lines.length > 0 && lines.at(-1) === '') lines.pop();
  if (lines.length === 0) return [];

  const chunks: Chunk[] = [];
  for (let start = 0; start < lines.length; start += CHUNK_LINES - OVERLAP_LINES) {
    const end = Math.min(start + CHUNK_LINES, lines.length);
    const body = lines.slice(start, end).join('\n');
    if (body.trim()) {
      chunks.push({ startLine: start + 1, endLine: end, text: `${path}\n${body}`.slice(0, MAX_CHUNK_CHARS) });
    }
    if (end === lines.length) break;
  }
  return chunks;
}
