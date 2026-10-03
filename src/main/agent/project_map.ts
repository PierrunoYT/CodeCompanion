import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import type { Workspace } from '../tools/workspace';

const MAP_CAP = 2500;
const ENTRY_FILES = ['pyproject.toml', 'Cargo.toml', 'go.mod'] as const;
const MAX_SCRIPT_NAMES = 12;

interface MapLine {
  depth: number;
  text: string;
}

interface Listed {
  files: number;
  children: ListedNode[];
}

interface ListedNode {
  name: string;
  kind: 'dir' | 'file';
  fileCount: number;
  children: ListedNode[];
}

// Two levels of names, with a file count for every directory that includes files below the listed depth.
// Built once per chat inside the system prompt, so it stays in the cached prefix.
export function buildProjectMap(workspace: Workspace): string {
  try {
    const listed = readDir(workspace, workspace.root, 0);
    if (!listed) return '(could not list the project directory)';
    const lines: MapLine[] = [{ depth: 0, text: filesLabel(listed.files) }, ...flatten(listed.children, 1)];
    lines.push(...entryLines(workspace).map((text) => ({ depth: 0, text })));
    return limit(lines);
  } catch {
    return '(could not list the project directory)';
  }
}

function readDir(workspace: Workspace, dir: string, displayDepth: number): Listed | null {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return displayDepth === 0 ? null : { files: 0, children: [] };
  }
  const visible = entries.filter((entry) => {
    if (entry.isSymbolicLink()) return false;
    if (!entry.isDirectory() && !entry.isFile()) return false;
    return !workspace.isIgnored(join(dir, entry.name), entry.isDirectory());
  });
  visible.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, 'en'));

  const children: ListedNode[] = [];
  let files = 0;
  for (const entry of visible) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = readDir(workspace, full, displayDepth + 1) ?? { files: 0, children: [] };
      files += nested.files;
      children.push({
        name: entry.name,
        kind: 'dir',
        fileCount: nested.files,
        children: displayDepth < 1 ? nested.children : [],
      });
    } else {
      files += 1;
      children.push({ name: entry.name, kind: 'file', fileCount: 1, children: [] });
    }
  }
  return { files, children };
}

function flatten(nodes: ListedNode[], depth: number): MapLine[] {
  const lines: MapLine[] = [];
  const indent = '  '.repeat(depth - 1);
  for (const node of nodes) {
    lines.push({
      depth,
      text: node.kind === 'dir' ? `${indent}${node.name}/ ${filesLabel(node.fileCount)}` : `${indent}${node.name}`,
    });
    if (node.kind === 'dir' && node.children.length > 0) lines.push(...flatten(node.children, depth + 1));
  }
  return lines;
}

function filesLabel(count: number): string {
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

function limit(lines: MapLine[]): string {
  const kept = [...lines];
  const body = () => kept.map((line) => line.text).join('\n');
  let text = body();
  if (text.length <= MAP_CAP) return text;
  while (text.length > MAP_CAP) {
    let index = -1;
    let deepest = -1;
    for (let i = 0; i < kept.length; i++) {
      const depth = kept[i]?.depth ?? -1;
      if (depth >= deepest && depth > 0) {
        deepest = depth;
        index = i;
      }
    }
    if (index < 0) break;
    kept.splice(index, 1);
    text = body();
  }
  const truncated = `${text}\n(truncated)`;
  if (truncated.length <= MAP_CAP) return truncated;
  const room = MAP_CAP - '\n(truncated)'.length;
  return `${text.slice(0, Math.max(0, room)).trimEnd()}\n(truncated)`;
}
