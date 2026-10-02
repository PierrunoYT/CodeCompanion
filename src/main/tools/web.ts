import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { z } from 'zod';
import { defineTool, ToolError } from './types';

const FETCH_TIMEOUT_MS = 15_000;
const MAX_PAGE_CHARS = 20_000;
const MAX_REDIRECTS = 10;
// A response is read only up to this many bytes, so a huge or endless body cannot fill the main process's memory.
const MAX_BODY_BYTES = 2 * 1024 * 1024;
// Pages fetched in this session, so paging through one (offset) or asking again does not download it twice.
const CACHE_TTL_MS = 15 * 60_000;
const CACHE_MAX_PAGES = 20;
const MAX_HIGHLIGHTS = 15;

interface CachedPage {
  text: string;
  truncated: boolean;
  at: number;
}

const pageCache = new Map<string, CachedPage>();

export function clearFetchCache(): void {
  pageCache.clear();
}

function cachedPage(url: string): CachedPage | null {
  const page = pageCache.get(url);
  if (!page) return null;
  if (Date.now() - page.at > CACHE_TTL_MS) {
    pageCache.delete(url);
    return null;
  }
  return page;
}

function rememberPage(url: string, page: CachedPage): void {
  pageCache.delete(url);
  pageCache.set(url, page);
  while (pageCache.size > CACHE_MAX_PAGES) pageCache.delete(pageCache.keys().next().value as string);
}

// Reads at most `maxBytes` of the body and stops the download there.
export async function readBodyCapped(
  response: Response,
  maxBytes = MAX_BODY_BYTES,
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: '', truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let text = '';
  let received = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      text += decoder.decode(value.subarray(0, value.byteLength - (received - maxBytes)), { stream: true });
      truncated = true;
      await reader.cancel();
      break;
    }
    text += decoder.decode(value, { stream: true });
  }
  return { text: text + decoder.decode(), truncated };
}

const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'what', 'how', 'are', 'was', 'can']);

// The lines of a long page that share the most words with what the model is looking for, in page order.
export function relevantLines(text: string, objective: string): string[] {
  const words = [
    ...new Set((objective.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? []).filter((word) => !STOP_WORDS.has(word))),
  ];
  if (words.length === 0) return [];
  const scored = text
    .split('\n')
    .map((line, index) => ({ line: line.trim(), index }))
    .filter(({ line }) => line.length > 0)
    .map(({ line, index }) => {
      const lower = line.toLowerCase();
      return {
        line: line.length > 300 ? `${line.slice(0, 300)}…` : line,
        index,
        score: words.filter((w) => lower.includes(w)).length,
      };
    })
    .filter(({ score }) => score > 0);
  return scored
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, MAX_HIGHLIGHTS)
    .sort((a, b) => a.index - b.index)
    .map(({ line }) => line);
}

export const webSearchTool = defineTool({
  name: 'web_search',
  description:
    'Search the web (Google). Use for current information such as new library versions, error messages or documentation. Returns titles, links and snippets; use fetch_url to read a page.',
  schema: z.object({ query: z.string().min(1) }),
  requiresApproval: false,
  async run({ query }, context) {
    if (!context.webSearch) {
      throw new ToolError(
        'Web search is not configured. The user can add a Google API key and search engine id in Settings.',
      );
    }
    const url = new URL('https://www.googleapis.com/customsearch/v1');
    url.searchParams.set('key', context.webSearch.googleApiKey);
    url.searchParams.set('cx', context.webSearch.googleSearchEngineId);
    url.searchParams.set('q', query);
    url.searchParams.set('num', '8');

    const response = await fetch(url, { signal: withTimeout(context.signal) });
    if (!response.ok) throw new ToolError(`Search failed: HTTP ${response.status}`);
    const data = (await response.json()) as { items?: Array<{ title: string; link: string; snippet?: string }> };
    const items = data.items ?? [];
    return {
      content:
        items.map((item, i) => `${i + 1}. ${item.title}\n   ${item.link}\n   ${item.snippet ?? ''}`).join('\n') ||
        'No results.',
      summary: `Searched the web for "${query}"`,
    };
  },
});

export const fetchUrlTool = defineTool({
  name: 'fetch_url',
  description:
    'Fetch a web page and return its main text content (for documentation, articles, issues). Long pages come back in parts of about 20,000 characters: follow the offset in the note to read on. Pass objective (what you are looking for) to get the lines of a long page that matter most first. Pages are kept for 15 minutes, so reading the next part does not download it again.',
  schema: z.object({
    url: z.string().url(),
    objective: z
      .string()
      .optional()
      .describe('What you are looking for; the most relevant lines of a long page are listed first.'),
    offset: z.number().int().min(0).optional().describe('Character offset to continue from (default 0).'),
    force_refetch: z.boolean().optional().describe('Download the page again even if it was fetched recently.'),
  }),
  requiresApproval: true,
  async preview({ url }) {
    return { title: `Fetch ${url}` };
  },
  async run({ url, objective, offset = 0, force_refetch = false }, context) {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new ToolError('Only http and https URLs can be fetched.');

    let page = force_refetch ? null : cachedPage(parsed.href);
    if (!page) {
      const response = await fetchWithoutCrossHostRedirect(parsed, context.signal);
      if (!response.ok) {
        await response.body?.cancel();
        throw new ToolError(`HTTP ${response.status} for ${url}`);
      }
      const type = response.headers.get('content-type') ?? '';
      const body = await readBodyCapped(response);
      page = {
        text: type.includes('html') ? extractArticle(body.text) : body.text,
        truncated: body.truncated,
        at: Date.now(),
      };
      rememberPage(parsed.href, page);
    }

    const total = page.text.length;
    if (offset > 0 && offset >= total)
      throw new ToolError(`offset ${offset} is past the end of the page (${total} characters).`);
    const part = page.text.slice(offset, offset + MAX_PAGE_CHARS);
    const end = offset + part.length;

    const sections: string[] = [];
    if (objective && offset === 0 && total > MAX_PAGE_CHARS) {
      const lines = relevantLines(page.text, objective);
      if (lines.length > 0) sections.push(`Lines most relevant to "${objective}":\n${lines.join('\n')}\n\n---`);
    }
    sections.push(part);
    if (end < total) {
      sections.push(`(Characters ${offset}-${end} of ${total}. Use offset=${end} to read on.)`);
    } else if (page.truncated) {
      sections.push(
        `(The download was cut at ${MAX_BODY_BYTES / 1024 / 1024} MB; the rest of the page is not available.)`,
      );
    }
    return {
      content: sections.join('\n\n'),
      summary: offset > 0 ? `Fetched ${url} (from character ${offset})` : `Fetched ${url}`,
    };
  },
});

export async function fetchWithoutCrossHostRedirect(initial: URL, signal: AbortSignal): Promise<Response> {
  let current = initial;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const response = await fetch(current, {
      redirect: 'manual',
      signal: withTimeout(signal),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; Patch)' },
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    await response.body?.cancel();
    const destination = new URL(location, current);
    if (!['http:', 'https:'].includes(destination.protocol) || destination.hostname !== initial.hostname) {
      throw new ToolError(
        `Blocked redirect to ${destination.href}. The destination host was not approved; request that URL separately.`,
      );
    }
    current = destination;
  }
  throw new ToolError(`Too many redirects for ${initial.href}`);
}

export function extractArticle(html: string): string {
  const { document } = parseHTML(html);
  const article = new Readability(document as unknown as Document).parse();
  const text = article?.textContent ?? document.body?.textContent ?? '';
  const title = article?.title ? `${article.title}\n\n` : '';
  return title + text.replace(/\n{3,}/g, '\n\n').trim();
}

function withTimeout(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]);
}
