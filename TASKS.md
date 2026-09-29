# Tasks

Tick a box (`- [x]`) when a task is done.

## Done

- [x] Rewrite the app in TypeScript with electron-vite
- [x] Terminal, browser and Git panels
- [x] Approval cards, Auto / Ask first mode
- [x] GPT-6 models through the OpenAI Responses API
- [x] Docs, changelog, `AGENTS.md`
- [x] Push to `PierrunoYT/CodeCompanion`

## Release 7.0.0

- [ ] Manually test the packaged Windows build (`dist/win-unpacked/CodeCompanion.exe`)
- [ ] Build and test the NSIS installer (`npm run dist`)
- [ ] Add an end-to-end test for the OpenAI Responses path
- [ ] Test on macOS: build the DMG, check signing and notarization
- [ ] Test on Linux (`node-pty` compiles from source there) and add a Linux build target
- [ ] Bump the version from `7.0.0-alpha.0` and update `CHANGELOG.md`
- [ ] Tag the release and publish the installers on GitHub Releases

## Project setup

- [ ] Add a `LICENSE` file (docs say MIT)
- [ ] Add a GitHub Actions workflow: typecheck, unit tests, end-to-end tests
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

## Quality

- [ ] Add unit tests for the panels (`browser`, `git`, `terminal`)
- [ ] Add unit tests for the code index (`src/main/search`)
- [ ] Review the security model again before the release
- [ ] Check for accessibility problems (keyboard navigation, contrast)
