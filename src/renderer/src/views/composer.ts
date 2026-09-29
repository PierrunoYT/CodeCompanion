import type { ImageAttachment } from '@shared/ipc';
import { h, icon } from '../dom';

export interface ComposerActions {
  send(text: string, images: ImageAttachment[]): Promise<boolean>;
  stop(): void;
  pickImages(): Promise<ImageAttachment[]>;
}

const PASTE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export class Composer {
  readonly element: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  private readonly sendButton: HTMLButtonElement;
  private readonly stopButton: HTMLButtonElement;
  private readonly attachmentList: HTMLElement;
  private images: ImageAttachment[] = [];
  private busy = false;

  constructor(private readonly actions: ComposerActions) {
    this.input = h('textarea', {
      class: 'form-control composer-input',
      rows: 1,
      placeholder: 'Describe a task or ask a question…  (Enter to send, Shift+Enter for a new line)',
      'aria-label': 'Message',
      oninput: () => this.autosize(),
      onkeydown: (event: KeyboardEvent) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          void this.submit();
        }
      },
      onpaste: (event: ClipboardEvent) => this.paste(event),
    });
    this.sendButton = h('button', { class: 'btn btn-primary', title: 'Send', onclick: () => void this.submit() }, icon('send'));
    this.stopButton = h(
      'button',
      { class: 'btn btn-danger', title: 'Stop (Ctrl+.)', hidden: true, onclick: () => this.actions.stop() },
      icon('stop-fill'),
      ' Stop',
    );
    this.attachmentList = h('div', { class: 'composer-attachments' });

    this.element = h(
      'div',
      { class: 'composer' },
      this.attachmentList,
      h(
        'div',
        { class: 'composer-row' },
        h(
          'button',
          { class: 'btn btn-outline-secondary', title: 'Attach images', onclick: () => void this.attach() },
          icon('paperclip'),
        ),
        this.input,
        this.sendButton,
        this.stopButton,
      ),
    );
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    this.sendButton.hidden = busy;
    this.stopButton.hidden = !busy;
  }

  focus(): void {
    this.input.focus();
  }

  private async submit(): Promise<void> {
    const text = this.input.value.trim();
    if (this.busy || (!text && this.images.length === 0)) return;
    const sent = await this.actions.send(text, this.images);
    if (sent) {
      this.input.value = '';
      this.images = [];
      this.renderAttachments();
      this.autosize();
    }
  }

  private async attach(): Promise<void> {
    this.images.push(...(await this.actions.pickImages()));
    this.renderAttachments();
  }

  private paste(event: ClipboardEvent): void {
    const files = [...(event.clipboardData?.files ?? [])].filter((file) => PASTE_TYPES.has(file.type));
    if (files.length === 0) return;
    event.preventDefault();
    for (const file of files) {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = String(reader.result).split(',')[1] ?? '';
        this.images.push({ name: file.name || 'pasted image', mediaType: file.type as ImageAttachment['mediaType'], base64 });
        this.renderAttachments();
      };
      reader.readAsDataURL(file);
    }
  }

  private renderAttachments(): void {
    this.attachmentList.replaceChildren(
      ...this.images.map((image, index) =>
        h(
          'span',
          { class: 'badge text-bg-secondary me-1' },
          icon('image'),
          ` ${image.name} `,
          h(
            'button',
            {
              class: 'btn-close btn-close-white btn-sm ms-1',
              'aria-label': `Remove ${image.name}`,
              onclick: () => {
                this.images.splice(index, 1);
                this.renderAttachments();
              },
            },
          ),
        ),
      ),
    );
  }

  private autosize(): void {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(this.input.scrollHeight, 240)}px`;
  }
}
