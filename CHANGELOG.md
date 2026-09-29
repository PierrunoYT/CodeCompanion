# Changelog

All notable changes to this fork. Based on CodeCompanion.AI 6.1.1.

## [Unreleased] - 2026-09-29

### Added
- `docs/ARCHITECTURE.md` and `docs/DEVELOPMENT.md`, linked from the README.

### Changed
- Claude models updated to Sonnet 5.5 (default), Opus 5.5 and Haiku 4.5. Haiku 4.5 is now the small model used for background tasks. The 3.5-Sonnet max-tokens beta header was dropped and Claude models get an 8192 max-token limit.
- `node-pty` 1.0 to 1.1, which ships prebuilt binaries. Version 1.0 failed to compile on Windows with Node 24.
- `openai` 4 to 7. Streaming now uses `chat.completions.stream` (the `beta` helper was removed upstream).
- `@anthropic-ai/sdk` 0.24 to 0.129.

### Fixed
- `search` and `task_planning_done` tool definitions used the key `requiresApproval` instead of `approvalRequired`. Behavior is unchanged (neither asks for approval), but the key is now consistent.
- Platform check in `renderer.js` compared against `'win64'`, which never matches. It now uses `'win32'`, so xterm's Windows mode and path separators apply on Windows.

### Removed
- Sentry error reporting and Aptabase usage tracking, including the `new_chat` event. The app no longer sends data to the original authors.
- Auto-updater (`electron-updater`), the "Check for Updates" menu item and the update check on launch.
- Upstream release pipeline: S3 `build.publish` config, `publish` and `set-no-cache` scripts, `appveyor.yml`, `scripts/setNoCache.js`.
- Upstream links in the settings panel (feedback email, website, X, Discord, release notes, privacy, terms).
- Dead config and unused dependencies: `enableRemoteModule`, the unused `isDevelopment` variable, `electron-notarize`, `aws-sdk`.

### Known issues
- LangChain (`langchain` 0.1, `@langchain/openai` 0.0) was not upgraded; it works but is old.
- The renderer still runs with `nodeIntegration: true`, `contextIsolation: false` and `'unsafe-eval'` in the CSP.
- The OpenAI model list and `text-embedding-ada-002` are unchanged from upstream and not re-verified.
- macOS builds still expect Apple notarization credentials (`afterSign` in `package.json`).
- Changes have been checked for syntax and module loading only; no end-to-end run against live model APIs yet.
