import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { z } from 'zod';
import { detectEol, fileSize, isBinaryFile, MAX_READ_BYTES, withLineNumbers } from './text_files';
import { defineTool, ToolError, truncateOutput, type ToolContext } from './types';

const DEFAULT_READ_LINES = 2000;

export const readFileTool = defineTool({
  name: 'read_file',
  description:
    'Read a text file from the project. Returns the content with line numbers. For large files, use offset and limit to read a range. Read a file before editing or overwriting it.',
  schema: z.object({
    path: z.string().describe('File path, relative to the project root.'),
    offset: z.number().int().min(1).optional().describe('First line to read (1-based).'),
    limit: z.number().int().min(1).optional().describe(`Number of lines to read (default ${DEFAULT_READ_LINES}).`),
  }),
  requiresApproval: false,
  async run({ path, offset = 1, limit = DEFAULT_READ_LINES }, context) {
    const file = context.workspace.resolve(path);
    if (!existsSync(file)) throw new ToolError(`File not found: ${path}`);
    if (statSync(file).isDirectory()) throw new ToolError(`${path} is a directory. Use list_directory.`);
    if (await isBinaryFile(file)) throw new ToolError(`${path} is a binary file.`);
    if ((await fileSize(file)) > MAX_READ_BYTES * 8) throw new ToolError(`${path} is too large to read.`);

    const lines = (await readFile(file, 'utf8')).split(/\r?\n/);
    const selected = lines.slice(offset - 1, offset - 1 + limit);
    context.readFiles.add(file);

    const rel = context.workspace.relative(file);
    const more = offset - 1 + selected.length < lines.length;
    const footer = more
      ? `\n\n(Showing lines ${offset}-${offset + selected.length - 1} of ${lines.length}. Use offset to read more.)`
      : '';
    return {
      content: truncateOutput(withLineNumbers(selected, offset)) + footer,
      summary: `Read ${rel} (${selected.length} lines)`,
    };
  },
});

export const listDirectoryTool = defineTool({
  name: 'list_directory',
  description: 'List files and folders in a project directory, skipping files ignored by .gitignore.',
  schema: z.object({
    path: z.string().optional().describe('Directory, relative to the project root. Defaults to the root.'),
    recursive: z.boolean().optional().describe('List all files below the directory (up to 500).'),
  }),
  requiresApproval: false,
  async run({ path = '.', recursive = false }, context) {
    const dir = context.workspace.resolve(path);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new ToolError(`Not a directory: ${path}`);
    const rel = context.workspace.relative(dir);

    if (recursive) {
      const files = await context.workspace.listFiles(dir, 501);
      const shown = files.slice(0, 500).map((file) => context.workspace.relative(file));
      const note = files.length > 500 ? '\n(More than 500 files; list a subdirectory to see the rest.)' : '';
      return { content: (shown.join('\n') || '(empty)') + note, summary: `Listed ${rel} (${shown.length} files)` };
    }

    const entries = (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => !context.workspace.isIgnored(join(dir, entry.name), entry.isDirectory()))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
    return { content: entries.join('\n') || '(empty)', summary: `Listed ${rel}` };
  },
});

export const grepTool = defineTool({
  name: 'grep',
  description:
    'Search file contents in the project with a regular expression. Returns matching lines as path:line: text. Use for exact names and strings; use search_code for questions about behavior.',
  schema: z.object({
    pattern: z.string().describe('JavaScript regular expression.'),
    path: z.string().optional().describe('Directory or file to search, relative to the project root.'),
    ignore_case: z.boolean().optional(),
  }),
  requiresApproval: false,
  async run({ pattern, path = '.', ignore_case = false }, context) {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, ignore_case ? 'i' : '');
    } catch (error) {
      throw new ToolError(`Invalid regular expression: ${(error as Error).message}`);
    }
    const target = context.workspace.resolve(path);
    const files = statSync(target).isDirectory() ? await context.workspace.listFiles(target) : [target];

    const matches: string[] = [];
    for (const file of files) {
      if (context.signal.aborted || matches.length >= 200) break;
      if ((await fileSize(file)) > MAX_READ_BYTES || (await isBinaryFile(file))) continue;
      const lines = (await readFile(file, 'utf8')).split(/\r?\n/);
      lines.forEach((line, index) => {
        if (matches.length < 200 && regex.test(line)) {
          matches.push(`${context.workspace.relative(file)}:${index + 1}: ${line.trim().slice(0, 300)}`);
        }
      });
    }
    const note = matches.length >= 200 ? '\n(Stopped at 200 matches; narrow the pattern or path.)' : '';
    return {
      content: (matches.join('\n') || 'No matches.') + note,
      summary: `Searched for /${pattern}/ (${matches.length} matches)`,
    };
  },
});

export const writeFileTool = defineTool({
  name: 'write_file',
  description:
    'Create a new file or replace an entire file. Existing files must be read first. Prefer edit_file for changes to existing files.',
  schema: z.object({
    path: z.string().describe('File path, relative to the project root.'),
    content: z.string().describe('The complete file content.'),
  }),
  requiresApproval: true,
  async preview({ path, content }, context) {
    const file = context.workspace.resolve(path);
    const before = existsSync(file) ? await readFile(file, 'utf8') : '';
    const rel = context.workspace.relative(file);
    return { title: existsSync(file) ? `Overwrite ${rel}` : `Create ${rel}`, diff: unifiedDiff(rel, before, content) };
  },
  async run({ path, content }, context) {
    const file = context.workspace.resolve(path);
    const exists = existsSync(file);
    if (exists) requireRead(file, path, context);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content, 'utf8');
    context.readFiles.add(file);
    if (path.endsWith('.gitignore')) context.workspace.invalidateIgnoreRules();
    const rel = context.workspace.relative(file);
    return { content: `${exists ? 'Updated' : 'Created'} ${rel}.`, summary: `${exists ? 'Wrote' : 'Created'} ${rel}` };
  },
});

export const editFileTool = defineTool({
  name: 'edit_file',
  description:
    'Replace an exact string in a file. old_string must match the file exactly (including indentation) and be unique unless replace_all is true. Read the file first. Include enough surrounding lines to make old_string unique.',
  schema: z.object({
    path: z.string().describe('File path, relative to the project root.'),
    old_string: z.string().min(1).describe('Exact text to replace.'),
    new_string: z.string().describe('Replacement text.'),
    replace_all: z.boolean().optional().describe('Replace every occurrence instead of requiring a unique match.'),
  }),
  requiresApproval: true,
  async preview(input, context) {
    const file = context.workspace.resolve(input.path);
    const rel = context.workspace.relative(file);
    const before = await readFile(file, 'utf8');
    return { title: `Edit ${rel}`, diff: unifiedDiff(rel, before, applyEdit(before, input)) };
  },
  async run(input, context) {
    const file = context.workspace.resolve(input.path);
    if (!existsSync(file)) throw new ToolError(`File not found: ${input.path}`);
    requireRead(file, input.path, context);
    const before = await readFile(file, 'utf8');
    const after = applyEdit(before, input);
    await writeFile(file, after, 'utf8');
    const rel = context.workspace.relative(file);
    return {
      content: `Edited ${rel}.\n${unifiedDiff(rel, before, after)}`,
      summary: `Edited ${rel}`,
    };
  },
});

function requireRead(file: string, path: string, context: ToolContext): void {
  if (!context.readFiles.has(file)) {
    throw new ToolError(`Read ${path} with read_file before changing it.`);
  }
}

// Exported for tests. Matching tolerates the file using CRLF while the model sends LF.
export function applyEdit(
  content: string,
  { old_string, new_string, replace_all = false }: { old_string: string; new_string: string; replace_all?: boolean },
): string {
  const eol = detectEol(content);
  const find = eol === '\r\n' ? old_string.replace(/\r?\n/g, '\r\n') : old_string;
  const replacement = eol === '\r\n' ? new_string.replace(/\r?\n/g, '\r\n') : new_string;

  const count = content.split(find).length - 1;
  if (count === 0) {
    throw new ToolError('old_string was not found in the file. Read the file again and copy the text exactly.');
  }
  if (count > 1 && !replace_all) {
    throw new ToolError(
      `old_string appears ${count} times. Add surrounding lines to make it unique, or set replace_all.`,
    );
  }
  return replace_all ? content.split(find).join(replacement) : content.replace(find, () => replacement);
}

export function unifiedDiff(path: string, before: string, after: string): string {
  return createTwoFilesPatch(`a/${path}`, `b/${path}`, before, after, '', '', { context: 3 });
}
