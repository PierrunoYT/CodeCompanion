# Changelog

All notable changes to this fork. Based on CodeCompanion.AI 6.1.1.

## [Unreleased]

### Added
- Per-project allow-lists: **Project settings…** in the project menu (formerly *Project instructions…*) now also has "Commands allowed without asking" and "Network hosts allowed without asking" for that project only. They add to the global lists in Settings, with the same rules, and apply at once to open chats. They are stored in `projects.json` in the app's data folder, not in the project, so a repository cannot allow its own commands. New IPC channel `project:update-settings`.

## [0.2.0] - 2026-09-30

### Security
- The command allow-list ("Commands allowed without asking") could be bypassed on Windows. PowerShell runs `(...)` and `{...}` even inside a program's arguments, so with `npm test` allowed, `npm test (Remove-Item -Recurse src)` ran without an approval card. Commands containing `$`, `(`, `)`, `{` or `}` are now always asked about, as `; & | < >`, backticks and line breaks already were.
- A new file could be written outside the project through a folder link inside it (`link/new.txt` with `link` pointing elsewhere), since only paths that already existed were resolved through links. The deepest existing part of a path is now resolved, and a link that leads nowhere is refused.
- On macOS and Linux, "Open in editor" ran `$(...)` and backticks in a file name, because the shell expands them inside double quotes. Such names are now refused.

### Fixed
- An overloaded or server error sent inside a Claude stream (after a 200 response) was not retried: the retry check read the generic outer `error` type. It now reads the most specific type or code the SDK puts on the error. 501 and 505 are no longer retried, since they mean the server cannot do this at all.
- OpenAI-compatible chats: trimming a long history could send a tool result without the assistant message that called it, which strict servers reject, and a single image counted by its base64 length pushed almost everything else out. Trimming now never starts at a tool result, always keeps the step in progress, and counts images at a small fixed size.
- A refusal that came with tool calls stored the calls without results, so every later request in that chat was rejected. Each call now gets a "Not run" result. Tool calls from a response cut off by a full context window are no longer run, as for the output limit.
- A chat deleted from the history came back when it was open or in another project's tab: it was saved again on the next switch or on quit. Deleting now drops the open session first; deleting the running chat is refused until it is stopped.
- Compact chat on OpenAI could cut between a reasoning item and the message it produced, which the API rejects without server-side storage.
- With `content-visibility`, opening a long chat could land thousands of pixels above its end, and a tall approval card could leave Approve out of view. The view now keeps to the bottom while new items settle, and when the scroll area gets smaller.
- Keyboard focus was lost when a card updated in place, for example after Undo; it now returns to the same control, or to the "Undone" badge. A click on a card could be undone by a streamed re-render.
- Undo while the assistant is working now says why before asking to confirm. A pasted image with text (from Word, Excel or a browser) no longer blocks the text for a model that does not take images, and pasted images over 5 MB are refused like attached ones. The remove button on a blocked image is visible again. The footer's token and cost label no longer jumps left when there is no context size. Thinking is rendered only when opened. Exported chats mark undone edits.
- `read_file` no longer drops the middle of a file over 30,000 characters behind a short "characters omitted" marker. It returns whole lines up to the limit and ends with the lines shown and the offset for the next page, so a large file is read page by page with nothing missing. The transcript card shows the range that was read.
- OpenAI chats (GPT-6 through the Responses API) failed on every request after the first model turn with "400 Unknown parameter: 'input[1].parsed_arguments'". The OpenAI SDK adds `parsed_arguments` and `parsed` to the response it returns, and the app sent them back as history. They are now removed when a turn is stored and when history is sent, which also repairs OpenAI chats saved earlier. Found by running the app against the real API; the mock OpenAI server in the end-to-end tests now rejects these fields too.

### Added
- Faster long chats: in a 5,000-item chat, streaming an answer is now as smooth as in an empty chat (frame p50 42 ms → 7 ms) and opening the chat takes 1.1 s instead of 3.2 s. Off-screen messages skip layout (`content-visibility: auto`), changed messages are updated in place instead of replaced, and finished tool cards build their diff and output when first expanded. `npm run perf` measures it; see `docs/PERFORMANCE.md`.
- Limit very large tool results in the chat and say so. Diffs keep their first 2,000 lines (at most 200,000 characters), commands their first 20,000 characters, and output its last 20,000 characters, as before but no longer silently. An approval card with a shortened diff warns that approving applies the whole change. Exported chats note what was left out. The model's tool results and the applied changes are not affected.
- Gate image attachments behind a new `images` entry in `claudeCapabilities`. All built-in models accept images as before; for an unknown Claude model id the paperclip and paste are disabled and a message with images is refused in the main process with a clear reason, instead of failing with a 400 from the API. OpenAI and OpenAI-compatible model ids are not restricted.
- Show each chat's estimated cost so far in the chat history. The cost is stored in the chat index on every save; older indexes are rebuilt once on start to add it. Saved chats now record whether official prices apply, so a reopened chat keeps that even if the OpenAI base URL setting changed since.
- Add **Undo** to the card of every approved `edit_file`/`write_file` change (IPC `edit:undo`). Before writing, the tools keep the file's exact previous bytes in `edit-backups` in the user data folder (newest 50 edits per chat, removed with the chat). Undo puts them back, or deletes a file the edit created, but only while the file still has exactly the content the edit wrote, so later changes are never lost. It needs the assistant to be idle, tells the model with the next message, and makes it read the file again before editing it. The card then shows "Undone".
- Add a **Compact chat** action (header button, IPC `chat:compact`) that summarizes the older turns with the small model and sends the summary instead of them from then on, for Claude, OpenAI and OpenAI-compatible chats. The history stays append-only: the saved chat keeps every message plus a `compaction` marker, and only the request is shortened. Cuts never separate a tool call from its result. The status bar shows the size of the last prompt ("Context: 96k") and the button turns yellow from 150k tokens. The summarizing request is not counted in the usage totals.
- Add a user guide (`docs/USAGE.md`) covering approvals, the command and network allow-lists, Stop and Resume, retries, chat history and export, the side panel and the log folder.
- Retry transient provider errors (HTTP 408, 429, 5xx including 529, errors sent inside a stream, dropped or timed-out connections) up to 4 times with a 2 to 16 second backoff, or the wait the provider asks for in `Retry-After`. Each retry is shown as a notice in the chat, the text the failed attempt streamed is discarded, and Stop works during the wait. Out-of-quota errors, other 4xx errors and refused connections are still shown straight away. Chat turns now use provider clients without SDK-level retries so the app is the only one retrying and every retry is visible; chat titles keep the SDK's silent retries.
- Log crashes and other problems to `logs/app.log.jsonl` in the user data folder: uncaught errors and unhandled rejections, a crashed or hung UI, helper processes that ended, failed IPC calls (channel and error message, not the arguments), the app page failing to load, errors that reach the top of the UI, and errors shown in the chat. Entries hold error messages and stacks, which can mention file paths, but no chat history; API keys and tokens are redacted. The file stays on the machine and rotates at 512 KB. Help → Show Log Folder opens it.
- Log tool calls that arrive with required fields missing (tool, model, missing and received field names, never values) to `logs/tool-input-errors.jsonl` in the user data folder, so the dropped `new_string` problem in `edit_file` can be measured. The file stays on the machine and rotates at 512 KB.

### Changed
- End-to-end teardown fails after 20 s with the main process's output (the app) or 5 s (the mock APIs) instead of hanging until the 60 s hook timeout; the app's process tree is killed so nothing is left behind. Store tests pass on macOS (its temp folder is a link). New end-to-end tests cover the transcript view (opening a long chat at its end, a tall approval card staying in view, focus after Undo). Node.js 22.12+ is now stated as the requirement, as Electron and Vitest already needed.
- Streaming in a 5,000-item chat costs 14–21 ms per frame since the scroll fix, instead of 7 ms; at 1,250 items it is unchanged at a 7 ms median. See `docs/PERFORMANCE.md`.
- Add end-to-end tests for stopping a multi-step run during a running command (finished steps kept, the command's process ended, every call paired with a result) and resuming it after a restart of the app, for stopping and resuming while an answer streams, and for switching projects in the UI: per-project instructions, drafts with images, opening another project's chat from the history, and switching refused while a task runs. The mock Claude API can now hold an answer open until Stop, and `launchApp` can restart on the same profile.
- End-to-end tests run the app in an invisible window that takes no focus, instead of flashing a window per test file (`E2E_SHOW_WINDOW=1` shows it). Test runs also switch off Chromium's throttling of covered windows, the likely cause of occasional timeouts in the multi-project tests.
- OpenAI-compatible chats no longer shorten their stored history when it grows past ~100k tokens: only the request is trimmed, so the saved chat keeps every message. Chats saved by earlier versions keep what was already removed.
- Add unit tests for the chat store, the project store and the file helpers (image picker, save dialog, open in editor).
- Add unit tests for the agent loop: stop, resume, tool-result pairing, approvals, refusals, the step limit and model errors.

## [0.1.1] - 2026-09-30

### Added
- Keep multiple projects open with separate chats, drafts and workspace-bound tool state. Stop a busy task before switching; closing a tab retains saved history.
- Add a Resume control for stopped tasks, with persisted paused state, completed tool-result pairing, and a continuation instruction to inspect interrupted side effects before retrying them.
- Add GPT-6 list-price estimates and cache-write accounting. Normalize OpenAI cached input, price long-context requests separately, and hide official estimates for custom endpoints. Older chat usage is migrated without double-counting cache reads.

### Security
- Ask for approval before fetching or browsing unlisted network hosts; add an exact-host allow-list in Settings, block cross-host redirects, and deny browser popups that could bypass navigation checks. Auto mode still skips tool approvals; browser subresources and Google search are not filtered.

### Fixed
- The browser panel no longer blocks the user's own link clicks before the agent has opened a page; the same-host navigation policy starts with the first agent-opened page.
- Cost estimates keep long-context tokens at list price for models that have no long-context price instead of dropping them.
- A Stop that arrives just as a run finishes on its own no longer offers Resume.
- New-chat system prompts defer optional tool availability to the current tool list, so adding semantic search mid-chat does not require changing the cached prompt.
- Improve Decline-button text contrast in light and dark approval cards, including hover and keyboard focus states.
- Recent projects keep the most recently opened folder first even when opens share a timestamp, including after reopening the app.

### Development
- Reset focus between theme checks and wait for CSS transitions before measuring rendered contrast.
- Add reproducible Settings, Git and Browser README captures and rendered text-contrast checks for both themes.
- Add executable Amp orb setup and resume scripts: install Linux build/Electron test prerequisites and locked npm dependencies, reuse matching snapshot dependencies, and check readiness on wake without reinstalling.

## [0.1.0] - 2026-09-29

First release of the from-scratch TypeScript codebase (version numbering restarts at 0.1.0; the 6.x line is the old app). No code from 6.x remains; features were rebuilt on a new architecture. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Added
- The chat history search now also looks inside the messages you and the assistant wrote (not tool output or thinking) and shows an excerpt of the match. New `history:search` channel; message text is read from the chat files on first use and cached in memory.
- Settings show indexing progress ("Indexing… 120 of 480 chunks (25%)") while the code index is being built or rebuilt, including updates started by a code search. `IndexStatus` has a new `progress` field.
- Setting "Commands allowed without asking": shell commands (one per line, matched as a whole-word prefix) that run without an approval card in Ask first mode. Commands with shell operators (`; & | > < `` ` `` `$(`) and all file edits still ask.
- The status bar shows an estimated cost (`≈ $0.42`) next to the token usage for Claude models with a known price (`MODEL_PRICING` in `src/shared/models.ts`). Cache writes are not counted, so it is a lower bound; the OpenAI and custom models show no estimate.
- Export the current chat as Markdown (download button in the header): the conversation, tool summaries, commands and diffs; tool output and thinking are left out. New `chat:export` channel, `src/shared/export.ts`.
- The chat history dialog has a search box that filters saved chats by title or project path.
- `AGENTS.md` (or `CLAUDE.md`) from the project root is now always injected into the system prompt of every new chat, and the status bar shows "AGENTS.md loaded".
- Settings show whether the current project's code is indexed (files and chunks) and have a Reindex button that rebuilds the index from scratch.

### Accessibility
- Screen readers no longer re-read the transcript on every streamed chunk: it is not a live region any more. A separate hidden announcer says finished answers, approval requests, failed tools, errors and notices once (`src/shared/announce.ts`).
- Tool status (done, failed, running) has a text label for screen readers, not only an icon. The approval card is a labelled group and its feedback box has a label.
- The Terminal, Browser and Git tabs work with the arrow keys, Home and End, only the selected tab is in the Tab order, and the panels are tab panels.
- Icon-only buttons use their tooltip as their accessible name, the Ask first / Auto button reports its state, dialogs are labelled by their title, and Git file statuses are read out in words.
- Git status colors use Bootstrap's text-emphasis colors, which keep enough contrast on white in the light theme (the plain info color did not).

### Security
- The `browser` tool no longer opens `file://` URLs outside the project. It needs no approval, so a prompt-injected model could otherwise open and screenshot any local file.
- All permission requests (camera, microphone, location, notifications) are denied for the app page and the browser panel; Electron grants them by default.
- The webview can only be attached to `about:blank` or an `http(s)` URL.
- Known limits of the security model (unapproved network tools, editor command, `AGENTS.md` as prompt text) are documented in `docs/ARCHITECTURE.md`.

### Fixed
- `run_command` no longer hangs (spinner until the timeout) when a command exits but leaves a child process running that keeps the output pipe open, such as a test runner's workers. It now returns shortly after the command itself exits.
- Stopping a chat while the browser tool was still waiting for the panel no longer leaves it loading until the timeout; the load timer and abort listener are also cleaned up.
- The chat now autoscrolls to the latest agent output (the scroll position was checked on the wrong element). It follows while you are at the bottom and always after you send a message.
- Editing or overwriting a file that was not read is now rejected while building the approval preview, so you are no longer asked to approve a change that then fails. The error explains that the read must finish before the edit.
- "Invalid input" tool errors now say which fields are missing and which were received, and the `edit_file` description tells the model to read first and always send all three fields.
- Tools that become available while a chat is open (for example `search_code` after saving an OpenAI key) are now offered on the next turn; before, the chat had to be restarted.
- The terminal panel no longer asks the main process for a shell when no project is open, which logged an error at startup; it shows "Open a project to use the terminal." instead.

### Development
- CI also runs on Ubuntu and macOS (non-blocking until they pass; end-to-end tests run under `xvfb-run` on Linux).
- Unit tests for the Git, terminal and browser panel services (the Git "not a repository" test is skipped when the temp folder is inside a repository).
- README shows a screenshot of the approval card (`docs/images/approval.png`), cropped from the end-to-end screenshots.
- `package.json` now has an `author` field.
- 0.1.0 is released for Windows only; macOS and Linux builds come later.
- Unit tests use a 30 s timeout so the first shell start on a slow CI runner no longer fails the run.
- Release workflow: pushing a `v*` tag builds the Windows installer and publishes it on GitHub Releases, with the version's changelog section as notes and a link to the full `CHANGELOG.md`.
- GitHub Actions workflow running typecheck, unit tests and end-to-end tests on Windows for every push and pull request.
- End-to-end test for the OpenAI Responses API path (mock OpenAI server, `CODECOMPANION_TEST_OPENAI_URL`), including the encrypted reasoning round trip.
- `npm run pack` / `npm run dist` stop with a clear message when the app is running from `dist/` (previously an `EBUSY` error on Windows).

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
