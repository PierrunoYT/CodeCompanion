import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { confineFileUrl } from './browser';
import { Workspace } from './workspace';

// confineFileUrl decides which file:// URLs the browser tool may open without asking: only files inside the project.
describe('confineFileUrl', () => {
  let root: string;
  let outside: string;
  let workspace: Workspace;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'patch-confine-'));
    outside = mkdtempSync(join(tmpdir(), 'patch-confine-outside-'));
    writeFileSync(join(root, 'page.html'), '<h1>inside</h1>');
    writeFileSync(join(outside, 'secret.html'), '<h1>outside</h1>');
    workspace = new Workspace(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('returns a file inside the project as its normalized file:// URL', () => {
    const url = pathToFileURL(join(root, 'page.html')).href;
    expect(confineFileUrl(url, workspace)).toBe(pathToFileURL(workspace.resolve('page.html')).href);
  });

  it('refuses a file outside the project', () => {
    expect(() => confineFileUrl(pathToFileURL(join(outside, 'secret.html')).href, workspace)).toThrow(
      /outside the project/,
    );
  });

  it('refuses a file outside the project whatever the case of the scheme', () => {
    const url = pathToFileURL(join(outside, 'secret.html')).href.replace(/^file:/, 'FILE:');
    expect(() => confineFileUrl(url, workspace)).toThrow(/outside the project/);
  });

  it('leaves http(s) URLs to the network rules', () => {
    expect(confineFileUrl('https://example.com/', workspace)).toBe('https://example.com/');
  });
});
