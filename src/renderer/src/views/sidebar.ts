import { filterChats, type ChatSummary } from '@shared/chat';
import { formatCost } from '@shared/models';
import { h, icon } from '../dom';

export interface SidebarActions {
  list(): Promise<ChatSummary[]>;
  search(query: string): Promise<ChatSummary[]>;
  open(id: string): void;
  newChat(): void;
}

// The saved chats, newest first, grouped by day, next to the chat. The full history dialog (search, delete, clear)
// stays behind the header's history button.
export class Sidebar {
  readonly element: HTMLElement;
  private readonly list = h('nav', { class: 'sidebar-list', 'aria-label': 'Recent chats' });
  private readonly filter = h('input', {
    type: 'search',
    class: 'form-control form-control-sm',
    placeholder: 'Filter chats…',
    'aria-label': 'Filter chats',
  }) as HTMLInputElement;
  private chats: ChatSummary[] = [];
  // Result of the message search for the current filter; until it arrives, titles and projects are filtered here.
  private found: ChatSummary[] | null = null;
  private activeId = '';
  private searchTimer: ReturnType<typeof setTimeout> | undefined;
  private searchGeneration = 0;

  constructor(private readonly actions: SidebarActions) {
    this.filter.addEventListener('input', () => {
      this.found = null;
      this.render();
      this.scheduleSearch();
    });
    this.element = h(
      'aside',
      { class: 'sidebar' },
      h(
        'div',
        { class: 'sidebar-top' },
        h('span', { class: 'sidebar-heading' }, 'Chats'),
        h(
          'button',
          { class: 'btn btn-sm btn-ghost ms-auto', title: 'New chat (Ctrl+N)', onclick: () => this.actions.newChat() },
          icon('plus-lg'),
          ' New chat',
        ),
      ),
      h('div', { class: 'sidebar-filter' }, icon('search'), this.filter),
      this.list,
    );
  }

  async refresh(): Promise<void> {
    this.update(await this.actions.list());
  }

  update(chats: ChatSummary[]): void {
    this.chats = chats;
    this.found = null;
    this.render();
    this.scheduleSearch();
  }

  setActive(id: string): void {
    if (id === this.activeId) return;
    this.activeId = id;
    this.render();
  }

  private scheduleSearch(): void {
    clearTimeout(this.searchTimer);
    const query = this.filter.value.trim();
    if (!query) return;
    const generation = ++this.searchGeneration;
    this.searchTimer = setTimeout(async () => {
      const found = await this.actions.search(query).catch(() => null);
      if (generation !== this.searchGeneration || !found) return;
      this.found = found;
      this.render();
    }, 200);
  }

  private render(): void {
    const query = this.filter.value.trim();
    const shown = query && this.found ? this.found : filterChats(this.chats, query);
    if (shown.length === 0) {
      this.list.replaceChildren(
        h('div', { class: 'sidebar-empty' }, this.chats.length === 0 ? 'No saved chats yet.' : 'No chats match.'),
      );
      return;
    }
    const groups = new Map<string, ChatSummary[]>();
    for (const chat of shown) {
      const group = dayGroup(chat.updatedAt);
      groups.set(group, [...(groups.get(group) ?? []), chat]);
    }
    this.list.replaceChildren(
      ...[...groups].flatMap(([group, chats]) => [
        h('div', { class: 'sidebar-group' }, group),
        ...chats.map((chat) => this.item(chat)),
      ]),
    );
  }

  private item(chat: ChatSummary): HTMLElement {
    const project = chat.projectPath?.split(/[\\/]/).pop();
    const active = chat.id === this.activeId;
    return h(
      'button',
      {
        class: `sidebar-item${active ? ' active' : ''}`,
        title: chat.projectPath ? `${chat.title}\n${chat.projectPath}` : chat.title,
        'aria-current': active ? 'true' : 'false',
        onclick: () => this.actions.open(chat.id),
      },
      h(
        'span',
        { class: 'sidebar-item-row' },
        h('span', { class: 'sidebar-item-title' }, chat.title),
        typeof chat.cost === 'number' ? h('span', { class: 'sidebar-item-cost' }, formatCost(chat.cost)) : null,
      ),
      h(
        'span',
        { class: 'sidebar-item-meta' },
        project ? `${project} · ${relativeTime(chat.updatedAt)}` : relativeTime(chat.updatedAt),
      ),
      chat.snippet ? h('span', { class: 'sidebar-item-snippet' }, chat.snippet) : null,
    );
  }
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function dayGroup(iso: string, now = new Date()): string {
  const days = Math.round((startOfDay(now) - startOfDay(new Date(iso))) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'Previous 7 days';
  return 'Older';
}

export function relativeTime(iso: string, now = new Date()): string {
  const minutes = Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString();
}
