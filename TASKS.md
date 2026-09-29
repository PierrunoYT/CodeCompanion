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

## Later: other platforms (after the Windows release)

- [ ] Test on macOS: build the DMG, check signing and notarization
- [ ] Test on Linux (`node-pty` compiles from source there) and add a Linux build target

## Project setup

- [x] Add a `LICENSE` file (MIT)
- [x] Add a GitHub Actions workflow: typecheck, unit tests, end-to-end tests (Windows only)
- [ ] Add Linux and macOS jobs to the CI workflow
- [x] Add a release workflow that builds the Windows installer (`.github/workflows/release.yml`, runs on `v*` tags)
- [x] Add screenshots to the README (`E2E_SCREENSHOTS` can generate them; one approval screenshot so far)
- [ ] Add more README screenshots (settings, Git and browser panels) without local paths
- [ ] Decide whether the repo should be public

## Features

- [x] Add unit tests for the Git, terminal and browser panel services; fix the browser stop-while-waiting bug they found
- [x] Fix `run_command` hanging after the command exited while a leftover child held the output pipe
- [x] Always inject `AGENTS.md` into the session and show in the UI that it is loaded
- [ ] Add a stop-and-resume option for long agent runs
- [ ] Show cost estimates next to the token usage in the status bar
- [ ] Add a setting to allow specific commands without approval
- [ ] Support several open projects at once
- [ ] Add a search box for saved chats
- [ ] Export a chat as Markdown

## Bugs

- [x] Tools were fixed when a chat was created, so adding an OpenAI key mid-chat gave no `search_code`. The tool list is now rebuilt every turn
- [ ] The system prompt still mentions `search_code` only if a key was set when the chat started (kept frozen for prompt caching); the tool's own description covers it
- [x] Stop logging `terminal:start` errors when no project is open (the terminal starts only once a project is open)
- [x] Editing an unread file failed only after the user approved the diff. The read check now also runs in the preview, so it is rejected before approval
- [x] "Invalid input" tool errors were vague when the model left out a field. They now name the missing and received fields
- [ ] The model sometimes drops a required field such as `new_string` in parallel `edit_file` calls; the app can only report it. Watch whether the clearer error and tool description reduce this

## Quality

- [ ] Add unit tests for the panels (`browser`, `git`, `terminal`)
- [x] Add unit tests for the code index (`src/main/search`)
- [ ] Show indexing progress in Settings while reindexing
- [ ] Review the security model again before the release
- [ ] Check for accessibility problems (keyboard navigation, contrast)
