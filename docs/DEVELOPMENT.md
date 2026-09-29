# Development Guide

## Prerequisites
- Node.js and npm
- `node-pty` 1.1+ ships prebuilt binaries for Windows and macOS, so a compiler is normally not needed. Only if no prebuild matches your platform will it compile from source; see the [node-pty dependencies](https://github.com/microsoft/node-pty?tab=readme-ov-file#dependencies) (Python, C++ compiler / Visual Studio Build Tools, Xcode CLT). Version 1.0.x always compiled and failed on Windows with Node 24.
- npm 11 may print an `allow-scripts` warning for `electron` and `node-pty`. Both still work here, since Electron's binary and node-pty's prebuilds were present after install.

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

There is no publish script or CI config; releases are built locally. macOS builds are signed and notarized via `scripts/notarize.js` (needs Apple credentials in the environment).

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
