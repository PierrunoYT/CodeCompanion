# Architecture

CodeCompanion.AI is an Electron desktop app (v6.x) that wraps an LLM-driven coding agent. Everything except a thin main process runs in the **renderer** with `nodeIntegration: true` and `contextIsolation: false`, so renderer code can `require()` Node modules directly and shares globals (`chatController`, `viewController`) across files.

## Process layout

```
main.js (Electron main)              renderer.js (renderer, index.html)
├─ BrowserWindow + menu + shortcuts  ├─ ChatController  ── Chat, Agent, models, tools
├─ node-pty shell (start-shell,…)    ├─ ViewController  ── DOM/UI helpers
├─ file/dir open dialogs             └─ OnboardingController
├─ auto-updater (electron-updater)
└─ Sentry / Aptabase telemetry       preload.js – tiny preload script
```

### Main process (`main.js`)
- Creates the window (bounds persisted in `electron-store` as `windowBounds`), the application menu (Open Project, New Chat, Save Chat, Stop, Download Chat Logs, Check for Updates) and local shortcuts (`app/window/WindowManager.js`).
- Owns the PTY. IPC channels: `start-shell`, `kill-shell`, `write-shell`, `resize-shell`, `execute-command` (one-shot), and replies `shell-data`, `shell-type`, `command-output`, `command-exit`. Shell is `powershell.exe` on Windows, `zsh` on macOS, `bash` on Linux.
- Other IPC: `open-file-dialog` → `read-files`, `open-directory` → `directory-data`, `theme-change`; pushes `app-info`, `save-shortcut-triggered`, `download-logs`.
- Auto-update status is surfaced through `viewController.updateFooterMessage(...)`.

### Renderer (`renderer.js`)
Instantiates the three controllers, wires IPC listeners, the message input (debounced Enter handling) and the approve / reject / reflect buttons (which set `chatController.agent.userDecision`).

## Module map (`app/`)

| Module | Responsibility |
|---|---|
| `chat_controller.js` | Top-level orchestrator: settings, model selection, `process()` request loop, usage tracking, stop/retry, URL ingestion. |
| `chat/chat.js` | Message stores (`frontendMessages` for display, `backendMessages` for the LLM), task title, UI rendering. |
| `chat/chat_context_builder.js` | Builds the two-message prompt (system + user) sent each turn; summarization; relevant-file selection. |
| `chat/agent.js` | Executes tool calls returned by the model, handles approval flow. |
| `chat/chat_history.js` | Save/restore/delete chats in `electron-store` (`chatHistory`). |
| `chat/file_handler.js`, `image_handler.js` | Drag-drop / attach files and images. |
| `models/openai.js`, `models/anthropic.js` | Provider adapters exposing `call`, `stream`, `toolUse`, `abort`. |
| `tools/tools.js` | Tool definitions and implementations (see below). |
| `tools/code_embeddings.js` | Vector index (LangChain `MemoryVectorStore` + OpenAI embeddings). |
| `tools/terminal_session.js` | xterm.js terminal + running agent commands and capturing output. |
| `tools/google_search.js`, `contextual_compressor.js`, `code_diff.js` | Web search, page-content compression, unified diffs. |
| `project_controller.js` | Open projects, ignore rules, file hashing, embeddings lifecycle, custom instructions. |
| `window/git.js`, `window/browser.js` | Git tab (simple-git + diff2html) and in-app browser (`<webview>`). |
| `background_task.js` | Cheap "small model" calls returning structured values via a forced tool call. |
| `static/*` | Model list, prompt templates, embeddings ignore patterns, onboarding tips, constants. |

## The agent loop

1. User submits text → `ChatController.submitMessage` / `processNewUserMessage`. The first message becomes the **task** (`Chat.addTask`, which also generates a 2–4 word title via the small model).
2. `ChatController.process()` calls `ChatContextBuilder.buildMessages()` and `model.call({messages, tools})`.
3. The response goes to `Agent.runAgent()`: assistant text is shown; tool calls are run by `runTools()`.
4. For each tool call: `isToolAllowedToExecute` → `showToolCallPreview` (diffs for file edits) → `waitForDecision` → `callFunction`.
5. Tool results are appended as `tool` messages, then `process()` is called again so the model sees the results. The loop ends when the model responds without tool calls or the user rejects/stops.

Approval: tools with `approvalRequired: true` (`create_or_overwrite_file`, `replace_code`, `run_shell_command`) wait for the user when the **approvalRequired** setting is on. An identical repeated tool call always requires approval. The user may **approve**, **reject** (aborts the loop), or **reflect** (sends the tool call back to the model for reconsideration).

Safety guard: `create_or_overwrite_file` on an existing file and `replace_code` are refused unless the file is already in the chat context (`taskRelevantFiles`); the file is then added so the model can retry.

## Prompt / context construction

`buildMessages` returns `[system, user]`. Full history is not sent verbatim:

- **System**: `PLAN_PROMPT_TEMPLATE` when a first message is judged complex (`isTaskNeedsPlan`, asked of the small model; only planning tools are exposed until `task_planning_done`), otherwise `TASK_EXECUTION_PROMPT_TEMPLATE`. `FINISH_TASK_PROMPT_TEMPLATE` is appended for simple tasks or after >7 messages. Project custom instructions, OS and shell type are substituted in.
- **User**: `<task>`, a `<conversation_history>` (older messages summarized by the small model once they exceed `MAX_SUMMARY_TOKENS`=2000; the last `SUMMARIZE_MESSAGES_THRESHOLD`=6 are kept verbatim), the latest user message, project state (working dir, folder structure), embedding-suggested files, `<relevant_files_contents>` (line-numbered; up to 20 candidate files, `MAX_RELEVANT_FILES_COUNT`=7 / `MAX_RELEVANT_FILES_TOKENS`=10000 / `MAX_FILE_SIZE`=30000), and any reflect message. Attached images are prepended.
- Relevant files come from: files the chat touched, `taskRelevantFiles`, and files modified since the last turn. This is why `read_file` merely registers the file rather than returning contents.

## Tools (`app/tools/tools.js`)

| Tool | Approval | Notes |
|---|---|---|
| `browser` | no | Loads a URL in the built-in browser; returns console output, optional screenshot. |
| `create_or_overwrite_file` | yes | Writes whole file, creates parent dirs. |
| `replace_code` | yes | Replaces an inclusive line range; the model sees line-numbered content. |
| `read_file` | no | Adds file to the context; content arrives in next prompt. |
| `run_shell_command` | yes | Runs in the visible terminal; `background: true` for servers. Output trimmed to first 5 + last 95 lines. |
| `search` | – | `type: codebase` (embeddings + LLM rerank) or `google` (Google CSE, top pages fetched with Readability and compressed). |
| `task_planning_done` | – | Disabled by default; enabled only during planning. |

To add a tool: append an entry to `toolDefinitions` (`name`, `description`, JSON-schema `parameters`, `executeFunction`, `enabled`, `approvalRequired`) and add a case to `previewMessageMapping`.

## Code search / embeddings

`ProjectController.createEmbeddings` computes a hash of the project's file list; if unchanged since last index it skips work. Otherwise `CodeEmbeddings` splits files (language-aware `RecursiveCharacterTextSplitter`, 1000-char chunks), embeds with `text-embedding-ada-002`, and stores vectors in memory, persisted to `electron-store` under `project.<name>.embeddings`. Bumping `EMBEDDINGS_VERSION` in `static/models_config.js` forces reindexing. Search takes the top `2×limit` hits, filters by score ≥ 0.4, and reranks via the small model.

Files skipped: `.gitignore`, `.ccignore` (or the default template in `static/embeddings_ignore_patterns.js`). Projects over `maxFilesToEmbed` (default 1000) are truncated with a warning. **An OpenAI API key is required** for embeddings, even when chatting with Claude.

## Models

`ChatController.initializeModel` picks `AnthropicModel` if the selected model id contains `claude`, else `OpenAIModel` (the base URL is configurable, enabling OpenAI-compatible endpoints). A **small model** (`gpt-4o-mini` if an OpenAI key exists, else `claude-3-haiku`) serves `BackgroundTask` calls: task title, plan detection, summarization, search reranking, result compression. Available models: `static/models_config.js`.

## Persistence (`electron-store`)

Settings (`apiKey`, `anthropicApiKey`, `baseUrl`, `selectedModel`, `approvalRequired`, `maxFilesToEmbed`, `commandToOpenFile`, `theme`), `windowBounds`, `projects`, `project.<name>.embeddings`, `project.<name>.instructions`, `chatHistory`. API keys are stored in plain text in the user data directory.

## Telemetry

Sentry (non-development builds) and Aptabase (usage counts) are initialised in `main.js`/`renderer.js`.
