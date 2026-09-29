import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyEdit, editFileTool, grepTool, listDirectoryTool, readFileTool, writeFileTool } from './files';
import { browserTool } from './browser';
import { availableTools } from './registry';
import { commandOutputTool, runCommandTool, ShellRunner } from './shell';
import { ToolError, truncateOutput, type AgentTool, type ToolContext } from './types';
import { extractArticle } from './web';
import { Workspace } from './workspace';

let root: string;
let context: ToolContext;

function makeContext(): ToolContext {
  const workspace = new Workspace(root);
  return {
    workspace,
    signal: new AbortController().signal,
    readFiles: new Set(),
    shell: new ShellRunner(() => workspace.root),
    browser: null,
    codeSearch: null,
    webSearch: null,
    onProgress: () => {},
  };
}

// Runs a tool the way the agent does: validate the input first.
async function call(tool: AgentTool, input: unknown, ctx = context) {
  return tool.run(tool.schema.parse(input), ctx);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-tools-'));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(root, 'src', 'app.ts'), 'const a = 1;\nconst b = 2;\nexport { a, b };\n');
  writeFileSync(join(root, 'src', 'dist.log'), 'ignored');
  writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'const a = 1;');
  writeFileSync(join(root, '.gitignore'), '*.log\n');
  context = makeContext();
});

afterEach(() => {
  context.shell.stopAll();
  rmSync(root, { recursive: true, force: true });
});

describe('Workspace', () => {
  it('rejects paths outside the project', () => {
    expect(() => context.workspace.resolve('../outside.txt')).toThrow(ToolError);
    expect(() => context.workspace.resolve(join(tmpdir(), 'x.txt'))).toThrow(/outside the project/);
    expect(context.workspace.resolve('src/app.ts')).toBe(join(context.workspace.root, 'src', 'app.ts'));
  });

  it('skips .gitignore matches and node_modules when listing', async () => {
    const files = (await context.workspace.listFiles()).map((file) => context.workspace.relative(file));
    expect(files).toEqual(['.gitignore', 'src/app.ts']);
  });
});

describe('file tools', () => {
  it('reads with line numbers and ranges', async () => {
    const full = await call(readFileTool, { path: 'src/app.ts' });
    expect(full.content).toContain('1\tconst a = 1;');
    const range = await call(readFileTool, { path: 'src/app.ts', offset: 2, limit: 1 });
    expect(range.content.split('\n')[0]).toBe('2\tconst b = 2;');
    expect(range.content).toContain('Showing lines 2-2 of 4');
  });

  it('refuses to edit or overwrite a file that was not read', async () => {
    await expect(call(editFileTool, { path: 'src/app.ts', old_string: 'a = 1', new_string: 'a = 9' })).rejects.toThrow(
      /src\/app.ts has not been read/,
    );
    await expect(call(writeFileTool, { path: 'src/app.ts', content: 'x' })).rejects.toThrow(/has not been read/);
    // Also rejected while building the approval preview, so the user is never asked to approve it.
    await expect(
      editFileTool.preview?.({ path: 'src/app.ts', old_string: 'a = 1', new_string: 'a = 9' }, context),
    ).rejects.toThrow(/has not been read/);
  });

  it('edits after reading and reports a diff', async () => {
    await call(readFileTool, { path: 'src/app.ts' });
    const result = await call(editFileTool, { path: 'src/app.ts', old_string: 'const a = 1;', new_string: 'const a = 10;' });
    expect(readFileSync(join(root, 'src', 'app.ts'), 'utf8')).toContain('const a = 10;');
    expect(result.content).toContain('+const a = 10;');
  });

  it('creates new files and folders without a prior read', async () => {
    await call(writeFileTool, { path: 'lib/new/util.ts', content: 'export {};\n' });
    expect(readFileSync(join(root, 'lib', 'new', 'util.ts'), 'utf8')).toBe('export {};\n');
  });

  it('previews writes as a diff', async () => {
    const preview = await writeFileTool.preview!(writeFileTool.schema.parse({ path: 'new.txt', content: 'hello\n' }), context);
    expect(preview.title).toBe('Create new.txt');
    expect(preview.diff).toContain('+hello');
  });

  it('lists a directory without ignored entries', async () => {
    const result = await call(listDirectoryTool, {});
    expect(result.content.split('\n')).toEqual(['src/', '.gitignore']);
  });

  it('greps across non-ignored files', async () => {
    const result = await call(grepTool, { pattern: 'const a' });
    expect(result.content).toBe('src/app.ts:1: const a = 1;');
  });
});

describe('applyEdit', () => {
  it('requires a unique match unless replace_all is set', () => {
    expect(() => applyEdit('x x', { old_string: 'x', new_string: 'y' })).toThrow(/appears 2 times/);
    expect(applyEdit('x x', { old_string: 'x', new_string: 'y', replace_all: true })).toBe('y y');
  });

  it('reports a missing match', () => {
    expect(() => applyEdit('abc', { old_string: 'zzz', new_string: 'y' })).toThrow(/not found/);
  });

  it('matches LF input against CRLF files and keeps CRLF', () => {
    expect(applyEdit('a\r\nb\r\n', { old_string: 'a\nb', new_string: 'c\nd' })).toBe('c\r\nd\r\n');
  });

  it('does not interpret $ patterns in the replacement', () => {
    expect(applyEdit('price', { old_string: 'price', new_string: '$&$1' })).toBe('$&$1');
  });
});

describe('browser tool', () => {
  const opened: string[] = [];
  const browser = {
    open: async (url: string) => (opened.push(url), { url, title: 'T', status: 200, console: [] }),
    screenshot: async () => '',
  };

  it('opens http pages and files inside the project', async () => {
    opened.length = 0;
    writeFileSync(join(root, 'index.html'), '<p>hi</p>');
    const ctx = { ...context, browser };
    await call(browserTool, { url: 'http://localhost:3000' }, ctx);
    await call(browserTool, { url: pathToFileURL(join(root, 'index.html')).href }, ctx);
    expect(opened[0]).toBe('http://localhost:3000');
    expect(opened[1].toLowerCase()).toContain('index.html');
  });

  it('refuses file URLs outside the project', async () => {
    opened.length = 0;
    const outside = pathToFileURL(join(root, '..', 'secret.txt')).href;
    await expect(call(browserTool, { url: outside }, { ...context, browser })).rejects.toThrow('outside the project');
    expect(opened).toEqual([]);
  });
});

describe('shell tools', () => {
  it('returns output and exit code', async () => {
    const result = await call(runCommandTool, { command: 'echo hello-from-shell' });
    expect(result.content).toContain('Exit code: 0');
    expect(result.content).toContain('hello-from-shell');
    expect(result.isError).toBe(false);
  });

  it('flags non-zero exit codes', async () => {
    const result = await call(runCommandTool, { command: 'exit 3' });
    expect(result.content).toContain('Exit code: 3');
    expect(result.isError).toBe(true);
  });

  it('runs in the project root', async () => {
    const command = process.platform === 'win32' ? '(Get-Location).Path' : 'pwd';
    const result = await call(runCommandTool, { command });
    // The shell may print the long form of a Windows 8.3 short path (RUNNER~1) or the real path of a symlink.
    const output = result.content.toLowerCase();
    const candidates = [context.workspace.root, realpathSync.native(context.workspace.root)];
    expect(candidates.some((path) => output.includes(path.toLowerCase()))).toBe(true);
  });

  it('stops commands that run past the timeout', async () => {
    const shell = new ShellRunner(() => root);
    const command = process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30';
    const started = Date.now();
    const result = await shell.run(command, { timeoutSeconds: 1 });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 20_000);

  it('returns when the command exits even if a leftover child keeps the output pipe open', async () => {
    const shell = new ShellRunner(() => tmpdir());
    const command =
      process.platform === 'win32'
        ? `Start-Process node -ArgumentList '-e','setTimeout(()=>{},20000)' -NoNewWindow; Write-Output finished`
        : 'sleep 20 & echo finished';
    const started = Date.now();
    const result = await shell.run(command, { timeoutSeconds: 60 });
    expect(result.output).toContain('finished');
    expect(result.timedOut).toBe(false);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);

  it('stops commands when the chat is stopped', async () => {
    const controller = new AbortController();
    const command = process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30';
    const pending = context.shell.run(command, { signal: controller.signal });
    setTimeout(() => controller.abort(), 500);
    const result = await pending;
    expect(result.aborted).toBe(true);
  }, 20_000);

  it('starts background commands and reads their output', async () => {
    const command =
      process.platform === 'win32'
        ? 'Write-Output background-ready; Start-Sleep -Seconds 30'
        : 'echo background-ready; sleep 30';
    const started = await call(runCommandTool, { command, background: true });
    expect(started.content).toContain('still running');
    expect(started.content).toContain('background-ready');

    const output = await call(commandOutputTool, { id: 1, stop: true });
    expect(output.content).toContain('Status: stopped');
  }, 20_000);
});

describe('helpers', () => {
  it('truncates the middle of long output', () => {
    const text = 'a'.repeat(100) + 'b'.repeat(100);
    const result = truncateOutput(text, 50);
    expect(result.startsWith('a'.repeat(25))).toBe(true);
    expect(result.endsWith('b'.repeat(25))).toBe(true);
    expect(result).toContain('150 characters omitted');
  });

  it('extracts readable text from HTML', () => {
    const html = `<html><head><title>Docs</title></head><body><nav>menu</nav><article><h1>Install</h1><p>${'Run npm install to set up the project. '.repeat(20)}</p></article></body></html>`;
    const text = extractArticle(html);
    expect(text).toContain('Run npm install');
  });

  it('only offers tools that are configured', () => {
    const names = (ctx: Partial<ToolContext>) =>
      availableTools({ browser: null, codeSearch: null, webSearch: null, ...ctx }).map((tool) => tool.name);
    expect(names({})).not.toContain('web_search');
    expect(names({})).not.toContain('browser');
    expect(names({ webSearch: { googleApiKey: 'k', googleSearchEngineId: 'c' } })).toContain('web_search');
  });
});
