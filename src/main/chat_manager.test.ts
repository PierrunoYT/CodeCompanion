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

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-manager-'));
    mkdirSync(join(root, 'alpha'));
    mkdirSync(join(root, 'beta'));
    projects = new ProjectStore(join(root, 'projects.json'));
    chats = new ChatStore(join(root, 'chats'));
    const settings = new SettingsStore(join(root, 'settings.json'), {
      isAvailable: () => false, encrypt: (value) => value, decrypt: (value) => value,
    });
    const llm = new LlmService(settings);
    const conversation = (): Conversation => ({
      provider: 'anthropic', model: 'test', addUserMessage() {}, addToolResults() {},
      async runTurn() {
        return { text: 'Done', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0 } };
      },
      serialize: () => ({ provider: 'anthropic', model: 'test', messages: [] }),
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
});
