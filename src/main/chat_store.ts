import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatSummary } from '@shared/chat';
import type { SavedChat } from './agent/session';
import { readJson, writeJson } from './storage/json_file';

const ID_PATTERN = /^[0-9a-f-]{36}$/;

// Saved chats, one JSON file each in userData/chats, plus an index for fast listing.
export class ChatStore {
  private index: ChatSummary[];

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.index = readJson<ChatSummary[]>(this.indexFile, []);
    if (this.index.length === 0) this.rebuildIndex();
  }

  list(): ChatSummary[] {
    return [...this.index].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  save(chat: SavedChat): void {
    writeJson(this.chatFile(chat.id), chat);
    const summary: ChatSummary = {
      id: chat.id,
      title: chat.title,
      projectPath: chat.projectPath,
      updatedAt: chat.updatedAt,
    };
    this.index = [summary, ...this.index.filter((item) => item.id !== chat.id)];
    writeJson(this.indexFile, this.index);
  }

  load(id: string): SavedChat | null {
    if (!ID_PATTERN.test(id)) return null;
    const chat = readJson<SavedChat | null>(this.chatFile(id), null);
    return chat?.version === 1 ? chat : null;
  }

  delete(id: string): void {
    if (!ID_PATTERN.test(id)) return;
    rmSync(this.chatFile(id), { force: true });
    this.index = this.index.filter((item) => item.id !== id);
    writeJson(this.indexFile, this.index);
  }

  deleteAll(): void {
    for (const item of this.index) rmSync(this.chatFile(item.id), { force: true });
    this.index = [];
    writeJson(this.indexFile, this.index);
  }

  private get indexFile(): string {
    return join(this.dir, 'index.json');
  }

  private chatFile(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  // Recovers the index if it was lost or corrupted.
  private rebuildIndex(): void {
    if (!existsSync(this.dir)) return;
    this.index = readdirSync(this.dir)
      .filter((name) => ID_PATTERN.test(name.replace(/\.json$/, '')))
      .map((name) => readJson<SavedChat | null>(join(this.dir, name), null))
      .filter((chat): chat is SavedChat => chat?.version === 1)
      .map((chat) => ({ id: chat.id, title: chat.title, projectPath: chat.projectPath, updatedAt: chat.updatedAt }));
    if (this.index.length > 0) writeJson(this.indexFile, this.index);
  }
}
