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

- [ ] Manually test the packaged Windows build (`dist/win-unpacked/CodeCompanion.exe`)
- [x] Build the NSIS installer (`npm run dist`, 119 MB, version 0.1.0); the packaged app starts cleanly
- [x] Run the installer, then check the Start menu entry, launch, and uninstall (worked)
- [x] Fix `npm run dist` failing with EBUSY when `dist/win-unpacked` is in use (a guard script asks you to close the app)
- [x] Add an end-to-end test for the OpenAI Responses path
- [ ] Test on macOS: build the DMG, check signing and notarization
- [ ] Test on Linux (`node-pty` compiles from source there) and add a Linux build target
- [x] Reset the version to `0.1.0` (new codebase)
- [ ] Update the `CHANGELOG.md` date on release
- [ ] Tag the release and publish the installers on GitHub Releases

## Project setup

- [x] Add a `LICENSE` file (MIT)
- [x] Add a GitHub Actions workflow: typecheck, unit tests, end-to-end tests (Windows only)
- [ ] Add Linux and macOS jobs to the CI workflow
- [ ] Add a release workflow that builds the installers
- [ ] Add screenshots to the README (`E2E_SCREENSHOTS` can generate them)
- [ ] Decide whether the repo should be public

## Features

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

## Quality

- [ ] Add unit tests for the panels (`browser`, `git`, `terminal`)
- [ ] Add unit tests for the code index (`src/main/search`)
- [ ] Review the security model again before the release
- [ ] Check for accessibility problems (keyboard navigation, contrast)
