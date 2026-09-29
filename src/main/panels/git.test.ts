import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitService } from './git';

const tempFolderInsideRepo = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: tmpdir() }).status === 0;

let root: string;
let service: GitService;

async function initRepo(): Promise<void> {
  const git = simpleGit({ baseDir: root });
  await git.init();
  await git.addConfig('user.name', 'Test');
  await git.addConfig('user.email', 'test@example.com');
  await git.addConfig('commit.gpgsign', 'false');
  await git.addConfig('core.autocrlf', 'false');
  writeFileSync(join(root, 'a.txt'), 'one\n');
  await git.add('-A');
  await git.commit('first');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-git-'));
  service = new GitService(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('GitService', () => {
  // Git finds a repository in any parent folder, so this cannot hold when the temp folder is inside one (for example
  // a home folder under version control).
  it.skipIf(tempFolderInsideRepo)('reports a folder that is not a repository', async () => {
    expect(await service.status()).toEqual({ isRepo: false, branch: null, files: [] });
    expect(await service.diff(null)).toBe('');
  });

  it('initializes a repository', async () => {
    const status = await service.init();
    expect(status.isRepo).toBe(true);
    expect(status.files).toEqual([]);
  });

  it('lists modified and untracked files, sorted by path', async () => {
    await initRepo();
    writeFileSync(join(root, 'a.txt'), 'two\n');
    writeFileSync(join(root, 'b.txt'), 'new\n');
    const status = await service.status();
    expect(status.isRepo).toBe(true);
    expect(status.files).toEqual([
      { path: 'a.txt', status: 'modified' },
      { path: 'b.txt', status: 'untracked' },
    ]);
  });

  it('shows tracked changes and untracked files in the diff', async () => {
    await initRepo();
    writeFileSync(join(root, 'a.txt'), 'two\n');
    writeFileSync(join(root, 'b.txt'), 'brand new\n');
    const all = await service.diff(null);
    expect(all).toContain('-one');
    expect(all).toContain('+two');
    expect(all).toContain('+brand new');

    const onlyNew = await service.diff('b.txt');
    expect(onlyNew).toContain('+brand new');
    expect(onlyNew).not.toContain('+two');
  });

  it('commits all changes and rejects an empty message', async () => {
    await initRepo();
    writeFileSync(join(root, 'a.txt'), 'two\n');
    await expect(service.commit('   ')).rejects.toThrow('Enter a commit message.');
    const status = await service.commit('  update  ');
    expect(status.files).toEqual([]);
    const log = await simpleGit({ baseDir: root }).log();
    expect(log.latest?.message).toBe('update');
  });

  it('discards a modified file, deletes an untracked file and unstages an added file', async () => {
    await initRepo();
    const git = simpleGit({ baseDir: root });
    writeFileSync(join(root, 'a.txt'), 'changed\n');
    writeFileSync(join(root, 'untracked.txt'), 'x\n');
    mkdirSync(join(root, 'dir'));
    writeFileSync(join(root, 'dir', 'staged.txt'), 'y\n');
    await git.add('dir/staged.txt');

    await service.discard('a.txt');
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('one\n');

    await service.discard('untracked.txt');
    expect(existsSync(join(root, 'untracked.txt'))).toBe(false);

    const status = await service.discard('dir/staged.txt');
    expect(existsSync(join(root, 'dir', 'staged.txt'))).toBe(false);
    expect(status.files).toEqual([]);
  });

  it('ignores a discard of a file without changes', async () => {
    await initRepo();
    const status = await service.discard('a.txt');
    expect(status.files).toEqual([]);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('one\n');
  });
});
