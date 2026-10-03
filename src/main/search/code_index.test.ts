import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Workspace } from '../tools/workspace';
import { chunkFile } from './chunker';
import { CodeIndex, openRouterEmbedder, type Embedder, type EmbeddingInput } from './code_index';

// Deterministic stand-in for an embedding model: a bag of hashed words.
class FakeEmbedder implements Embedder {
  readonly model = 'fake';
  calls: string[][] = [];
  inputs: EmbeddingInput[] = [];

  async embed(texts: string[], input: EmbeddingInput): Promise<number[][]> {
    this.calls.push(texts);
    this.inputs.push(input);
    return texts.map((text) => {
      const vector = new Array(64).fill(0);
      for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
        let hash = 0;
        for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) % 64;
        vector[hash] += 1;
      }
      return vector;
    });
  }

  get embeddedTexts(): number {
    return this.calls.flat().length;
  }
}

let root: string;
let indexDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-index-'));
  indexDir = mkdtempSync(join(tmpdir(), 'cc-index-store-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(
    join(root, 'src', 'auth.ts'),
    'export function validateSession(token) {\n  return checkToken(token);\n}\n',
  );
  writeFileSync(join(root, 'src', 'cart.ts'), 'export function addToCart(item) {\n  cart.push(item);\n}\n');
  writeFileSync(join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x00, 0x00]));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(indexDir, { recursive: true, force: true });
});

const signal = new AbortController().signal;

describe('chunkFile', () => {
  it('splits long files into overlapping windows with the path included', () => {
    const content = Array.from({ length: 130 }, (_, i) => `line ${i + 1}`).join('\n');
    const chunks = chunkFile('src/big.ts', content);
    expect(chunks.map((chunk) => [chunk.startLine, chunk.endLine])).toEqual([
      [1, 60],
      [51, 110],
      [101, 130],
    ]);
    expect(chunks[0]!.text.startsWith('src/big.ts\nline 1')).toBe(true);
  });

  it('returns nothing for empty files', () => {
    expect(chunkFile('a', '')).toEqual([]);
    expect(chunkFile('a', '\n')).toEqual([]);
  });
});

describe('CodeIndex', () => {
  it('finds the most relevant file and skips binaries', async () => {
    const embedder = new FakeEmbedder();
    const index = new CodeIndex(new Workspace(root), embedder, indexDir, () => 1000);
    const hits = await index.search('validate session token', 5, signal);
    expect(hits[0]).toMatchObject({ path: 'src/auth.ts', startLine: 1 });
    expect(hits[0]!.text).toContain('validateSession');
    expect(index.fileCount).toBe(2);
    // Chunks are embedded as documents, the search text as a query.
    expect(embedder.inputs.at(-1)).toBe('query');
    expect(new Set(embedder.inputs.slice(0, -1))).toEqual(new Set(['document']));
  });

  it('reports status and re-embeds everything on rebuild', async () => {
    const embedder = new FakeEmbedder();
    const index = new CodeIndex(new Workspace(root), embedder, indexDir, () => 1000);
    expect(index.fileCount).toBe(0);
    await index.update();
    expect(index.chunkCount).toBeGreaterThan(0);
    expect(index.isUpdating).toBe(false);
    const afterFirst = embedder.embeddedTexts;

    await index.rebuild();
    expect(embedder.embeddedTexts).toBe(afterFirst * 2);
    expect(index.fileCount).toBe(2);
  });

  it('exposes progress while updating and clears it afterwards', async () => {
    const index = new CodeIndex(new Workspace(root), new FakeEmbedder(), indexDir, () => 1000);
    const seen: Array<{
      reported: { embedded: number; total: number };
      exposed: { embedded: number; total: number } | null;
    }> = [];

    const running = index.update(undefined, (reported) => seen.push({ reported, exposed: index.updateProgress }));
    expect(index.isUpdating).toBe(true);
    expect(index.updateProgress).toBeNull();
    await running;

    // The getter shows what was just reported, and the last report covers all chunks.
    expect(seen.length).toBeGreaterThan(0);
    for (const { reported, exposed } of seen) expect(exposed).toEqual(reported);
    const last = seen.at(-1)!.reported;
    expect(last.embedded).toBe(last.total);
    expect(last.total).toBe(index.chunkCount);
    expect(index.updateProgress).toBeNull();
    expect(index.isUpdating).toBe(false);
  });

  it('only re-embeds changed files and drops deleted ones', async () => {
    const embedder = new FakeEmbedder();
    const index = new CodeIndex(new Workspace(root), embedder, indexDir, () => 1000);
    await index.update();
    const afterFirst = embedder.embeddedTexts;

    await index.update();
    expect(embedder.embeddedTexts).toBe(afterFirst);

    writeFileSync(join(root, 'src', 'cart.ts'), 'export function removeFromCart(item) {}\n');
    const future = new Date(Date.now() + 10_000);
    utimesSync(join(root, 'src', 'cart.ts'), future, future);
    rmSync(join(root, 'src', 'auth.ts'));
    await index.update();

    expect(embedder.embeddedTexts).toBe(afterFirst + 1);
    expect(index.fileCount).toBe(1);
  });

  it('persists the index and reloads it without re-embedding', async () => {
    const first = new FakeEmbedder();
    await new CodeIndex(new Workspace(root), first, indexDir, () => 1000).update();

    const second = new FakeEmbedder();
    const reloaded = new CodeIndex(new Workspace(root), second, indexDir, () => 1000);
    const hits = await reloaded.search('add item to cart', 1, signal);
    expect(second.embeddedTexts).toBe(1); // just the query
    expect(hits[0]!.path).toBe('src/cart.ts');
  });

  it('looks at no more files than the limit (skipped binaries count toward it)', async () => {
    // Breadth-first order: logo.png (binary, skipped), then src/auth.ts.
    const index = new CodeIndex(new Workspace(root), new FakeEmbedder(), indexDir, () => 2);
    await index.update();
    expect(index.fileCount).toBe(1);
  });
});

describe('openRouterEmbedder', () => {
  const respond = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('posts Voyage code embeddings to OpenRouter and returns them in input order', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return respond(200, {
        data: [
          { index: 1, embedding: [0, 1] },
          { index: 0, embedding: [1, 0] },
        ],
      });
    }) as unknown as typeof fetch;
    const embedder = openRouterEmbedder('sk-or-test', 'https://router.example/api/v1/', fetchImpl);

    expect(embedder.model).toBe('voyageai/voyage-code-4');
    expect(await embedder.embed(['first', 'second'], 'document', signal)).toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(requests[0]!.url).toBe('https://router.example/api/v1/embeddings');
    expect((requests[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer sk-or-test');
    expect(JSON.parse(requests[0]!.init.body as string)).toEqual({
      model: 'voyageai/voyage-code-4',
      input: ['first', 'second'],
      input_type: 'document',
      encoding_format: 'float',
    });
  });

  it("reports OpenRouter's error without the key", async () => {
    const fetchImpl = (async () =>
      respond(401, { error: { message: 'No auth credentials found' } })) as unknown as typeof fetch;
    const failure = openRouterEmbedder('sk-or-secret', undefined, fetchImpl).embed(['x'], 'query', signal);
    await expect(failure).rejects.toThrow('OpenRouter embeddings request failed (401): No auth credentials found');
    await expect(failure).rejects.not.toThrow(/sk-or-secret/);
  });

  it('fails when a successful response has no embeddings', async () => {
    const fetchImpl = (async () =>
      respond(200, { error: { message: 'Model is warming up' } })) as unknown as typeof fetch;
    await expect(openRouterEmbedder('k', undefined, fetchImpl).embed(['x'], 'query', signal)).rejects.toThrow(
      'OpenRouter embeddings request failed (200): Model is warming up',
    );
  });
});
