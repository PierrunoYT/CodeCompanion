import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatManager } from './chat_manager';
import { ChatStore } from './chat_store';
import { LlmService, type Conversation } from './llm';
import { ProjectStore } from './projects';
import { SettingsStore } from './settings';

describe('project chat retention', () => {
  let root: string;
  let projects: ProjectStore;
  let manager: ChatManager;
  let chats: ChatStore;
  let settings: SettingsStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-manager-'));
    mkdirSync(join(root, 'alpha'));
    mkdirSync(join(root, 'beta'));
    projects = new ProjectStore(join(root, 'projects.json'));
    chats = new ChatStore(join(root, 'chats'));
    settings = new SettingsStore(join(root, 'settings.json'), {
      isAvailable: () => false, encrypt: (value) => value, decrypt: (value) => value,
    });
    const llm = new LlmService(settings);
    const conversation = (): Conversation => ({
      provider: 'anthropic', model: 'test', addUserMessage() {}, addToolResults() {},
      async runTurn() {
        return { text: 'Done', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0 } };
      },
      serialize: () => ({ provider: 'anthropic', model: 'test', messages: [] }),
      planCompaction: () => null,
      applyCompaction() {},
    });
    vi.spyOn(llm, 'createConversation').mockImplementation(conversation);
    vi.spyOn(llm, 'restoreConversation').mockImplementation(conversation);
    manager = new ChatManager({
      projects, chats, settings, llm, browser: () => null, codeSearch: () => null,
      emit() {}, onSnapshot() {}, onHistoryChanged() {},
    });
  });

  afterEach(() => {
    manager.dispose();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  function open(name: string): void {
    projects.open(join(root, name));
    manager.projectChanged();
  }

  it('has nothing to compact before a chat exists, and reports when a short chat needs no compaction', async () => {
    open('alpha');
    expect(() => manager.compact()).toThrow(/no chat to compact/);

    await manager.send({ text: 'A short task' });
    await manager.compact();
    expect(manager.snapshot().transcript.at(-1)).toMatchObject({ kind: 'notice', text: expect.stringContaining('not enough older history') });
  });

  it('refuses images for a model that does not accept them, judged by the model the chat will use', async () => {
    open('alpha');
    const image = { mediaType: 'image/png' as const, base64: 'AAAA' };
    settings.update({ model: 'claude-custom' });

    expect(() => manager.send({ text: 'Look', images: [image] })).toThrow(/claude-custom does not accept images/);
    // Nothing was started: no chat and nothing saved.
    expect(manager.snapshot().id).toBe('');
    expect(chats.list()).toEqual([]);
    // Text alone is fine.
    await manager.send({ text: 'Just text' });

    // An open chat keeps its own model (here 'test', an OpenAI-compatible id), whatever the setting says now.
    await manager.send({ text: 'Look', images: [image] });
    expect(manager.snapshot().transcript.filter((item) => item.kind === 'user').at(-1)).toMatchObject({ imageCount: 1 });
  });

  it('does not write a deleted chat back, whether it was open or parked in another project', async () => {
    open('alpha');
    await manager.send({ text: 'Alpha task' });
    const alphaId = manager.snapshot().id;
    open('beta');
    await manager.send({ text: 'Beta task' });
    const betaId = manager.snapshot().id;
    expect(chats.list().map((chat) => chat.id).sort()).toEqual([alphaId, betaId].sort());

    // Beta is open, Alpha is parked. Delete both, the way the history dialog does.
    for (const id of [alphaId, betaId]) {
      manager.forget([id]);
      chats.delete(id);
    }
    expect(manager.snapshot().id).toBe('');

    // Switching projects and quitting used to save them again.
    open('alpha');
    open('beta');
    manager.dispose();
    expect(chats.list()).toEqual([]);
    expect(chats.load(alphaId)).toBeNull();
    expect(chats.load(betaId)).toBeNull();
  });

  it('forgets every session when all chats are deleted, and keeps chats that were not deleted', async () => {
    open('alpha');
    await manager.send({ text: 'Keep me' });
    const kept = manager.snapshot().id;
    manager.forget(['someone-else']);
    manager.dispose();
    expect(chats.load(kept)).not.toBeNull();

    manager.forget('all');
    chats.deleteAll();
    manager.dispose();
    expect(chats.list()).toEqual([]);
  });

  it('has no edit to undo without a chat, or when nothing keeps backups', async () => {
    open('alpha');
    await expect(manager.undoEdit('toolu_1')).rejects.toThrow(/no edit to undo/);
    await manager.send({ text: 'A task' });
    await expect(manager.undoEdit('toolu_1')).rejects.toThrow(/no edit to undo/);
  });

  it('retains per-project sessions and starts a new chat only in the active project', async () => {
    open('alpha');
    await manager.send({ text: 'Alpha task' });
    const alpha = manager.snapshot();
    open('beta');
    await manager.send({ text: 'Beta task' });
    const beta = manager.snapshot();
    open('alpha');
    expect(manager.snapshot()).toEqual(alpha);
    manager.newChat();
    expect(manager.snapshot().id).toBe('');
    open('beta');
    expect(manager.snapshot()).toEqual(beta);
    expect(chats.load(alpha.id)?.transcript[0]).toMatchObject({ text: 'Alpha task' });
  });

  it('closing an inactive project does not alter the active chat and history can reopen it', async () => {
    open('alpha');
    await manager.send({ text: 'Alpha task' });
    const alpha = manager.snapshot();
    open('beta');
    await manager.send({ text: 'Beta task' });
    const beta = manager.snapshot();
    manager.closeProject(join(root, 'alpha'));
    projects.close(join(root, 'alpha'));
    manager.projectChanged();
    expect(manager.snapshot()).toEqual(beta);
    expect(manager.open(alpha.id).id).toBe(alpha.id);
    open('beta');
    expect(manager.snapshot()).toEqual(beta);
  });

  it('refuses to send, resume, compact or switch while an undo is putting a file back, and saves its note', async () => {
    open('alpha');
    const alphaPath = join(root, 'alpha');
    const id = '11111111-2222-4333-8444-555555555555';
    chats.save({
      version: 1, id, title: 'Edit', projectPath: alphaPath, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      system: '', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }, readFiles: [],
      conversation: { provider: 'anthropic', model: 'test', messages: [] },
      transcript: [
        { kind: 'user', id: 'u1', text: 'Edit it', imageCount: 0 },
        { kind: 'tool', id: 'card-1', name: 'edit_file', status: 'done', path: 'notes.txt', undo: 'available' },
      ],
    });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    const edits = { undo: vi.fn(async () => (await gate, { path: 'notes.txt', action: 'restored' as const, absolute: join(alphaPath, 'notes.txt') })) };
    manager.dispose();
    const llm = new LlmService(settings);
    const conversation = (): Conversation => ({
      provider: 'anthropic', model: 'test', addUserMessage() {}, addToolResults() {},
      async runTurn() {
        return { text: 'Done', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0 } };
      },
      serialize: () => ({ provider: 'anthropic', model: 'test', messages: [] }),
      planCompaction: () => null,
      applyCompaction() {},
    });
    vi.spyOn(llm, 'createConversation').mockImplementation(conversation);
    vi.spyOn(llm, 'restoreConversation').mockImplementation(conversation);
    manager = new ChatManager({
      projects, chats, settings, llm, browser: () => null, codeSearch: () => null,
      emit() {}, onSnapshot() {}, onHistoryChanged() {}, edits: edits as never,
    });
    manager.projectChanged();
    manager.open(id);

    const undoing = manager.undoEdit('card-1');
    expect(manager.busy).toBe(true);
    expect(() => manager.send({ text: 'Now' })).toThrow(/still working/);
    expect(() => manager.resume()).toThrow();
    expect(() => manager.compact()).toThrow(/still working/);
    expect(() => manager.newChat()).toThrow();
    await expect(manager.undoEdit('card-1')).rejects.toThrow();

    finish();
    await undoing;
    expect(manager.busy).toBe(false);
    expect(edits.undo).toHaveBeenCalledTimes(1);
    expect(chats.load(id)?.pendingNotes).toEqual([expect.stringContaining('The user undid your edit to notes.txt')]);
    await manager.send({ text: 'Now' });
    expect(chats.load(id)?.pendingNotes).toEqual([]);
  });
});
