import { markAnnounced, newAnnouncements } from '@shared/announce';
import { commandNotice, diffNotice, outputNotice, type ApprovalDecision, type TranscriptItem } from '@shared/chat';
import { h, icon, trustedHtml } from '../dom';
import { renderDiff, renderMarkdown } from '../markdown';

export interface TranscriptActions {
  decide(id: string, decision: ApprovalDecision): void;
  openFile(path: string): void;
  // Puts back the file an approved edit changed. The card is the edit's own tool card.
  undoEdit(id: string, path: string | undefined): void;
  theme(): 'dark' | 'light';
}

// Gives `target` the attributes and children of `source`, keeping `target` itself in place. Listeners set by h() are
// on the children, which move along; the item elements themselves have none.
function morph(target: HTMLElement, source: HTMLElement): void {
  for (const { name } of [...target.attributes]) if (!source.hasAttribute(name)) target.removeAttribute(name);
  for (const { name, value } of [...source.attributes]) if (target.getAttribute(name) !== value) target.setAttribute(name, value);
  target.replaceChildren(...source.childNodes);
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
  readonly element = h('div', { class: 'transcript' });
  // Screen-reader only. The transcript itself is not a live region: it is re-rendered on every streamed chunk, which
  // a screen reader would read out again and again. This announces finished answers, approvals and failures once.
  readonly announcer = h('div', { class: 'visually-hidden', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'false' });
  private readonly announced = new Set<string>();
  private primed = false;
  private readonly nodes = new Map<string, { item: TranscriptItem; node: HTMLElement }>();
  // <details> the user opened, so re-rendering a card does not collapse it.
  private readonly expanded = new Set<string>();

  constructor(private readonly actions: TranscriptActions) {}

  render(items: TranscriptItem[]): void {
    // The scrolling element is the wrapper around the transcript's parent, not the direct parent.
    const container = this.element.closest<HTMLElement>('.chat-scroll-wrap');
    const last = items[items.length - 1];
    // Always follow when the user just sent a message; otherwise only if already near the bottom.
    const stick =
      !container ||
      last?.kind === 'user' ||
      container.scrollHeight - container.scrollTop - container.clientHeight < 80;

    const seen = new Set<string>();
    let previous: HTMLElement | null = null;
    for (const item of items) {
      seen.add(item.id);
      let entry = this.nodes.get(item.id);
      if (!entry || entry.item !== item) {
        const node = this.renderItem(item);
        // Update a changed item in place rather than swapping its element: a new element among the transcript's
        // children makes the browser recheck the styles of the whole (long) list, on every streamed frame.
        if (entry && entry.node.tagName === node.tagName) morph(entry.node, node);
        else if (entry) entry.node.replaceWith(node);
        entry = { item, node: entry && entry.node.tagName === node.tagName ? entry.node : node };
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

    // The first render after a reset is a chat being opened, not news.
    if (!this.primed) {
      markAnnounced(items, this.announced);
      this.primed = true;
    } else {
      for (const message of newAnnouncements(items, this.announced)) this.announcer.appendChild(h('div', {}, message));
    }
  }

  reset(): void {
    this.announced.clear();
    this.primed = false;
    this.announcer.replaceChildren();
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
      running: h('span', { class: 'spinner-border spinner-border-sm text-secondary', role: 'img', 'aria-label': 'Running' }),
      done: h('span', {}, icon('check2', 'text-success'), h('span', { class: 'visually-hidden' }, 'Done')),
      error: h('span', {}, icon('x-circle', 'text-danger'), h('span', { class: 'visually-hidden' }, 'Failed')),
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
      item.undo === 'available'
        ? h(
            'button',
            {
              class: 'btn btn-outline-secondary btn-sm py-0 ms-2 undo-button',
              title: 'Put the file back the way it was before this edit',
              'aria-label': `Undo ${title}`,
              onclick: (event: Event) => {
                // The button sits in the card's summary; do not also open or close the card.
                event.preventDefault();
                event.stopPropagation();
                this.actions.undoEdit(item.id, item.path);
              },
            },
            icon('arrow-counterclockwise'),
            ' Undo',
          )
        : item.undo === 'undone'
          ? h('span', { class: 'badge text-bg-secondary ms-2' }, 'Undone')
          : null,
      h('span', { class: 'ms-auto' }, status[item.status]),
    );

    const preview = () => this.renderPreview(item);
    const output = () => item.output
      ? h(
          'div',
          {},
          item.outputOmittedChars
            ? h('div', { class: 'tool-truncated' }, icon('scissors'), ` ${outputNotice(item.outputOmittedChars)}`)
            : null,
          h('pre', { class: 'tool-output' }, item.output),
        )
      : null;

    if (item.status === 'awaiting-approval') {
      const feedback = h('textarea', {
        class: 'form-control form-control-sm',
        rows: 1,
        placeholder: 'Optional: tell the assistant what to do instead',
        'aria-label': 'Optional feedback if you decline',
      });
      const decide = (approved: boolean) => this.actions.decide(item.id, { approved, feedback: approved ? undefined : feedback.value });
      return h(
        'div',
        { class: 'tool-card awaiting', role: 'group', 'aria-label': `Approval needed: ${title}`, dataset: { id: item.id } },
        header,
        preview(),
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
      return h('div', { class: 'tool-card running', dataset: { id: item.id } }, header, output());
    }

    const hasBody = Boolean(item.preview?.diff || item.preview?.command || item.output);
    return h(
      'div',
      { class: `tool-card ${item.status}`, dataset: { id: item.id } },
      // Built when the card is first opened: a long chat has many finished cards, most of them never opened, and their
      // diffs are by far the largest part of the page.
      hasBody ? this.details(item.id, header, () => [preview(), output()].filter(Boolean) as HTMLElement[]) : header,
    );
  }

  private renderPreview(item: Extract<TranscriptItem, { kind: 'tool' }>): HTMLElement | null {
    const preview = item.preview;
    // Approving a change that is only partly shown needs a clear warning; afterwards a plain note is enough.
    const notice = (text: string) =>
      item.status === 'awaiting-approval'
        ? h('div', { class: 'alert alert-warning py-1 px-2 mb-1 small', role: 'note' }, icon('exclamation-triangle'), ` ${text}`)
        : h('div', { class: 'tool-truncated' }, icon('scissors'), ` ${text}`);
    if (preview?.diff) {
      return h(
        'div',
        {},
        trustedHtml('div', 'tool-diff', renderDiff(preview.diff, this.actions.theme())),
        preview.diffOmittedLines ? notice(diffNotice(preview.diffOmittedLines, item.status === 'awaiting-approval')) : null,
      );
    }
    if (preview?.command) {
      return h(
        'div',
        {},
        h('pre', { class: 'tool-command' }, `$ ${preview.command}${preview.commandOmittedChars ? ' …' : ''}`),
        preview.commandOmittedChars ? notice(commandNotice(preview.commandOmittedChars)) : null,
      );
    }
    return null;
  }

  // `content` may be a function, which is then called only when the details are first opened.
  private details(id: string, summary: HTMLElement, content: HTMLElement | (() => HTMLElement[])): HTMLElement {
    const open = this.expanded.has(id);
    const build = typeof content === 'function' ? content : () => [content];
    const details = h('details', { open }, h('summary', {}, summary), ...(open ? build() : []));
    let built = open;
    details.addEventListener('toggle', () => {
      if (details.open && !built) {
        built = true;
        details.append(...build());
      }
      if (details.open) this.expanded.add(id);
      else this.expanded.delete(id);
    });
    return details;
  }
}
