import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SavedChat } from './agent/session';
import { ChatStore } from './chat_store';
import { ProjectStore } from './projects';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-stores-'));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

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

  it('searches titles, projects and message text, and explains message matches', () => {
    const store = new ChatStore(join(dir, 'chats'));
    const first = {
      ...chat(idA, '2026-01-01T00:00:00Z'),
      title: 'Fix login',
      transcript: [
        { kind: 'user' as const, id: 'u1', text: 'The refresh token is rejected by the API', imageCount: 0 },
        { kind: 'tool' as const, id: 't1', name: 'read_file', status: 'done' as const, output: 'only in tool output: zebra' },
      ],
    };
    const second = { ...chat(idB, '2026-02-01T00:00:00Z'), title: 'Dark mode', projectPath: 'D:\\code\\blog' };
    store.save(first);
    store.save(second);

    expect(store.search('   ').map((item) => item.id)).toEqual([idB, idA]);
    // A title match has no snippet; a message match carries an excerpt.
    expect(store.search('fix')).toEqual([expect.not.objectContaining({ snippet: expect.anything() })]);
    const [byMessage] = store.search('refresh token');
    expect(byMessage.id).toBe(idA);
    expect(byMessage.snippet).toContain('refresh token is rejected');
    // Words may be split between the title and the messages; tool output is not searched.
    expect(store.search('login rejected').map((item) => item.id)).toEqual([idA]);
    expect(store.search('zebra')).toEqual([]);
    expect(store.search('blog').map((item) => item.id)).toEqual([idB]);
  });

  it('forgets cached text when a chat changes or is deleted', () => {
    const store = new ChatStore(join(dir, 'chats'));
    const base = chat(idA, '2026-01-01T00:00:00Z');
    store.save({ ...base, transcript: [{ kind: 'user', id: 'u', text: 'alpha', imageCount: 0 }] });
    expect(store.search('alpha')).toHaveLength(1);
    store.save({ ...base, updatedAt: '2026-01-02T00:00:00Z', transcript: [{ kind: 'user', id: 'u', text: 'beta', imageCount: 0 }] });
    expect(store.search('alpha')).toHaveLength(0);
    expect(store.search('beta')).toHaveLength(1);
    store.delete(idA);
    expect(store.search('beta')).toHaveLength(0);
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

  it('orders tied timestamps by the newest open, including reopening and reload', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-01T12:00:00.000Z'));
    const one = join(dir, 'one');
    const two = join(dir, 'two');
    mkdirSync(one);
    mkdirSync(two);
    const file = join(dir, 'projects.json');

    const store = new ProjectStore(file);
    store.open(one);
    store.open(two);
    expect(store.list().map((project) => project.name)).toEqual(['two', 'one']);
    expect(store.list().map((project) => project.lastOpened)).toEqual([
      '2026-03-01T12:00:00.000Z',
      '2026-03-01T12:00:00.000Z',
    ]);
    expect(new ProjectStore(file).list().map((project) => project.name)).toEqual(['two', 'one']);

    store.open(one);
    expect(store.list().map((project) => project.name)).toEqual(['one', 'two']);
    expect(new ProjectStore(file).list().map((project) => project.name)).toEqual(['one', 'two']);
  });

  it('rejects paths that are not folders', () => {
    const store = new ProjectStore(join(dir, 'projects.json'));
    writeFileSync(join(dir, 'file.txt'), '');
    expect(() => store.open(join(dir, 'file.txt'))).toThrow(/Folder not found/);
    expect(() => store.open(join(dir, 'missing'))).toThrow(/Folder not found/);
  });
});
