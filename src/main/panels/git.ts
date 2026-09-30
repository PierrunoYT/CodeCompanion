import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { createTwoFilesPatch } from 'diff';
import { simpleGit, type SimpleGit, type StatusResult } from 'simple-git';
import type { GitFile, GitStatus } from '@shared/panels';
import { Workspace } from '../tools/workspace';

// The Git panel: changed files, diffs, commit and discard for the open project.
export class GitService {
  private readonly git: SimpleGit;
  private readonly workspace: Workspace;

  constructor(root: string) {
    this.workspace = new Workspace(root);
    this.git = simpleGit({ baseDir: this.workspace.root });
  }

  async status(): Promise<GitStatus> {
    if (!(await this.isRepo())) return { isRepo: false, branch: null, files: [] };
    const status = await this.git.status();
    return { isRepo: true, branch: status.current, files: toFiles(status) };
  }

  // Unified diff of all changes, or of one file. Untracked files are shown as additions.
  async diff(path: string | null): Promise<string> {
    if (!(await this.isRepo())) return '';
    const status = await this.git.status();
    const files = toFiles(status).filter((file) => path === null || file.path === path);

    const parts: string[] = [];
    const originals = new Map(status.renamed.map((rename) => [rename.to, rename.from]));
    const tracked = new Set<string>();
    for (const file of files) {
      if (file.status === 'untracked') continue;
      tracked.add(file.path);
      const original = originals.get(file.path);
      if (original) tracked.add(original);
    }
    if (tracked.size > 0) {
      const paths = [...tracked].map((path) => {
        this.workspace.resolve(path);
        return `:(literal)${path}`;
      });
      const hasHead = await this.git.revparse(['--verify', 'HEAD']).then(
        () => true,
        () => false,
      );
      if (hasHead) {
        parts.push(await this.git.diff(['HEAD', '--', ...paths]));
      } else {
        // An unborn branch has no HEAD: show both the initial index and subsequent working edits.
        parts.push(await this.git.diff(['--cached', '--', ...paths]));
        parts.push(await this.git.diff(['--', ...paths]));
      }
    }
    for (const file of files.filter((candidate) => candidate.status === 'untracked')) {
      const absolute = this.workspace.resolve(file.path);
      const content = await readFile(absolute, 'utf8').catch(() => '');
      parts.push(createTwoFilesPatch('/dev/null', `b/${file.path}`, '', content, '', ''));
    }
    return parts.filter(Boolean).join('\n');
  }

  async commit(message: string): Promise<GitStatus> {
    if (!message.trim()) throw new Error('Enter a commit message.');
    await this.git.add(['-A']);
    await this.git.commit(message.trim());
    return this.status();
  }

  // Reverts one file to the last commit; new (untracked) files are deleted.
  async discard(path: string): Promise<GitStatus> {
    if (!(await this.isRepo())) return this.status();
    const status = await this.git.status();
    const file = toFiles(status).find((candidate) => candidate.path === path);
    if (!file) return this.status();
    const absolute = this.workspace.resolve(path);
    const literalPath = `:(literal)${path}`;
    const rename = status.renamed.find((candidate) => candidate.to === path);
    if (file.status === 'untracked') {
      await rm(absolute, { force: true, recursive: true });
    } else if (rename) {
      this.workspace.resolve(rename.from);
      await this.git.raw([
        '--literal-pathspecs',
        'restore',
        '--source=HEAD',
        '--staged',
        '--worktree',
        '--',
        rename.from,
        path,
      ]);
    } else if (file.status === 'added') {
      await this.git.rm(['--cached', '--', literalPath]);
      if (existsSync(absolute)) await rm(absolute, { force: true });
    } else {
      await this.git.checkout(['HEAD', '--', literalPath]);
    }
    return this.status();
  }

  async init(): Promise<GitStatus> {
    await this.git.init();
    return this.status();
  }

  private async isRepo(): Promise<boolean> {
    try {
      return (await this.git.revparse(['--show-toplevel'])).length > 0;
    } catch {
      return false;
    }
  }
}

function toFiles(status: StatusResult): GitFile[] {
  const files = new Map<string, GitFile>();
  const add = (path: string, fileStatus: GitFile['status']) => {
    if (!files.has(path)) files.set(path, { path, status: fileStatus });
  };
  status.conflicted.forEach((path) => add(path, 'conflicted'));
  status.renamed.forEach((rename) => add(rename.to, 'renamed'));
  status.created.forEach((path) => add(path, 'added'));
  status.deleted.forEach((path) => add(path, 'deleted'));
  status.modified.forEach((path) => add(path, 'modified'));
  status.not_added.forEach((path) => add(path, 'untracked'));
  // Anything else git reports (e.g. type changes) shows as modified.
  status.files.forEach((file) => add(file.path, 'modified'));
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}
