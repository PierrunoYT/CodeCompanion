// Mutation test for the security-sensitive code: `npm run mutate`.
//
// Each mutant below is a small, deliberate bug in a file that guards a security boundary (which commands skip
// approval, path confinement, preapproved file:// URLs, project skills, MCP config and secrets, the IPC sender
// check). The script applies one mutant at a time, runs the unit tests that should catch it, and restores the file.
// A mutant that survives means the tests would not notice that bug: add a test for it.
//
// Not part of `npm test` or CI: it runs the listed tests once per mutant, which takes a few minutes. The source is
// restored after every mutant, also when the run is interrupted. A mutant whose text no longer matches the source
// is reported as "stale" and must be updated.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

const MUTANTS = [
  // Commands allowed without asking (src/main/agent/allowed_commands.ts).
  ...[
    ['no `;` in shell operators', '/[;&|`<>\\r\\n$(){}]/', '/[&|`<>\\r\\n$(){}]/'],
    ['no `|` in shell operators', '/[;&|`<>\\r\\n$(){}]/', '/[;&`<>\\r\\n$(){}]/'],
    ['no `$` in shell operators', '/[;&|`<>\\r\\n$(){}]/', '/[;&|`<>\\r\\n(){}]/'],
    ['no parentheses in shell operators', '/[;&|`<>\\r\\n$(){}]/', '/[;&|`<>\\r\\n${}]/'],
    ['no braces in shell operators', '/[;&|`<>\\r\\n$(){}]/', '/[;&|`<>\\r\\n$()]/'],
    ['no line breaks in shell operators', '/[;&|`<>\\r\\n$(){}]/', '/[;&|`<>$(){}]/'],
    ['no backtick in shell operators', '/[;&|`<>\\r\\n$(){}]/', '/[;&|<>\\r\\n$(){}]/'],
    [
      'operators checked after whitespace is normalized',
      'SHELL_OPERATORS.test(command)',
      'SHELL_OPERATORS.test(normalized)',
    ],
    ['prefix match without the space', 'normalized.startsWith(`${entry} `)', 'normalized.startsWith(entry)'],
    ['comment lines become entries', ".filter((line) => line && !line.startsWith('#'));", '.filter((line) => line);'],
  ].map(([name, from, to]) => ({
    file: 'src/main/agent/allowed_commands.ts',
    tests: ['src/main/agent/allowed_commands.test.ts'],
    name,
    from,
    to,
  })),

  // Path confinement (src/main/tools/workspace.ts).
  ...[
    ["the root's parent is allowed", "rel === '..' || ", ''],
    ['`../x` is allowed', 'rel.startsWith(`..${sep}`) || ', ''],
    ['another drive or root is allowed', ' || isAbsolute(rel)', ''],
    ['links are not followed', 'const real = realPathAllowingMissing(target);', 'const real = target;'],
    [
      'a new file under a folder link is not resolved',
      'return missing.length > 0 ? join(real, ...missing) : real;',
      'return missing.length > 0 ? target : real;',
    ],
  ].map(([name, from, to]) => ({
    file: 'src/main/tools/workspace.ts',
    tests: ['src/main/tools/tools.test.ts', 'src/main/tools/skills.test.ts'],
    name,
    from,
    to,
  })),

  // file:// URLs the browser tool may open (src/main/tools/browser.ts).
  ...[
    ['file:// URLs are not confined', 'const inside = workspace.resolve(path);', 'const inside = path;'],
    [
      'an upper-case FILE: scheme skips the check',
      'if (!/^file:/i.test(url)) return url;',
      'if (!/^file:/.test(url)) return url;',
    ],
  ].map(([name, from, to]) => ({
    file: 'src/main/tools/browser.ts',
    tests: ['src/main/tools/browser_tool.test.ts'],
    name,
    from,
    to,
  })),

  // Project skills (src/main/tools/skills.ts).
  ...[
    ['any skill name is accepted', '/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/', '/^.+$/'],
    [
      'the skills folder is not confined',
      'const dir = workspace.resolve(SKILLS_DIR);',
      'const dir = join(workspace.root, SKILLS_DIR);',
    ],
    ['linked entries are listed', "entry.isFile() && entry.name.endsWith('.md')", "entry.name.endsWith('.md')"],
  ].map(([name, from, to]) => ({
    file: 'src/main/tools/skills.ts',
    tests: ['src/main/tools/skills.test.ts'],
    name,
    from,
    to,
  })),

  // MCP server config (src/shared/settings.ts) and its secrets (src/main/settings.ts).
  ...[
    ['duplicate server names are accepted', 'if (names.has(name)) throw', 'if (false) throw'],
    ['http servers may use any URL', '!/^https?:\\/\\//.test(server.url)', 'false'],
    ['stdio servers need no command', "server.transport === 'stdio' && typeof server.command !== 'string'", 'false'],
  ].map(([name, from, to]) => ({
    file: 'src/shared/settings.ts',
    tests: ['src/shared/settings.test.ts'],
    name,
    from,
    to,
  })),
  {
    file: 'src/main/settings.ts',
    tests: ['src/main/settings.test.ts'],
    name: 'MCP env and headers are saved in settings.json',
    from: 'next.mcpServers = next.mcpServers.map(({ env: _env, headers: _headers, ...server }) => server);',
    to: '',
  },

  // The IPC sender check (src/main/renderer_url.ts).
  ...[
    ['any file:// page counts as the app page', "parsed.pathname.endsWith('/renderer/index.html')", 'true'],
    ['a packaged app uses the dev server URL', 'if (isPackaged) return null;', ''],
  ].map(([name, from, to]) => ({
    file: 'src/main/renderer_url.ts',
    tests: ['src/main/renderer_url.test.ts'],
    name,
    from,
    to,
  })),
];

// Files currently mutated, restored on exit even when interrupted.
const originals = new Map();
const restoreAll = () => {
  for (const [path, text] of originals) writeFileSync(path, text);
  originals.clear();
};
process.on('SIGINT', () => {
  restoreAll();
  process.exit(130);
});

function runTests(tests) {
  const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--project', 'unit', ...tests], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 300_000,
    windowsHide: true,
  });
  return result.status === 0;
}

const only = process.argv[2];
const selected = MUTANTS.filter((candidate) => !only || candidate.file.includes(only));

// A mutant only counts as caught if its tests exist and pass on the unchanged source; otherwise a failing or missing
// test file would look like a catch.
const baseline = new Map();
for (const tests of new Set(selected.map((mutant) => mutant.tests.join(' ')))) {
  const files = tests.split(' ');
  const missing = files.filter((file) => !existsSync(join(ROOT, file)));
  baseline.set(tests, missing.length > 0 ? `missing ${missing.join(', ')}` : runTests(files) ? 'ok' : 'failing');
}

const results = [];
for (const mutant of selected) {
  const path = join(ROOT, mutant.file);
  const text = readFileSync(path, 'utf8');
  const state = baseline.get(mutant.tests.join(' '));
  if (state !== 'ok') {
    results.push({ ...mutant, outcome: 'no tests', why: state });
    console.log(`NO TESTS ${mutant.file}: ${mutant.name} (${state})`);
    continue;
  }
  if (!text.includes(mutant.from)) {
    results.push({ ...mutant, outcome: 'stale' });
    continue;
  }
  originals.set(path, text);
  try {
    writeFileSync(path, text.split(mutant.from).join(mutant.to));
    results.push({ ...mutant, outcome: runTests(mutant.tests) ? 'SURVIVED' : 'caught' });
  } finally {
    restoreAll();
  }
  const last = results.at(-1);
  console.log(`${last.outcome.padEnd(8)} ${mutant.file}: ${mutant.name}`);
}

const caught = results.filter((result) => result.outcome === 'caught').length;
const survived = results.filter((result) => result.outcome === 'SURVIVED');
const stale = results.filter((result) => result.outcome === 'stale');
const untested = results.filter((result) => result.outcome === 'no tests');
console.log(`\n${caught} of ${results.length} mutants caught.`);
for (const result of survived) console.log(`  survived: ${result.file}: ${result.name}`);
for (const result of untested) console.log(`  no usable tests (${result.why}): ${result.file}: ${result.name}`);
for (const result of stale) console.log(`  stale (text not found, update the mutant): ${result.file}: ${result.name}`);
process.exit(caught === results.length ? 0 : 1);
