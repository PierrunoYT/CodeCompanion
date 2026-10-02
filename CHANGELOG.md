# Changelog

All notable changes to Patch will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Patch's changes are consolidated below as an unreleased baseline, not published versions.

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
- Prettier formatting for the whole repository (`npm run format`, `npm run format:check`), enforced by a `format` job in CI.
- ESLint with the typescript-eslint recommended rules (`eslint.config.mjs`, `npm run lint`), enforced by a `lint` job in CI. Renderer code may not use Node globals such as `process` or `require`. Test files, the end-to-end harness, performance measurements and mock servers may use `any`; production sources may not.
- Stricter TypeScript checks (`noUncheckedIndexedAccess`, `noImplicitOverride`, `noUnusedParameters`, `forceConsistentCasingInFileNames`) in both tsconfigs, and a declared minimum Node version (`engines.node` `>=22.12.0`).
- A task interrupted by a crash can be resumed: the conversation is checkpointed when a run starts and after every tool batch, a run in progress is saved as resumable, and on load such a chat offers Resume, which repairs the history with synthetic failed results for any unanswered tool calls and continues. This includes a crash during a model request, or just after the model asked for tools but before they were saved.
- End-to-end tests that kill the app (SIGKILL) while a tool waits for approval and while an answer streams, then reopen the profile and resume (`tests/e2e/crash_kill.test.ts`), so the checkpoint and debounced save are checked against real files and app-made tool row ids.
- Model Context Protocol (MCP) client support: configure servers in Settings as JSON (stdio child processes or Streamable HTTP endpoints). Their tools are offered to the agent namespaced as `mcp_<server>_<tool>` and always ask for approval, including in Auto mode. Per-server connection status is shown in the dialog. A server's environment variables and HTTP headers are encrypted at rest and never sent to the renderer, and a server that fails to connect, or the app quitting, closes its process tree instead of leaving it running.
- Plan mode (Settings, "Propose a plan before multi-step changes"): the agent calls `propose_plan` and the plan appears as an approval card with rendered markdown, including in Auto mode. Approving lets the work begin; declining with a note sends the feedback back to the model, and declining with nothing stops the task. Other calls sent in the same response are not run; the model has to call them again once the plan is decided. The header also has a **Plan** switch for it.
- A `task` tool that delegates research to a read-only subagent: a nested agent with its own context window, on the chat's own model, that can read files, list directories, grep and use semantic code search, but cannot edit, run commands or use the web. Its answer comes back as the tool result, its progress streams into the parent chat, and its token usage is counted in the chat. A file it reads does not count as read by the parent, so the parent still has to read a file before editing it. An unfinished run (turn cap, full context, stopped) comes back as an error instead of a partial answer.
- Project skills: markdown files in `.patch/skills/` are listed (name plus first-line description) in the system prompt when a chat starts, and loaded on demand through the new `load_skill` tool, keeping the prompt prefix small and cacheable. The folder is read through the project's path confinement, so a skills folder linked outside the project is ignored.
- Linux and macOS installers are built in CI and attached to releases alongside the Windows installer. They are experimental and have not been tested by hand. On Linux, `node-pty` is compiled for Electron before packaging, since it ships no Linux prebuild. The macOS app is not code-signed, so macOS may report it as damaged after download; `xattr -cr /Applications/Patch.app` clears the quarantine flag, but whether the unsigned app launches is not yet confirmed. A failed Linux or macOS build leaves its packages out of the release but does not block the Windows installer.
- A mutation test for the security-sensitive code (`npm run mutate`): 26 deliberate bugs across command allow-listing, path confinement, `file://` confinement, skills, MCP config and the IPC sender check. The first run caught 20; new tests for `;` after an argument, the project's parent folder, another drive, browser `file://` URLs and linked skill entries bring it to 26 of 26.
- Claude Code GitHub workflows: `@claude` mentions in issues and pull requests, and an automatic review of pull requests from branches in this repository (fork pull requests are skipped). Both need the `CLAUDE_CODE_OAUTH_TOKEN` repository secret.

### Changed

- Redesign the workspace with an OpenCode Desktop-inspired neutral palette in both themes, project navigation and New Chat at the top of the sidebar, a sidebar toggle, session breadcrumbs, a centered transcript, quieter tool cards, and a rounded prompt with model, approval and plan controls plus keyboard hints.
- The assistant changes files only with its edit tools, not with shell commands, so every change shows a diff, can be approved and can be undone. Before, it sometimes rewrote several files with a PowerShell or `sed` command (#45).
- Redesign the interface around the Patch brand: charcoal surfaces and the mint logo color in both themes, a logo mark and quiet icon buttons in the header, project tabs, a single rounded composer box with the send button inside, card-style tool calls, a centered welcome screen with tip cards, and restyled dialogs, code blocks and scrollbars. Text still meets WCAG AA contrast in both themes.
- Rebuild the main window to a Google Stitch design: a 40px header with the brand, project tabs, a model picker for new chats, an **Ask** / **Auto-Approve** switch, a **Plan Mode** switch and icon actions (Compact, Export, Send feedback, Chat history, side panel, project menu, Settings); a **Sessions** chat list with the totals of all chats, chats grouped by day with project, age and cost, a filter that also searches message text, **New Chat** with its shortcut, and the `AGENTS.md` and index state at its foot; chat rows with avatars; tool rows with the tool name, target, result chip and duration; approval cards with a header bar, `+n −m` line counts and **Pending Approval**, and command cards with **Skip** and **Approve & Run**; a composer with `@` file mentions as chips and a token estimate; a resizable side panel whose Git tab has a change-count badge, per-file line counts, **Discard All**, a hunk-by-hunk diff preview, **Generate** for commit messages, **Commit & Push** and a sync footer with the app version; and a status bar with the branch, `AGENTS.md`, the model, the context against the model's context window (`48k / 1M`), the index state, tokens and cost. Inter, JetBrains Mono and Material Symbols are bundled with the app (`@fontsource-variable`), since the page loads no remote fonts (#56, #57, #58, #59, #60, #61).
- Use Patch throughout the application, documentation and tooling, including the `patch` package and installer ID, default `Patch` profile directory, and `PATCH_*` environment variables. Repository and contribution links use `PierrunoYT/patch`. Previous environment-variable names are no longer recognized; profiles are not migrated automatically. Set `PATCH_USER_DATA` to an existing profile folder to reuse it. Installations with a different application ID are not upgraded in place.
- New Patch logo: a mint prompt chevron and square cursor on charcoal (`assets/logo-icon.svg`), with a horizontal wordmark lockup in `assets/logo.svg`. The header, welcome screen, favicon and all native icons use it.
- `npm run pack` and `npm run dist` empty `dist/` before building and no longer write auto-update metadata (`latest.yml`, `.blockmap`), which Patch does not use. The installer is smaller as a result.
- Use the Patch logo from `assets/logo-icon.svg` for the app window, favicon, Windows executable, installer and uninstaller, and macOS icon. Regenerate native assets with `npm run icons`.
- Replace the former JavaScript application with an Electron and TypeScript implementation using an isolated main process, sandboxed renderer and typed IPC.
- Improve long-chat rendering with batched streaming updates, deferred off-screen layout and lazily rendered tool output; explicitly identify truncated previews and exports.
- Preserve provider-native conversation history and shorten only outgoing requests during compaction or context trimming.
- Keep local `pack` and `dist` builds non-publishing, even when CI environment variables are present; publishing remains explicit in the release workflow.

- Crash-resume checkpoints after a tool batch write only the chat file. They no longer rewrite the chat index or broadcast `history:changed` (a chat not yet in the index is still indexed); the index updates on the regular saves ([#17](https://github.com/PierrunoYT/patch/issues/17)).

### Removed

- Telemetry, analytics, automatic update checks and the upstream publishing pipeline.
- The former JavaScript app's separate planning mode and manual chat saving; Plan mode now works within the conversation, and chats save automatically.

### Fixed

- Keep the composer's paperclip beside the model, approval and plan controls instead of reserving a separate full-width row; attachment chips use a row only when present.
- A project inside a repository rooted at the home folder or above it (for example from an accidental `git init` there) made every Git refresh run `git status` over the whole user profile, starting git processes of up to 1 GB each. The Git panel now treats such a project as not a repository, and the end-to-end tests stop git from looking above the temp folder.
- Streaming an answer at the bottom of a very long chat is smooth again: the transcript groups its items into chunks of 50 that the browser skips while off screen, so a 5,000-item chat streams at the same 7 ms median frame as an empty one, instead of 21–28 ms. The performance benchmark now also checks that the view is following the answer (#19).
- Starting Patch a second time on the same profile brings the open window forward instead of running a second instance, which overwrote the first one's settings, projects and chat index (#31).
- Closing, removing or editing a project whose path was given through a link (such as macOS's `/var` for `/private/var`) no longer fails with "Unknown project": `ProjectStore` looks every path up by its real path, like opening already did. A project whose folder later becomes a link elsewhere can still be closed and removed.
- Prevent commands from starting after Stop, cancel foreground and active-project background process trees (including startup waits), and avoid hangs when child processes retain output pipes. Other projects' background jobs remain independent.
- Serialize Undo against sending, resuming, compaction and project switching; use application-generated tool-card IDs to prevent collisions from reused provider IDs.
- Keep failed or cancelled Anthropic continuation responses out of saved history and retry transient failures reported inside streams.
- Remove SDK-only fields from OpenAI request history and preserve valid reasoning and tool-call/result boundaries during trimming and compaction.
- Do not execute Chat Completions tool calls when a response ends at an output limit or is content-filtered; preserve paired results in conversation history.
- Report the final Claude request's context size separately from billable usage summed across continuation requests.
- Use the pinned chat model for custom-endpoint titles and compaction rather than assuming GPT-6 Luna is available. JSON-schema structured-output support is still required.
- Prevent deleted chats from being restored by late title responses or other callbacks from forgotten sessions; refuse deletion during Undo, and avoid offering Resume when a run has already completed.
- Preserve complete large-file reads with line pagination and `char_offset` continuation for overlong lines, without splitting Unicode surrogate pairs; reject edits to files that have not been read.
- Keep long transcripts and approval controls in view, preserve keyboard focus across updates, and handle blocked or oversized image attachments consistently.
- Avoid terminal startup without a project and Windows console-helper crashes when closing project tabs.
- Correct long-context and cached-token cost accounting, recent-project ordering and approval-button contrast.
- Restore both paths when discarding staged Git renames, including staged and unstaged edits, and include staged additions in diffs before the first commit.
- Correct documentation for persisted Undo notifications, the welcome-screen location of Remove from recent, and measured long-chat performance.

### Security

- Enforce the browser guest's `persist:browser` partition in the main process, rejecting omitted and different partitions before attachment so a compromised renderer cannot share the app's default session (#34).
- Update Electron from 44.4.5 to 44.5.1, incorporating upstream ANGLE, Chromium, Dawn and V8 fixes (#33). Existing installations need a rebuilt installer because Patch has no automatic updates.
- Switching to Auto mode (once per app session), changing the editor command, and adding or changing an MCP server that runs a program now ask for confirmation in a native dialog shown by the main process, so a compromised UI can't apply them silently (#29).

- The macOS app and helpers grant only `allow-jit`, removing both `allow-dyld-environment-variables` (library injection through `DYLD_INSERT_LIBRARIES`) and `allow-unsigned-executable-memory` (unrestricted executable memory). Signed packaged launches on Intel and Apple Silicon still need manual verification (#28, #22).
- Windows releases require signing credentials, force code signing and verify valid Authenticode signatures on both the app and installer before publishing. Missing credentials or invalid signatures stop the release; local development packaging can still be unsigned. Releases include `SHA256SUMS.txt` and the installer's SHA-256 in the release notes. Signing credentials still need provisioning (#26).
- IPC handlers only answer calls from the app page's top frame (the built page, or the dev server during development), so no other frame or page can use them (#30).
- A packaged app ignores `ELECTRON_RENDERER_URL`, which `npm run dev` uses to load the page from the dev server. Before, setting it when starting Patch loaded any page with the app's full IPC access (#27).
- The packaged app sets Electron's fuses: it ignores `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and `--inspect` flags, loads its code only from `app.asar`, validates the archive's integrity (a modified archive stops the app), and encrypts browser-panel cookies on disk (#25).
- The Git panel no longer runs commands named in a repository's own `.git/config`: `core.fsmonitor` is disabled, filter drivers the repository defines locally are neutralized, and diffs skip external diff programs and textconv. Before, opening the Git tab on a folder from an untrusted source could run a command (#24).
- Confine file access to the workspace, including symlinked paths and new files, ignore external or dangling `.gitignore`/`.ccignore` links, and block browser access to files outside the project.
- Require approval for shell expressions that could bypass command-prefix allow-lists and reject unsafe file names passed to external editor commands.
- Check agent-initiated network navigation against approved hosts, block cross-host redirects and browser popups, and deny browser permission requests.
- Strip inline style attributes as well as style elements from model Markdown, while preserving trusted syntax-highlighting classes; enforce a content security policy and keep Node.js and API keys out of the renderer.
- Migrate plaintext API keys when system encryption becomes available and report their actual storage status. Failed migration preserves usable keys and the plaintext warning. Redact recognized keys and tokens from local logs, including Groq and xAI keys.

[Unreleased]: https://github.com/PierrunoYT/patch/tree/main
