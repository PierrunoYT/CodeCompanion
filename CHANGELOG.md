# Changelog

All notable changes to Patch will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Patch continues the from-scratch TypeScript rewrite of CodeCompanion.AI. The previous CodeCompanion releases have been removed; their changes are consolidated below as the unreleased Patch baseline, not published Patch versions.

## [Unreleased]

### Added

- Desktop coding assistant with streaming Claude, OpenAI Responses API and OpenAI-compatible chat, configurable models and reasoning effort.
- Workspace tools for reading, searching and editing files, running foreground and background commands, fetching pages, web search and optional semantic code search.
- Approval cards with command and diff previews, feedback when declining, Ask first and Auto modes, and global and per-project command and network allow-lists.
- Project instructions, automatic loading of project `AGENTS.md` or `CLAUDE.md`, and multiple open projects with separate chats and drafts.
- Persistent chat history with message search, Markdown export, image attachments, token usage and model-price estimates including cache usage.
- Stop and Resume controls, visible retries for transient provider failures, and chat compaction that preserves the saved conversation and tool-call/result pairs.
- Undo for approved file edits, guarded against overwriting subsequent changes, with pending model notifications preserved across restarts.
- Integrated terminal, browser and Git panels, including diffs, commits, discard and repository initialization.
- Local crash and tool-input logs, a log-folder menu action, indexing progress and manual reindexing.
- Keyboard-accessible controls and panel tabs, labelled approval cards, and screen-reader announcements for completed answers, approvals and errors.
- Windows installer packaging, unit and end-to-end coverage, performance benchmarks, and development and usage guides.

### Changed

- Rename the project to Patch and move documentation and contribution links to `PierrunoYT/patch`. Runtime titles, package identifiers, executable names and `CODECOMPANION_*` environment variables still retain the CodeCompanion name.
- Use the Patch logo from `assets/logo-icon.svg` for the app window, favicon, Windows executable, installer and uninstaller, and macOS icon. Regenerate native assets with `npm run icons`.
- Replace the former JavaScript application with an Electron and TypeScript implementation using an isolated main process, sandboxed renderer and typed IPC.
- Improve long-chat rendering with batched streaming updates, deferred off-screen layout and lazily rendered tool output; explicitly identify truncated previews and exports.
- Preserve provider-native conversation history and shorten only outgoing requests during compaction or context trimming.

### Removed

- Telemetry, analytics, automatic update checks and the upstream publishing pipeline.
- Separate planning mode and manual chat saving; planning happens within the conversation and chats save automatically.

### Fixed

- Prevent commands from starting after Stop, terminate command process trees on cancellation, and avoid hangs when child processes retain output pipes.
- Serialize Undo against sending, resuming, compaction and project switching; use application-generated tool-card IDs to prevent collisions from reused provider IDs.
- Keep failed or cancelled Anthropic continuation responses out of saved history and retry transient failures reported inside streams.
- Remove SDK-only fields from OpenAI request history and preserve valid reasoning and tool-call/result boundaries during trimming and compaction.
- Prevent deleted chats from being saved again by open sessions, and avoid offering Resume when a run has already completed.
- Preserve complete large-file reads through line-based pagination and reject edits to files that have not been read.
- Keep long transcripts and approval controls in view, preserve keyboard focus across updates, and handle blocked or oversized image attachments consistently.
- Avoid terminal startup without a project and Windows console-helper crashes when closing project tabs.
- Correct long-context and cached-token cost accounting, recent-project ordering and approval-button contrast.

### Security

- Confine file access to the workspace, including symlinked paths and new files, and block browser access to files outside the project.
- Require approval for shell expressions that could bypass command-prefix allow-lists and reject unsafe file names passed to external editor commands.
- Check agent-initiated network navigation against approved hosts, block cross-host redirects and browser popups, and deny browser permission requests.
- Sanitize rendered model output, enforce a content security policy, and keep Node.js and API keys out of the renderer.
- Encrypt stored API keys with the operating system and redact recognized keys and tokens from local logs, including Groq and xAI keys.

[Unreleased]: https://github.com/PierrunoYT/patch/tree/main
