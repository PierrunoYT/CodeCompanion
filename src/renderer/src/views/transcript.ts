import type { ApprovalDecision, TranscriptItem } from '@shared/chat';
import { h, icon, trustedHtml } from '../dom';
import { renderDiff, renderMarkdown } from '../markdown';

export interface TranscriptActions {
  decide(id: string, decision: ApprovalDecision): void;
  openFile(path: string): void;
  theme(): 'dark' | 'light';
}

const TOOL_ICONS: Record<string, string> = {
  read_file: 'file-earmark-text',
  list_directory: 'folder2-open',
  grep: 'search',
  search_code: 'search-heart',
  edit_file: 'pencil-square',
  write_file: 'file-earmark-plus',
  run_command: 'terminal',
  command_output: 'terminal',
  web_search: 'globe',
  fetch_url: 'globe',
  browser: 'window',
};

// Renders the transcript, re-creating only items whose object changed (the reducer returns new objects only for
// updated items), and keeps the view scrolled to the bottom while the user has not scrolled up.
export class TranscriptView {
  readonly element = h('div', { class: 'transcript', 'aria-live': 'polite' });
  private readonly nodes = new Map<string, { item: TranscriptItem; node: HTMLElement }>();
  // <details> the user opened, so re-rendering a card does not collapse it.
  private readonly expanded = new Set<string>();

  constructor(private readonly actions: TranscriptActions) {}

  render(items: TranscriptItem[]): void {
    const container = this.element.parentElement;
    const stick = !container || container.scrollHeight - container.scrollTop - container.clientHeight < 80;

    const seen = new Set<string>();
    let previous: HTMLElement | null = null;
    for (const item of items) {
      seen.add(item.id);
      let entry = this.nodes.get(item.id);
      if (!entry || entry.item !== item) {
        const node = this.renderItem(item);
        if (entry) entry.node.replaceWith(node);
        entry = { item, node };
        this.nodes.set(item.id, entry);
      }
      const expectedNext: ChildNode | null = previous ? previous.nextSibling : this.element.firstChild;
      if (expectedNext !== entry.node) {
        this.element.insertBefore(entry.node, expectedNext);
      }
      previous = entry.node;
    }
    for (const [id, entry] of this.nodes) {
      if (!seen.has(id)) {
        entry.node.remove();
        this.nodes.delete(id);
      }
    }

    if (stick && container) container.scrollTop = container.scrollHeight;
  }

  reset(): void {
    this.nodes.clear();
    this.expanded.clear();
    this.element.replaceChildren();
  }

  private renderItem(item: TranscriptItem): HTMLElement {
    switch (item.kind) {
      case 'user':
        return h(
          'div',
          { class: 'message user', dataset: { id: item.id } },
          h('div', { class: 'bubble' }, item.text),
          item.imageCount > 0 ? h('div', { class: 'attachments' }, icon('image'), ` ${item.imageCount} image(s)`) : null,
        );
      case 'assistant':
        return h(
          'div',
          { class: `message assistant${item.streaming ? ' streaming' : ''}`, dataset: { id: item.id } },
          item.thinking ? this.details(`${item.id}:thinking`, h('span', {}, icon('lightbulb'), ' Thinking'), trustedHtml('div', 'markdown thinking', renderMarkdown(item.thinking))) : null,
          item.text ? trustedHtml('div', 'markdown', renderMarkdown(item.text)) : null,
          item.streaming && !item.text ? h('div', { class: 'typing' }, h('span'), h('span'), h('span')) : null,
        );
      case 'tool':
        return this.renderTool(item);
      case 'error':
        return h('div', { class: 'message error alert alert-danger py-2', dataset: { id: item.id } }, icon('exclamation-triangle'), ' ', item.text);
      case 'notice':
        return h('div', { class: 'message notice', dataset: { id: item.id } }, icon('info-circle'), ' ', item.text);
    }
  }

  private renderTool(item: Extract<TranscriptItem, { kind: 'tool' }>): HTMLElement {
    const title = item.summary ?? item.preview?.title ?? item.name.replace(/_/g, ' ');
    const status: Record<typeof item.status, HTMLElement> = {
      'awaiting-approval': h('span', { class: 'badge text-bg-warning' }, 'Needs approval'),
      running: h('span', { class: 'spinner-border spinner-border-sm text-secondary', role: 'status' }),
      done: icon('check2', 'text-success'),
      error: icon('x-circle', 'text-danger'),
      declined: h('span', { class: 'badge text-bg-secondary' }, 'Declined'),
    };

    const header = h(
      'div',
      { class: 'tool-header' },
      icon(TOOL_ICONS[item.name] ?? 'tools'),
      h('span', { class: 'tool-title' }, title),
      item.path && item.status !== 'awaiting-approval'
        ? h(
            'button',
            { class: 'btn btn-link btn-sm p-0 ms-1', title: 'Open in editor', onclick: () => this.actions.openFile(item.path!) },
            icon('box-arrow-up-right'),
          )
        : null,
      h('span', { class: 'ms-auto' }, status[item.status]),
    );

    const preview = this.renderPreview(item);
    const output = item.output ? h('pre', { class: 'tool-output' }, item.output) : null;

    if (item.status === 'awaiting-approval') {
      const feedback = h('textarea', {
        class: 'form-control form-control-sm',
        rows: 1,
        placeholder: 'Optional: tell the assistant what to do instead',
      });
      const decide = (approved: boolean) => this.actions.decide(item.id, { approved, feedback: approved ? undefined : feedback.value });
      return h(
        'div',
        { class: 'tool-card awaiting', dataset: { id: item.id } },
        header,
        preview,
        h(
          'div',
          { class: 'approval' },
          feedback,
          h('button', { class: 'btn btn-outline-secondary btn-sm', onclick: () => decide(false) }, 'Decline'),
          h('button', { class: 'btn btn-primary btn-sm', onclick: () => decide(true) }, icon('check2'), ' Approve'),
        ),
      );
    }

    if (item.status === 'running') {
      return h('div', { class: 'tool-card running', dataset: { id: item.id } }, header, output);
    }

    const body = [preview, output].filter(Boolean) as HTMLElement[];
    return h(
      'div',
      { class: `tool-card ${item.status}`, dataset: { id: item.id } },
      body.length > 0 ? this.details(item.id, header, ...body) : header,
    );
  }

  private renderPreview(item: Extract<TranscriptItem, { kind: 'tool' }>): HTMLElement | null {
    if (item.preview?.diff) return trustedHtml('div', 'tool-diff', renderDiff(item.preview.diff, this.actions.theme()));
    if (item.preview?.command) return h('pre', { class: 'tool-command' }, `$ ${item.preview.command}`);
    return null;
  }

  private details(id: string, summary: HTMLElement, ...content: HTMLElement[]): HTMLElement {
    const details = h('details', { open: this.expanded.has(id) }, h('summary', {}, summary), ...content);
    details.addEventListener('toggle', () => (details.open ? this.expanded.add(id) : this.expanded.delete(id)));
    return details;
  }
}
