import DOMPurify from 'dompurify';
import { html as diffToHtml } from 'diff2html';
import { ColorSchemeType } from 'diff2html/lib/types';
import hljs from 'highlight.js/lib/common';
import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';

const marked = new Marked(
  markedHighlight({
    emptyLangClass: 'hljs',
    langPrefix: 'hljs language-',
    highlight(code, lang) {
      const language = hljs.getLanguage(lang) ? lang : 'plaintext';
      return hljs.highlight(code, { language }).value;
    },
  }),
  { gfm: true, breaks: false },
);

// Model output is untrusted: rendered markdown is always sanitized before it reaches the DOM. Images and embeds are
// removed too, because an image URL written by a prompt-injected model is a way to leak data.
export function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false }) as string, {
    ADD_ATTR: ['target'],
    FORBID_TAGS: ['img', 'picture', 'video', 'audio', 'source', 'iframe', 'object', 'embed', 'form', 'input', 'style'],
  });
}

export function renderDiff(diff: string, theme: 'dark' | 'light'): string {
  const html = diffToHtml(diff, {
    drawFileList: false,
    matching: 'lines',
    outputFormat: 'line-by-line',
    colorScheme: theme === 'dark' ? ColorSchemeType.DARK : ColorSchemeType.LIGHT,
  });
  return DOMPurify.sanitize(html);
}
