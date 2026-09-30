# AGENTS.md

Guidance for AI coding agents working on Patch, an Electron + TypeScript desktop coding assistant. Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) before larger changes.

## Commands

```bash
npm install
npm run dev          # development mode
npm run typecheck    # node + renderer type checks
npm run format       # Prettier; CI runs npm run format:check
npm run lint         # ESLint (eslint.config.mjs); CI runs it too
npm run test:unit    # Vitest unit tests
npm test             # unit tests, then build + Playwright end-to-end tests
npm run build        # output in out/
npm run pack         # unpacked app in dist/
```

Run `npm run format`, `npm run lint`, `npm run typecheck` and `npm run test:unit` before finishing a change. Run `npm test` for user-visible changes.

## Layout

- `src/main/` — main process: agent loop (`agent/`), providers (`llm/`), tools (`tools/`), panels (`panels/`), storage, IPC handlers.
- `src/preload/` — the typed bridge exposed to the UI.
- `src/renderer/` — sandboxed UI, no Node.js access.
- `src/shared/` — types and logic used by both sides (IPC contract, models, settings, chat events).
- `tests/e2e/` — end-to-end tests against a mock Claude API. Unit tests sit next to the code as `*.test.ts`.

`docs/DEVELOPMENT.md` has a "Where to change things" table (models, tools, settings, IPC channels, chat events).

## Workflow (always)

After every change, fix or feature:

1. Update the docs the change affects: `README.md`, `docs/` and `CHANGELOG.md`. Open work is tracked in [GitHub issues](https://github.com/PierrunoYT/patch/issues), not in a file: reference the issue a change fixes (`Fixes #n` in the commit message closes it), and open an issue for follow-up work you leave undone (`gh issue list` first, to avoid duplicates).
2. Run `npm run format`, `npm run lint`, `npm run typecheck` and `npm run test:unit` (and `npm test` for user-visible changes).
3. Make a commit for that change, with a Conventional Commit message. One change per commit; don't batch unrelated work.
4. Push to `main` only. Don't create or push other branches, and don't open pull requests.

Don't leave a finished change uncommitted or its docs stale.

## Rules

- Renderer code builds DOM with `h()`; use `trustedHtml` only for output of `renderMarkdown`/`renderDiff`. Never send API keys or unsanitized model output to the renderer.
- Adding an IPC channel means editing **both** the type maps and the `INVOKE`/`EVENTS` lists in `src/shared/ipc.ts`, plus the handler in `src/main/index.ts`.
- Tools use `defineTool` and are registered in `src/main/tools/registry.ts`. Anything that changes files or runs commands must set `requiresApproval`.
- File access must go through `Workspace.resolve`, which confines paths to the project root.
- Keep the Claude conversation history append-only. Gate new request features behind `claudeCapabilities` in `src/shared/models.ts`. Compacting a chat never edits or removes stored messages: it stores a `CompactionState` and changes only what is sent. A new provider needs `planCompaction`/`applyCompaction` with a safe-cut rule that never separates a tool call from its result.
- Model ids and defaults live only in `src/shared/models.ts`.
- Don't add telemetry, analytics or update checks; the app deliberately has none. Local logs are fine (`appLog` in `src/main/app_log.ts`, files in `userData/logs`): log names, codes and numbers, never chat text, file contents or keys, and never send a log anywhere.
- Conversations record an assistant turn only after the request succeeded, and provider clients for chat turns use `maxRetries: 0`: the agent loop retries transient errors itself (`src/main/agent/retry.ts`) so each retry is shown in the chat. Keep both true.

## Style

- TypeScript strict mode, Prettier (2 spaces, 120 columns, single quotes). Match the surrounding code.
- Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`).
- Add unit tests for new logic. When behavior changes, update `README.md`, `docs/` and `CHANGELOG.md`.

## Gotchas

- `dist/`, `out/` and `node_modules/` are git-ignored; don't commit them.
- `node-pty` is a native module: packaging uses its prebuilds (`npmRebuild: false`) and it is unpacked from the asar.
- If `node_modules/electron/dist` is missing after install, run `node node_modules/electron/install.js`.
- `PATCH_USER_DATA=<folder>` starts the app with a clean profile.
