import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Workspace } from '../tools/workspace';
import { buildProjectMap } from './project_map';

describe('buildProjectMap', () => {
  let root: string;

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function workspace(build: (dir: string) => void): Workspace {
    root = mkdtempSync(join(tmpdir(), 'patch-map-'));
    build(root);
    return new Workspace(root);
  }

  it('lists two levels, counts files under the listed depth, and reads entry points', () => {
    const map = buildProjectMap(
      workspace((dir) => {
        mkdirSync(join(dir, 'src', 'lib'), { recursive: true });
        writeFileSync(join(dir, 'src', 'main.ts'), '');
        writeFileSync(join(dir, 'src', 'lib', 'a.ts'), '');
        writeFileSync(join(dir, 'src', 'lib', 'b.ts'), '');
        writeFileSync(
          join(dir, 'package.json'),
          JSON.stringify({ main: 'src/main.ts', scripts: { test: 'vitest', dev: 'tsx' } }),
        );
        writeFileSync(join(dir, 'Cargo.toml'), '');
        mkdirSync(join(dir, 'node_modules', 'left-pad'), { recursive: true });
        writeFileSync(join(dir, 'node_modules', 'left-pad', 'index.js'), '');
      }),
    );

    expect(map).toBe(
      [
        '(5 files)',
        'src/ (3 files)',
        '  lib/ (2 files)',
        '  main.ts',
        'Cargo.toml',
        'package.json',
        'Entry points: package.json main src/main.ts; scripts dev, test; Cargo.toml',
      ].join('\n'),
    );
    expect(map).not.toContain('a.ts');
    expect(map).not.toContain('node_modules');
  });

  it('is the same string for the same tree and caps the body at 2500 characters', () => {
    const make = () =>
      workspace((dir) => {
        for (let i = 0; i < 120; i++) writeFileSync(join(dir, `component-${String(i).padStart(3, '0')}-name.ts`), '');
      });
    const map = buildProjectMap(make());
    expect(map).toBe(buildProjectMap(new Workspace(root)));
    expect(map.length).toBeLessThanOrEqual(2500);
    expect(map.endsWith('(truncated)')).toBe(true);
  });

  it('stops counting below the shown levels once its entry budget is spent, and says the counts are lower bounds', () => {
    const map = buildProjectMap(
      workspace((dir) => {
        for (const name of ['a', 'b', 'c']) {
          mkdirSync(join(dir, name, 'deep', 'deeper'), { recursive: true });
          for (let i = 0; i < 5; i++) writeFileSync(join(dir, name, 'deep', 'deeper', `f${i}.ts`), '');
        }
      }),
      5,
    );
    // The shown levels are always listed; only the counts below them stop early.
    expect(map).toContain('a/');
    expect(map).toContain('deep/');
    expect(map).toMatch(/\(\d+\+ files\)/);
  });

  it('trims a folder with thousands of entries in one pass', () => {
    const ws = workspace((dir) => {
      mkdirSync(join(dir, 'many'));
      for (let i = 0; i < 4000; i++) writeFileSync(join(dir, 'many', `file-${i}.txt`), '');
    });
    const start = performance.now();
    const map = buildProjectMap(ws);
    expect(performance.now() - start).toBeLessThan(2000);
    expect(map.length).toBeLessThanOrEqual(2500);
    expect(map).toContain('many/ (4000 files)');
  });
});
