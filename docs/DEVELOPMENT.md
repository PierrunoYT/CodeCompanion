# Development Guide

## Prerequisites
- Node.js and npm
- Build toolchain for native modules (`node-pty`): see the [node-pty dependencies](https://github.com/microsoft/node-pty?tab=readme-ov-file#dependencies) (Python, C++ compiler / Visual Studio Build Tools on Windows, Xcode CLT on macOS).

## Run
```bash
npm install        # postinstall rebuilds native deps for Electron
npm start          # run the app
npm run debug      # NODE_ENV=development, opens DevTools
```

## Scripts
| Script | Purpose |
|---|---|
| `npm run pack` | Unpacked build (`electron-builder --dir`) |
| `npm run dist` | Build installers (NSIS on Windows, universal DMG on macOS) |
| `npm run publish` | Build and publish to S3 (needs AWS credentials) |
| `npm run set-no-cache` | Runs `scripts/setNoCache.js` (cache headers for release artifacts) |

macOS builds are signed and notarized via `scripts/notarize.js` (needs Apple credentials in the environment). `appveyor.yml` drives Windows CI.

## Conventions
- Prettier config in `.prettierrc`; follow existing style (see also `CONTRIBUTING.md`).
- No test suite or linter is configured.
- Renderer modules rely on globals `chatController` and `viewController` (defined in `renderer.js`), so be careful when moving code into new modules or calling them from early constructors.
- Debug logging helper: `log` in `app/utils.js`.

## Where to change things
| Goal | File |
|---|---|
| Add/remove a selectable model | `app/static/models_config.js` (`modelOptions`) |
| Change system prompts | `app/static/prompts.js` |
| Add an agent tool | `app/tools/tools.js` (see ARCHITECTURE.md) |
| Add a new setting | `DEFAULT_SETTINGS` in `app/chat_controller.js` + matching element id in `index.html` |
| Tune context size | constants at top of `app/chat/chat_context_builder.js` |
| Change default embedding ignores | `app/static/embeddings_ignore_patterns.js` |
| Add onboarding tips | `app/static/onboarding_steps.js` |
| Add an IPC channel | `main.js` (`ipcMain`) + `ipcRenderer` in the renderer module |

## Security notes for contributors
- `nodeIntegration` is on and `contextIsolation` is off; never render untrusted HTML unsanitized (model output and fetched web pages are rendered in the UI).
- The agent can write files and run shell commands; keep `approvalRequired` semantics intact when altering `Agent`.
- API keys live in plain-text `electron-store`.
