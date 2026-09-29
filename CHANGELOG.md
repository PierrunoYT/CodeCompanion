# Changelog

All notable changes to this fork. Based on CodeCompanion.AI 6.1.1.

## [0.1.0] - 2026-09-29

First release of the from-scratch TypeScript codebase (version numbering restarts at 0.1.0; the 6.x line is the old app). No code from 6.x remains; features were rebuilt on a new architecture. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Fixed
- Tools that become available while a chat is open (for example `search_code` after saving an OpenAI key) are now offered on the next turn; before, the chat had to be restarted.

- The terminal panel no longer asks the main process for a shell when no project is open, which logged an error at startup; it shows "Open a project to use the terminal." instead.

### Architecture
- TypeScript, electron-vite, Electron 44.
- All file, shell, network and API work runs in the main process. The UI runs sandboxed without Node.js access and talks to the main process through a typed, allow-listed IPC contract.
- Unit tests (Vitest) and end-to-end tests (Playwright driving the built app against a mock Claude API).

### Added
- Approval cards show a diff or the exact command, with **Approve** / **Decline**. Declining with a note sends it to the assistant so it can adjust.
- **Auto** / **Ask first** toggle in the header.
- Adaptive thinking with a configurable **Effort** setting, shown as collapsible "Thinking" in the chat (current Claude models).
- Server-side compaction for long chats and the default refusal fallback (current Claude models).
- `grep`, `list_directory`, `fetch_url` and `command_output` tools; background commands for dev servers.
- Browser tool results include HTTP status and page title; the browser panel comes to the front when the assistant uses it.
- Git panel: discard per file, repository init, diffs for new files.
- Chats save automatically; any model id can be entered in settings.
- Paste images into the message box.
- Token usage (including cached tokens) in the status bar.

### Changed
- Default model is Claude Opus 5.5; background tasks use Claude Haiku 4.5 (or GPT-6 Luna with only an OpenAI key).
- OpenAI models are GPT-6 Astra, Sol and Luna, used through the Responses API with reasoning (Effort setting) and encrypted reasoning carried across tool calls. Custom OpenAI-compatible endpoints keep using Chat Completions.
- File edits use exact string replacement (`edit_file`) instead of line ranges, which broke when earlier edits shifted lines.
- Chat history is sent in each provider's native format instead of one rebuilt prompt with summaries and file contents; files are read through tools.
- Code search uses an incremental index with `text-embedding-3-small` (LangChain removed). The index is built on the first search, not when a project opens.
- Agent commands run in a fresh shell per call with a timeout, separate from the interactive terminal; stopping kills the whole process tree.
- A chat is tied to one project; switching projects starts a new chat.
- Web search calls the Google Custom Search API directly and returns results for the assistant to fetch, instead of summarizing pages with a second model.

### Security
- API keys are encrypted with the OS keychain (Electron `safeStorage`) and never reach the UI.
- File tools are confined to the project folder (symlinks resolved) and must read a file before changing it.
- Model output is sanitized (DOMPurify); images, embeds and forms are stripped from it. Strict content security policy.
- The app window cannot navigate away; links open in the system browser. Browser-panel pages have no Node access.

### Removed
- Telemetry (Sentry, Aptabase), the auto-updater and the upstream release pipeline (S3 publish, AppVeyor, notarize script, upstream links).
- The separate "planning" mode; the assistant plans as part of its normal work.
- Manual "Save chat" (chats are saved automatically) and "Download chat logs".

### Known issues
- The OpenAI paths are covered by unit tests against a mock server, not by end-to-end tests.
- No end-to-end run against the live Claude or OpenAI APIs has been done yet.
- On Linux, `node-pty` compiles from source and needs build tools.

## [6.1.1-fork] - 2026-09-29

Changes made to the 6.x JavaScript app before the rewrite.

### Changed
- Claude models updated to Sonnet 5.5, Opus 5.5 and Haiku 4.5.
- `node-pty` 1.0 → 1.1 (prebuilt binaries), `openai` 4 → 7, `@anthropic-ai/sdk` 0.24 → 0.129.

### Fixed
- `approvalRequired` key typo in two tool definitions; Windows platform check (`win64` → `win32`).
- Implicit globals replaced by explicit imports; approval polling replaced with a Promise.
- Model output rendered without sanitization; inline handlers replaced with delegated actions.

### Removed
- Sentry, Aptabase, the auto-updater and the upstream release pipeline.
