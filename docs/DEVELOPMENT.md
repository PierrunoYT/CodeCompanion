# Development Guide

## Setup

Requirements: Node.js 20.19+ or 22.12+, Git.

```bash
npm install
npm run dev        # hot-reloading renderer, rebuilds main/preload on change
```

npm 11 runs dependency install scripts only for packages listed under `allowScripts` in `package.json` (`electron`, `esbuild`). If `node_modules/electron/dist` is missing after installing, run `node node_modules/electron/install.js`.

`node-pty` ships prebuilt binaries for Windows and macOS (x64 and arm64), so no compiler is needed there. On Linux it compiles from source; see the [node-pty prerequisites](https://github.com/microsoft/node-pty#dependencies).

### Amp orbs

`.agents/setup` prepares Debian-based Amp orbs with native build tools, Electron libraries, Xvfb and locked npm dependencies. It uses the orb's Node.js toolchain (Node 22.12+, 24.x or 26+, as required by Vitest 5), ensures the Electron binary is downloaded and checks `node-pty` loads. No API keys or backing services are needed for tests.

Amp snapshots the prepared environment. When setup runs again on a stale snapshot, it skips apt for installed packages and reuses `node_modules` when the package files, setup script, Node/npm versions and platform match. Changed inputs trigger `npm ci`; deleting `node_modules/.amp-setup-fingerprint` forces a reinstall. `.agents/resume` only checks dependency readiness, without installing anything or authenticating services.

```bash
.agents/setup             # also repairs missing dependencies
npm run typecheck
xvfb-run -a npm test       # unit tests, build and headless Electron tests
```

Both lifecycle scripts must be executable. They become available to future project orbs after reaching the project's default branch; a local commit alone does not activate them. No persistent server or shell-profile changes are required.

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Development mode |
| `npm start` | Build and run the production build |
| `npm run build` | Build main, preload and renderer into `out/` |
| `npm run typecheck` | Type-check the Node side (`tsconfig.node.json`) and the renderer (`tsconfig.web.json`) |
| `npm test` | Unit tests, then build + end-to-end tests |
| `npm run test:unit` / `npm run test:e2e` | One of the two |
| `npm run pack` | Unpacked app in `dist/` |
| `npm run dist` | Installer (NSIS on Windows, DMG on macOS) |

Set `E2E_SCREENSHOTS=<folder>` when running the end-to-end tests to save screenshots of the main screens.

Project-store tests use a fixed clock to cover equal-timestamp opens and reopening existing folders; newest-open ordering must survive reload without synthesizing future timestamps.

`pack` and `dist` first run `scripts/ensure-closed.mjs`. On Windows, electron-builder cannot replace `dist/win-unpacked` while an app started from it is running, so the script stops with "Close CodeCompanion first" instead of an `EBUSY` error. An installed copy (outside `dist/`) does not matter.

Packaging does not rebuild native modules (`npmRebuild: false`) because `node-pty`'s prebuilt binaries work across Electron versions. macOS signing and notarization use electron-builder's standard environment variables (`CSC_LINK`, `APPLE_ID`, …).

## Continuous integration

`.github/workflows/ci.yml` runs on every push to `main` and every pull request, on `windows-latest`, `ubuntu-latest` and `macos-latest` with Node 22: `npm ci`, `npm run typecheck`, `npm run test:unit` and `npm run test:e2e` (under `xvfb-run` on Linux). Run the same commands locally before pushing. Windows is the only supported platform. The Linux and macOS jobs are `continue-on-error` and their failures are not being fixed for now (see `TASKS.md`).

`.github/workflows/release.yml` runs when a tag such as `v0.1.0` is pushed. It checks that the tag matches the `package.json` version, runs the same checks as CI, builds the Windows installer with `electron-builder` and creates a GitHub release with `CodeCompanion-Installer.exe` attached. The release notes are the matching `## [x.y.z]` section of `CHANGELOG.md` plus a link to the full file at that tag; the run fails if the section is missing. To release: add the `## [x.y.z] - date` section to `CHANGELOG.md`, update the version, commit, then `git tag v0.1.0` and `git push origin v0.1.0`.

## Where to change things

| Goal | File |
|---|---|
| Add or rename a model, change defaults | `src/shared/models.ts` |
| Change model prices used for the cost estimate | `MODEL_PRICING` in `src/shared/models.ts` |
| Enable a Claude API feature for a model | `claudeCapabilities` in `src/shared/models.ts`, request building in `src/main/llm/anthropic.ts` |
| Change the system prompt | `src/main/agent/system_prompt.ts` |
| Add a tool | New `defineTool(...)` in `src/main/tools/`, register in `registry.ts` |
| Add a setting | `Settings` + `DEFAULT_SETTINGS` in `src/shared/settings.ts`, validation in `src/main/settings.ts`, field in `src/renderer/src/views/dialogs.ts` |
| Add an IPC channel | `InvokeApi`/`EventMap` **and** `INVOKE`/`EVENTS` in `src/shared/ipc.ts`, handler in `src/main/index.ts` |
| Add a chat event | `ChatEvent` + `applyChatEvent` in `src/shared/chat.ts` |
| UI | `src/renderer/src/app.ts`, `views/`, `styles.css` |

## Conventions

- TypeScript strict mode; Prettier (`.prettierrc`: 120 columns, single quotes).
- Renderer code builds DOM with `h()` (`src/renderer/src/dom.ts`), which inserts text safely. Use `trustedHtml` only for HTML that went through `renderMarkdown`/`renderDiff` (DOMPurify).
- Never pass API keys or unsanitized model output to the renderer as HTML.
- Keep the Claude conversation history append-only; add new request features through `claudeCapabilities` so models that do not support them keep working.
- Unit tests live next to the code (`*.test.ts`); user-visible behavior gets an end-to-end test in `tests/e2e/`.

## Debugging

- **View → Toggle Developer Tools** for the renderer; the main process logs to the terminal that launched the app.
- `CODECOMPANION_USER_DATA=<folder>` starts with a clean profile.
