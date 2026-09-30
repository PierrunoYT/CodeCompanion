# Tasks

Tick a box (`- [x]`) when a task is done.

## Done

- [x] Rewrite the app in TypeScript with electron-vite
- [x] Terminal, browser and Git panels
- [x] Approval cards, Auto / Ask first mode
- [x] GPT-6 models through the OpenAI Responses API
- [x] Docs, changelog, `AGENTS.md`
- [x] Push to `PierrunoYT/CodeCompanion`

## Release 0.1.0

- [x] Manually test the packaged Windows build (`dist/win-unpacked/CodeCompanion.exe`)
- [x] Build the NSIS installer (`npm run dist`, 119 MB, version 0.1.0); the packaged app starts cleanly
- [x] Run the installer, then check the Start menu entry, launch, and uninstall (worked)
- [x] Fix `npm run dist` failing with EBUSY when `dist/win-unpacked` is in use (a guard script asks you to close the app)
- [x] Add an end-to-end test for the OpenAI Responses path
- [x] Reset the version to `0.1.0` (new codebase)
- [x] Update the `CHANGELOG.md` date on release (2026-09-29)
- [x] Tag the release and publish the Windows installer on GitHub Releases (0.1.0 is Windows only)

## Release 0.1.1

- [x] Move the unreleased changelog entries into `[0.1.1] - 2026-09-30`, bump the version, tag `v0.1.1` (the release workflow builds and publishes the Windows installer)
- [ ] Check that the `v0.1.1` release workflow passes and the installer is attached on GitHub Releases

## Later: other platforms (after the Windows release)

Won't fix for now: 0.1.0 supports Windows only, so these stay open but are not planned.

- [ ] ~~Test on macOS: build the DMG, check signing and notarization~~ (won't fix for now)
- [ ] ~~Test on Linux (`node-pty` compiles from source there) and add a Linux build target~~ (won't fix for now)

## Next: 0.2.0 (planned)

Proposed, in rough priority order. Reorder or drop as you see fit.

### Reliability

- [x] Add unit tests for `chat_store`, `projects` and `files` (only `chat_manager`, `settings` and `stores` are covered in `src/main`)
- [x] Add unit tests for the agent loop (`src/main/agent`): stop, resume, tool-result pairing and error paths
- [x] Log dropped-field tool errors (tool name and missing fields, never file contents) to make the open `edit_file` bug measurable
- [x] Log crashes and other problems locally (`logs/app.log.jsonl`): uncaught errors, crashed or hung UI, failed IPC calls, chat errors
- [x] Add a Help menu item that opens the log folder, and log renderer errors (`window.onerror`) through a new IPC channel
- [x] Retry transient provider errors (429, 5xx, network) with backoff, and show the retry in the chat

### Features

- [x] Add a "compact chat" action that summarizes old turns when a chat nears the context limit, keeping the history append-only
- [x] Add an undo for the last approved file edit (keep a backup per edit, restore from the diff card)
- [x] Show the running cost of a chat in the chat list, not only in the status bar
- [ ] Add a per-project setting for allowed commands and network hosts (today they are global)
- [x] Let the user attach an image to a message for models that accept images, gated behind `claudeCapabilities`

### Quality

- [x] Add an end-to-end test for stop and resume of a long agent run
- [x] Add an end-to-end test for multi-project switching (separate chats and drafts)
- [ ] Add a size limit and truncation notice for very large tool results shown in the UI
- [ ] Review the renderer for long-chat performance (virtualize or paginate the message list) and record a measurement

### Docs

- [x] Add a short user guide (`docs/USAGE.md`) covering approvals, allow-lists, resume and export
- [ ] Keep `CHANGELOG.md` `[Unreleased]` in sync as each item above lands

## Project setup

- [x] Prepare Amp orb lifecycle scripts with snapshot dependency reuse and headless Electron test prerequisites
- [x] Add a `LICENSE` file (MIT)
- [x] Add a GitHub Actions workflow: typecheck, unit tests, end-to-end tests (Windows only)
- [x] Add Linux and macOS jobs to the CI workflow (non-blocking until they pass; then remove `continue-on-error`)
- [ ] ~~Make the Linux and macOS CI jobs blocking once they pass~~ (won't fix for now; the jobs stay non-blocking and their failures are ignored)
- [x] Add a release workflow that builds the Windows installer (`.github/workflows/release.yml`, runs on `v*` tags)
- [x] Add screenshots to the README (`E2E_SCREENSHOTS` can generate them; one approval screenshot so far)
- [x] Add more README screenshots (settings, Git and browser panels) without local paths
- [ ] Decide whether the repo should be public

## Features

- [x] Add unit tests for the Git, terminal and browser panel services; fix the browser stop-while-waiting bug they found
- [x] Fix `run_command` hanging after the command exited while a leftover child held the output pipe
- [x] Always inject `AGENTS.md` into the session and show in the UI that it is loaded
- [x] Add a stop-and-resume option for long agent runs, including reopening stopped chats
- [x] Show cost estimates next to the token usage in the status bar (Claude models only)
- [x] Add verified GPT-6 prices, per-request long-context tiers, and cache-write tokens to cost estimates
- [x] Add a setting to allow specific commands without approval
- [x] Support several open projects with separate chats and drafts (one active agent run; stop before switching)
- [x] Add a search box for saved chats (title and project path; searching the message text is not done)
- [x] Search the message text of saved chats, not only title and project
- [x] Export a chat as Markdown

## Bugs

- [x] Keep recent-project ordering deterministic when opens share a timestamp, including reopening and reload
- [x] Tools were fixed when a chat was created, so adding an OpenAI key mid-chat gave no `search_code`. The tool list is now rebuilt every turn
- [x] Mention optional search/browser tools conditionally on the current tool list while keeping the system prompt frozen for caching
- [x] Stop logging `terminal:start` errors when no project is open (the terminal starts only once a project is open)
- [x] Editing an unread file failed only after the user approved the diff. The read check now also runs in the preview, so it is rejected before approval
- [x] "Invalid input" tool errors were vague when the model left out a field. They now name the missing and received fields
- [ ] The model sometimes drops a required field such as `new_string` in parallel `edit_file` calls; the app can only report it. Watch whether the clearer error and tool description reduce this (each occurrence is logged to `logs/tool-input-errors.jsonl`, see `docs/DEVELOPMENT.md`)

## Quality

- [x] Add unit tests for the panels (`browser`, `git`, `terminal`)
- [x] Add unit tests for the code index (`src/main/search`)
- [x] Show indexing progress in Settings while reindexing
- [x] Review the security model again before the release (findings fixed or documented under "Known limits" in `docs/ARCHITECTURE.md`)
- [x] Require approval for `fetch_url` and the `browser` tool on hosts outside an allow-list (browser subresources and Google search remain documented limits)
- [x] Check for accessibility problems (keyboard navigation, contrast): code audit done and fixed, see the changelog
- [x] Measure representative rendered text contrast in both themes, including approval controls and their hover/focus states
- [ ] Test with a real screen reader (NVDA); requires a Windows session with NVDA, unavailable in the Linux orb
