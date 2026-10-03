import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import type { Workspace } from '../tools/workspace';

const MAP_CAP = 2500;
// The map is built on the main process when a chat starts, so the walk that counts files must stay short even in a
// huge folder (a home directory, a folder of many repositories). Past this many entries, counts become lower bounds.
const MAX_ENTRIES_VISITED = 20_000;
const ENTRY_FILES = ['pyproject.toml', 'Cargo.toml', 'go.mod'] as const;
const MAX_SCRIPT_NAMES = 12;

interface MapLine {
  depth: number;
  text: string;
}

interface Listed {
  files: number;
  // True when the walk stopped early somewhere below, so `files` is a lower bound.
  partial: boolean;
  children: ListedNode[];
}

interface ListedNode {
  name: string;
  kind: 'dir' | 'file';
  fileCount: number;
  partial: boolean;
  children: ListedNode[];
}

interface WalkBudget {
  left: number;
}

// Two levels of names, with a file count for every directory that includes files below the listed depth.
// Built once per chat inside the system prompt, so it stays in the cached prefix.
export function buildProjectMap(workspace: Workspace, maxEntriesVisited = MAX_ENTRIES_VISITED): string {
  try {
    const listed = readDir(workspace, workspace.root, 0, { left: maxEntriesVisited });
    if (!listed) return '(could not list the project directory)';
    const lines: MapLine[] = [
      { depth: 0, text: filesLabel(listed.files, listed.partial) },
      ...flatten(listed.children, 1),
    ];
    lines.push(...entryLines(workspace).map((text) => ({ depth: 0, text })));
    return limit(lines);
  } catch {
    return '(could not list the project directory)';
  }
}

function readDir(workspace: Workspace, dir: string, displayDepth: number, budget: WalkBudget): Listed | null {
  // Below the shown levels a folder only adds to a count, so it is skipped once the budget is spent.
  if (displayDepth > 1 && budget.left <= 0) return { files: 0, partial: true, children: [] };
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return displayDepth === 0 ? null : { files: 0, partial: false, children: [] };
  }
  budget.left -= entries.length;
  const visible = entries.filter((entry) => {
    if (entry.isSymbolicLink()) return false;
    if (!entry.isDirectory() && !entry.isFile()) return false;
    return !workspace.isIgnored(join(dir, entry.name), entry.isDirectory());
  });
  visible.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, 'en'));

  const children: ListedNode[] = [];
  let files = 0;
  let partial = false;
  for (const entry of visible) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = readDir(workspace, full, displayDepth + 1, budget) ?? { files: 0, partial: false, children: [] };
      files += nested.files;
      partial ||= nested.partial;
      children.push({
        name: entry.name,
        kind: 'dir',
        fileCount: nested.files,
        partial: nested.partial,
        children: displayDepth < 1 ? nested.children : [],
      });
    } else {
      files += 1;
      children.push({ name: entry.name, kind: 'file', fileCount: 1, partial: false, children: [] });
    }
  }
  return { files, partial, children };
}

function flatten(nodes: ListedNode[], depth: number): MapLine[] {
  const lines: MapLine[] = [];
  const indent = '  '.repeat(depth - 1);
  for (const node of nodes) {
    lines.push({
      depth,
      text:
        node.kind === 'dir'
          ? `${indent}${node.name}/ ${filesLabel(node.fileCount, node.partial)}`
          : `${indent}${node.name}`,
    });
    if (node.kind === 'dir' && node.children.length > 0) lines.push(...flatten(node.children, depth + 1));
  }
  return lines;
}

function filesLabel(count: number, partial = false): string {
  if (partial) return `(${count}+ files)`;
  return count === 1 ? '(1 file)' : `(${count} files)`;
}

function entryLines(workspace: Workspace): string[] {
  const parts: string[] = [];
  const packageJson = join(workspace.root, 'package.json');
  if (existsSync(packageJson) && !workspace.isIgnored(packageJson, false)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(packageJson, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        const record = parsed as { main?: unknown; scripts?: unknown };
        const bits: string[] = [];
        if (typeof record.main === 'string' && record.main.trim()) bits.push(`main ${record.main.trim()}`);
        if (record.scripts && typeof record.scripts === 'object') {
          const names = Object.keys(record.scripts as Record<string, unknown>)
            .sort((a, b) => a.localeCompare(b, 'en'))
            .slice(0, MAX_SCRIPT_NAMES);
          if (names.length > 0) bits.push(`scripts ${names.join(', ')}`);
        }
        if (bits.length > 0) parts.push(`package.json ${bits.join('; ')}`);
      }
    } catch {
      // An unreadable or invalid manifest is omitted. The file itself is still listed above.
    }
  }
  for (const name of ENTRY_FILES) {
    const full = join(workspace.root, name);
    if (existsSync(full) && !workspace.isIgnored(full, false)) parts.push(name);
  }
  return parts.length > 0 ? [`Entry points: ${parts.join('; ')}`] : [];
}

// Drops the deepest lines first, last ones first, until the map fits. One pass over a running length: a folder with
// thousands of entries must not re-join the text once per dropped line.
function limit(lines: MapLine[]): string {
  const kept = lines.map((line) => ({ ...line, keep: true }));
  let length = kept.reduce((sum, line) => sum + line.text.length + 1, 0) - 1;
  if (length <= MAP_CAP) return lines.map((line) => line.text).join('\n');
  const deepest = Math.max(...kept.map((line) => line.depth));
  for (let depth = deepest; depth > 0 && length > MAP_CAP; depth--) {
    for (let i = kept.length - 1; i >= 0 && length > MAP_CAP; i--) {
      const line = kept[i]!;
      if (line.depth !== depth || !line.keep) continue;
      line.keep = false;
      length -= line.text.length + 1;
    }
  }
  const text = kept
    .filter((line) => line.keep)
    .map((line) => line.text)
    .join('\n');
  const truncated = `${text}\n(truncated)`;
  if (truncated.length <= MAP_CAP) return truncated;
  const room = MAP_CAP - '\n(truncated)'.length;
  return `${text.slice(0, Math.max(0, room)).trimEnd()}\n(truncated)`;
}
