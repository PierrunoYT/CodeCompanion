import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SavedChat } from './agent/session';
import { ChatStore } from './chat_store';
import { ProjectStore } from './projects';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-stores-'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function chat(id: string, updatedAt: string): SavedChat {
  return {
    version: 1,
    id,
    title: `Chat ${id.slice(0, 4)}`,
    projectPath: null,
    createdAt: updatedAt,
    updatedAt,
    system: 's',
    transcript: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
    conversation: { provider: 'anthropic', model: 'm', messages: [] },
    readFiles: [],
  };
}

const idA = '11111111-1111-1111-1111-111111111111';
const idB = '22222222-2222-2222-2222-222222222222';

describe('ChatStore', () => {
  it('saves, lists newest first, loads and deletes', () => {
    const store = new ChatStore(join(dir, 'chats'));
    store.save(chat(idA, '2026-01-01T00:00:00Z'));
    store.save(chat(idB, '2026-02-01T00:00:00Z'));
    expect(store.list().map((item) => item.id)).toEqual([idB, idA]);
    expect(store.load(idA)?.title).toBe('Chat 1111');

    store.delete(idB);
    expect(new ChatStore(join(dir, 'chats')).list().map((item) => item.id)).toEqual([idA]);
  });

  it('rejects ids that are not UUIDs', () => {
    const store = new ChatStore(join(dir, 'chats'));
    expect(store.load('../settings')).toBeNull();
  });

  it('rebuilds a missing index from the chat files', () => {
    const store = new ChatStore(join(dir, 'chats'));
    store.save(chat(idA, '2026-01-01T00:00:00Z'));
    rmSync(join(dir, 'chats', 'index.json'));
    expect(new ChatStore(join(dir, 'chats')).list().map((item) => item.id)).toEqual([idA]);
  });
});

describe('ProjectStore', () => {
  it('opens folders, remembers instructions and keeps recent projects', () => {
    const one = join(dir, 'one');
    const two = join(dir, 'two');
    mkdirSync(one);
    mkdirSync(two);
    const file = join(dir, 'projects.json');

    const store = new ProjectStore(file);
    store.open(one);
    const second = store.open(two);
    store.setInstructions(second.path, 'Use pnpm.');

    const reloaded = new ProjectStore(file);
    expect(reloaded.list().map((project) => project.name)).toEqual(['two', 'one']);
    expect(reloaded.list()[0].instructions).toBe('Use pnpm.');
    expect(reloaded.current()).toBeNull();
  });

  it('rejects paths that are not folders', () => {
    const store = new ProjectStore(join(dir, 'projects.json'));
    writeFileSync(join(dir, 'file.txt'), '');
    expect(() => store.open(join(dir, 'file.txt'))).toThrow(/Folder not found/);
    expect(() => store.open(join(dir, 'missing'))).toThrow(/Folder not found/);
  });
});
