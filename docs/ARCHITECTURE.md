# Architecture

CodeCompanion is an Electron app written in TypeScript and built with electron-vite. All logic that touches the file system, the network, API keys or child processes runs in the **main process**. The **renderer** is a sandboxed page without Node.js access that talks to the main process only through a typed IPC contract.

```
┌──────────────────────── main process (Node) ─────────────────────────┐
│ index.ts          wiring, IPC handlers                                │
│ settings.ts       settings + encrypted API keys (safeStorage)         │
│ projects.ts       recent projects, per-project instructions           │
│ chat_manager.ts   active chat, autosave  ──▶ chat_store.ts            │
│ agent/            agent loop, chat session, system prompt             │
│ llm/              Anthropic + OpenAI conversations, small-model calls │
│ tools/            read/edit/write/grep/list, run_command, web, browser│
│ search/           embeddings index for search_code                    │
│ panels/           terminal (node-pty), git (simple-git), browser      │
└───────────────▲──────────────────────────────────────────────────────┘
                │ typed IPC (src/shared/ipc.ts)
┌───────────────┴── preload (sandboxed) ──┐   ┌── <webview> guest ──────┐
│ window.api.invoke / window.api.on,       │   │ pages opened in the     │
│ allow-listed channels only               │   │ browser panel; no Node, │
└───────────────▲──────────────────────────┘   │ no preload             │
┌───────────────┴── renderer (no Node) ────┐   └─────────────────────────┘
│ app.ts, views/ (transcript, composer,     │
│ dialogs, panels), markdown.ts (DOMPurify) │
└──────────────────────────────────────────┘
```

## Source layout

| Path | Contents |
|---|---|
| `src/shared/` | Types and logic used by both processes: IPC contract, settings, models, chat events + transcript reducer, project and panel types |
| `src/main/` | Main process (see diagram) |
| `src/preload/` | The `window.api` bridge |
| `src/renderer/` | UI: `index.html`, `src/app.ts`, `src/views/*`, styles |
| `tests/e2e/` | Playwright-driven end-to-end tests against the built app and a mock Claude API |
| `build/` | Icons, macOS entitlements, NSIS include used by electron-builder |

## IPC contract

`src/shared/ipc.ts` declares every channel:

- `InvokeApi` — renderer → main request/response (`window.api.invoke('settings:get')`).
- `EventMap` — main → renderer pushes (`window.api.on('chat:event', …)`).

Handlers (`src/main/ipc.ts`, `handle` / `send`) and the preload bridge are typed from these maps, so a renamed channel or changed payload fails to compile. The preload forwards only channels listed in `INVOKE` / `EVENTS`; those lists are `Record<Channel, true>` so forgetting a new channel is also a compile error.

## Chats and the agent loop

1. The renderer calls `chat:send`. `ChatManager` creates a `ChatSession` on the first message, fixing the chat's project, model and system prompt, and returns as soon as the session starts. Setup errors (no project, missing key) come back immediately.
2. `Agent.send` (`src/main/agent/agent.ts`) adds the user message and runs turns:
   - The tool list is rebuilt at the start of every turn (`ChatManager` passes `tools: () => …`), so a tool that becomes available while a chat is open, such as `search_code` after an OpenAI key is saved, is offered from the next turn on. The system prompt is not rebuilt; it stays byte-identical for prompt caching and tells the model to use optional tools only when currently offered. When the chat starts, `agent/agent_file.ts` reads `AGENTS.md` (else `CLAUDE.md`, capped at 20,000 characters) from the project root into the prompt, before the per-project instructions. `ChatSnapshot.agentFile` carries its name so the status bar can show that it is loaded; a saved chat keeps the file it started with.
   - `conversation.runTurn` streams the model's answer (text and summarized thinking are forwarded as `chat:event`s).
   - A request that fails for a reason that usually passes is repeated by the agent loop (`runTurnWithRetries`), not by the provider SDKs: their clients are created with `maxRetries: 0` for conversations (chat titles keep the SDK's silent retries). `agent/retry.ts` decides from the error's shape, so it covers Anthropic, OpenAI and compatible endpoints: HTTP 408, 429 and 5xx (including Anthropic's 529), errors sent inside a stream (`overloaded_error`, `api_error`) and connection problems (`ECONNRESET`, timeouts, DNS failures, SDK connection errors). Not retried: other 4xx, an out-of-quota 429, a refused connection (nothing is listening, e.g. Ollama not started), aborts and anything else. Up to 4 retries wait about 2, 4, 8 and 16 seconds (±25%), or the provider's `Retry-After` / `retry-after-ms` when given; a request to wait more than 60 seconds is not retried. Each retry adds a notice to the chat ("Rate limited (429). Retrying in 2 s (retry 1 of 4)…"), discards the text the failed attempt had streamed, and can be stopped during the wait. A conversation only records a turn once it has succeeded, so repeating a request cannot duplicate history; the last error is shown as before once the retries are used up.
   - For each tool call: validate the input against the tool's Zod schema (a failure names the missing fields and the fields received, and is returned to the model as an error result) → build a preview (diff, command, or URL) → if the tool needs approval, the mode is **Ask** and the call is not pre-approved, wait for `chat:decide` → run it. `ChatManager.isPreApproved` checks shell commands against `allowedCommands` (whole-word prefix match without shell operators), fetch/browser hostnames against `allowedNetworkHosts`, and local browser files against workspace confinement. File edits always ask in Ask mode.
   - All results of a turn go back to the model together, then the next turn starts. The loop ends when the model answers without tool calls (or after 200 turns).
3. Declining **with** feedback sends the feedback to the model as the tool result and continues; declining **without** feedback stops the task. Stopping (`chat:stop`) aborts the request and running commands. Every tool call always gets a result, even when skipped or stopped, so the history stays valid for the API.
4. Every event goes through `applyChatEvent` (`src/shared/chat.ts`) in both processes: the main process keeps the transcript for saving, the renderer for display. Streaming deltas are applied in batches once per animation frame.
5. The chat is saved (debounced 500 ms, and immediately when a task finishes) to `userData/chats/<id>.json`, including the provider-native conversation, so reopened chats continue exactly where they stopped.
6. A short title is generated by the small model after the first message.
7. **Compact chat** (`chat:compact`, `ChatSession.compact`) shortens what is sent without touching what is stored, so the history stays append-only. `conversation.planCompaction()` picks a cut (`llm/compaction.ts`): the latest place that still leaves about 40k characters after it and where the history may start without separating a tool call from its result, which is provider-specific (Anthropic: before an assistant message or a user message that is not a tool result; Chat Completions: anywhere but before a `tool` message; Responses: before a message or a reasoning item, never before a function call or its output). The text before the cut (tool results cut to 1,500 characters, inputs to 600, at most 300k characters in all) goes to the small model, which returns a summary. `applyCompaction(summary, keepFrom)` then stores a `CompactionState { summary, keepFrom }` next to the messages in the saved conversation. From then on each request is built from the summary followed by the messages from `keepFrom`: a separate user message in front of an assistant message, or joined to the first block of a user message (a copy; stored messages are never edited). A later compaction starts at the previous `keepFrom` and hands the previous summary to the summarizer. `UsageTotals.contextTokens` (input plus cache reads and writes of the last request) drives the status-bar hint; `COMPACT_SUGGESTED_TOKENS` in `src/shared/models.ts` sets when it turns into a suggestion. This is separate from the server-side compaction Claude models do on their own (`compact-2026-01-12`), which the API applies to the request and returns as blocks in the history.

Stopping a run marks it resumable only after its abort handling settles and tool results are paired. `chat:resume` appends a continuation instruction to the model history (not a duplicate visible user request), warning the model to inspect state before retrying interrupted side effects. The `resumable` flag is saved and restored; declining an approval without feedback does not set it. This continues the task from conversation history, not from an exact execution checkpoint, and cannot guarantee that the model never repeats an action.

`ProjectStore.opened()` tracks tabs separately from recent projects. `ChatManager` retains each inactive project's idle session, workspace and shell runner; switching back restores its chat, including stopped-run state. The renderer keeps unsent text and attachments per project in memory and drops them when a tab closes. Switching or closing projects and starting another chat requires the current run to settle first, preventing approvals from crossing workspaces. The interactive terminal restarts on switches; agent-started background commands stay scoped to their original project until its chat/tab closes. Tabs and drafts are not restored after app restart; saved chats remain accessible through history. `project:opened` and `project:close` are part of the typed IPC contract.

## Model providers (`src/main/llm/`)

`Conversation` is the provider-neutral interface: `addUserMessage`, `addToolResults`, `runTurn`, `serialize`. Each implementation stores history in its API's native format, and only records an assistant turn once the request has succeeded, which is what makes it safe for the agent loop to repeat a failed request.

The SDK clients for conversations are created with `maxRetries: 0` (`createAnthropicClient` / `createOpenAIClient`); retries of transient errors are done by the agent loop so they can be shown in the chat (see [Chats and the agent loop](#chats-and-the-agent-loop)). Clients for the small model keep the SDK's 3 silent retries.

**Anthropic** (`anthropic.ts`, official SDK, `client.beta.messages.stream`):

- History is **append-only**: assistant turns are stored exactly as returned, including thinking, compaction and fallback blocks, because current Claude models reject or ignore edited history.
- Features are enabled per model (`claudeCapabilities` in `src/shared/models.ts`) because unsupported parameters are rejected:
  - Opus 5.5 / Sonnet 5.5 (and other current models): adaptive thinking with summarized display, `output_config.effort` (Settings → Effort, default `high`), server-side compaction (`compact-2026-01-12`).
  - Opus 5.5 / Sonnet 5.5: refusal fallback (`fallbacks: "default"`, `server-side-fallback-2026-07-01`).
  - Haiku 4.5 and unknown ids: a plain request.
- Prompt caching via top-level `cache_control`; the system prompt is built once per chat so the prefix stays cached.
- Tools are sent with `eager_input_streaming`, so large inputs (file contents) stream as generated. The API then no longer validates them, which is why the agent validates every input itself. A turn whose streamed tool input cannot be parsed is re-issued (up to twice).
- No `temperature` and no forced `tool_choice` (both rejected by current models).

**OpenAI** (`openai_responses.ts`, used when no custom base URL is set): the Responses API, because GPT-6 models only support function calling in Chat Completions with reasoning turned off (and GPT-6 Astra cannot turn it off). Requests are stateless (`store: false`); reasoning items come back encrypted (`include: ['reasoning.encrypted_content']`) and are sent back unchanged so the model keeps its reasoning across tool calls. Reasoning effort follows Settings → Effort, reasoning summaries are shown as "Thinking", and `truncation: 'auto'` drops the oldest items when the context fills up.

**OpenAI-compatible endpoints** (`openai.ts`, used when Settings → *OpenAI-compatible base URL* is set, e.g. Ollama, OpenRouter, LM Studio): Chat Completions streaming with function tools, since most compatible servers only implement that API. With no server-side compaction, the oldest turns are left out of each request once the history passes ~100k tokens; the first user message (the task) is always kept. Only the copy that is sent is shortened, the stored history is not (chats saved by older versions were shortened when they were saved). Use **Compact chat** to keep the earlier work as a summary instead of losing it.

In both OpenAI paths, tool screenshots are sent as a follow-up user message because tool results cannot carry images. Saved chats record which API their history belongs to (`api: 'responses' | 'chat'`).

**Small model** (`CompletionClient`): Claude Haiku 4.5 or GPT-6 Luna, whichever key is available (preferring the chat's provider). Used for chat titles, with structured outputs (`output_config.format` / `response_format`) validated by Zod.

A chat keeps its model. Changing the model in settings applies to new chats.

## Tools (`src/main/tools/`)

| Tool | Approval | Notes |
|---|---|---|
| `read_file` | no | Line-numbered, optional `offset`/`limit`; marks the file as read |
| `list_directory` | no | Skips `.gitignore`/`.ccignore` matches, `.git`, `node_modules` |
| `grep` | no | JavaScript regex over non-ignored text files, 200 matches max |
| `search_code` | no | Semantic search (only offered while an OpenAI key is set; picked up mid-chat) |
| `edit_file` | yes | Exact string replacement; must be unique unless `replace_all`; tolerates CRLF files |
| `write_file` | yes | Create or overwrite; creates folders |
| `run_command` | yes | Fresh shell per call (PowerShell on Windows, `$SHELL` elsewhere) in the project root; timeout (default 120 s, max 600 s); `background: true` for servers |
| `command_output` | no | Read or stop a background command |
| `fetch_url` | yes, unless host allowed | Main text via Readability; cross-host redirects are blocked |
| `web_search` | no | Google Custom Search (only when configured) |
| `browser` | yes, unless host allowed or project file | Opens a URL in the browser panel; returns title, status, console messages, optional screenshot |

Rules enforced in code, not only in the prompt:

- `Workspace.resolve` confines every path to the project root (symlinks are resolved first).
- Existing files must be read in the current chat before `edit_file` or `write_file` may change them. The check runs both in `preview` (so an unread file is rejected before the user is asked to approve) and in `run`.
- **Undo.** `edit_file` and `write_file` return `ToolOutput.undo` (`EditUndo`): the project-relative path, the exact previous bytes (`null` when the tool created the file) and the SHA-256 of what was written. It is never shown to the model. `Agent` passes it to `onEditApplied(toolId, edit)`, which `ChatManager` connects to `EditBackups.record` (`tools/edit_backups.ts`, one JSON file per edit in `userData/edit-backups/<chat id>/`, named by a hash of the model-supplied tool id, newest 50 per chat, deleted with the chat). If that succeeds the `tool-end` event carries `undoable: true` and the card gets `undo: 'available'`. `edit:undo` (`ChatManager.undoEdit`) works only when the chat is idle and the card is `available`; `EditBackups.undo` resolves the path through `Workspace.resolve`, refuses unless the file's current bytes hash to `afterHash` (so later changes are never lost, and edits to one file are undone newest first), writes the bytes back or deletes the created file, and uses the backup up. `ChatSession.editUndone` then emits `tool-undone` (card `undo: 'undone'`), removes the file from `readFiles` so the model has to read it again, and queues a note that is put in front of the next message (or the resume instruction) sent to the model, so the conversation itself stays append-only.
- Command output is capped (start and end kept); commands are killed with their whole process tree on stop or timeout.

To add a tool: create it with `defineTool` (name, description, Zod schema, `requiresApproval`, optional `preview`, `run`) and register it in `registry.ts`.

## Code search (`src/main/search/`)

`CodeIndex` walks the project (respecting ignore rules, up to *Maximum files to index*), splits text files into overlapping 60-line chunks, embeds them with OpenAI `text-embedding-3-small` and stores Float32 vectors in `userData/indexes/<sha1 of path>.json`. Updates re-embed only files whose size or modification time changed. The index is built on the first `search_code` call, never in the background. Search ranks by cosine similarity, at most two snippets per file. Changing `INDEX_VERSION` or the embedding model rebuilds indexes. Settings shows the current project's index status (`index:status`: files and chunks, or why it is unavailable) and a Reindex button (`index:rebuild`, `CodeIndex.rebuild()`), which clears the index and embeds everything again.

## Panels (`src/main/panels/`, `src/renderer/src/views/panels.ts`)

- **Terminal**: one interactive shell per project (`node-pty`), rendered with xterm.js. Separate from the agent's commands. The renderer starts it only when a project is open; without one the panel just says "Open a project to use the terminal." The main process still rejects `terminal:start` without a project as a safety net.
- **Browser**: a `<webview>` in the renderer (partition `persist:browser`). When it attaches, the main process receives its `webContents`; `BrowserService` implements the `browser` tool on it (load, console capture, `capturePage` scaled to ≤1280 px).
- **Git**: `simple-git` — status, diff (untracked files shown as additions), commit all, discard, init. Refreshes when the agent finishes a tool call.

## Storage (`app.getPath('userData')`)

| File | Contents |
|---|---|
| `settings.json` | Settings; API keys as `safeStorage` ciphertext (plain text only if the OS offers no encryption, flagged in Settings) |
| `projects.json` | Recent projects (20) and their instructions |
| `chats/index.json`, `chats/<uuid>.json` | Saved chats (transcript, conversation, usage, `officialPricing`). The index holds each chat's `ChatSummary`, including `cost` (`estimateCost` at save time, `null` without a known price), which the chat history shows. An index without costs, written by an older version, is rebuilt from the chat files on start |
| `edit-backups/<chat uuid>/<hash>.json` | Copies of the files that approved edits changed (base64 of the previous bytes), so an edit can be undone from its card. Newest 50 per chat; deleted with the chat |
| `indexes/<hash>.json` | Code search indexes |
| `logs/app.log.jsonl` | Crashes and other problems (`AppLog` in `src/main/app_log.ts`): time, level, source, message, stack. Keys and tokens are redacted; error messages can mention file paths, but chat history is never logged. UI errors arrive through `log:renderer-error` (`RendererErrorReporter`, capped at 100 per run). Local only; rotates to `.old` at 512 KB |
| `logs/tool-input-errors.jsonl` | Tool calls rejected for missing fields: time, tool, model, field names only (never values). Local only; rotates to `.old` at 512 KB |

Writes go through a temp file and rename. Setting `CODECOMPANION_USER_DATA` uses a different folder (tests use this).

## Accessibility

- The transcript is re-rendered per streamed chunk, so it is not an `aria-live` region. `TranscriptView.announcer` is a hidden `role="status"` region fed by `newAnnouncements` (`src/shared/announce.ts`): a finished answer (first 300 characters), an approval request, a failed tool, an error or a notice, each once. Opening a saved chat announces nothing.
- Anything that carries meaning only through an icon or color needs a text alternative (`visually-hidden` text or `aria-label`). `h()` gives icon-only buttons their `title` as `aria-label`.
- Use Bootstrap's `*-text-emphasis` colors for colored text, not the plain `--bs-info`/`--bs-warning`, which are too light on white.

## Security model

- **Renderer isolation**: `contextIsolation`, `sandbox`, no `nodeIntegration`. Strict CSP (`script-src 'self'`, no remote images or connections).
- **Preload**: exposes only `invoke`/`on` for allow-listed channels.
- **Navigation**: the app window cannot navigate; `http(s)` links and `window.open` go to the system browser.
- **Browser panel**: guests get no preload, no Node, sandboxed, in their own session partition; popups are denied. A guest can only be attached to `about:blank` or an `http(s)` URL. Every permission request (camera, microphone, location, notifications) is denied. Browser-tool top-level redirects and later page navigation stay on the approved hostname; cross-host destinations need a new tool call. Project `file://` URLs are preapproved only after `confineFileUrl` checks confinement.
- **Model output**: rendered markdown and diffs pass through DOMPurify; images, embeds, forms and styles are removed from model output (an image URL is a common data-exfiltration channel for prompt injection). Generated UI never uses inline handlers.
- **Secrets**: keys are encrypted at rest and never sent to the renderer.
- **Agent**: path confinement, read-before-write, approval for edits and commands by default. Commands still run with the user's permissions; **Auto** mode trusts the model with your shell. Commands on the "allowed without asking" list skip approval only when they contain no shell operator.

### Known limits (reviewed 2026-09-30)

These are accepted for 0.1.0; each is a trade-off, not an oversight.

- **Network approvals are not a sandbox.** In Ask mode, `fetch_url` and `browser` require approval unless the exact URL hostname matches `allowedNetworkHosts` (empty by default, all ports, subdomains listed separately). Auto mode skips approvals. Fetch and browser top-level cross-host redirects are blocked even in Auto mode; the model must request the destination separately. Before the agent opens a page, and for addresses typed in the panel's address bar, browser navigation is not filtered; after the agent opens a page, link clicks and redirects in the panel stay on that page's host. Browser subresources and Google `web_search` are not filtered by this policy. Approved hosts and search queries can still receive private data. Keep projects with secrets out of chats that read untrusted pages.
- **Editor command.** `editorCommand` is run through a shell with the file path quoted. It is the user's own setting; a compromised renderer could change it, but the same renderer can already write to the terminal panel.
- **IPC handlers trust the renderer's arguments.** The renderer is sandboxed, has a strict CSP and only shows sanitized model output, and pages in the browser panel have no preload, so they cannot call IPC. Handlers that take paths (`git:*`, file tools) still confine them to the project with `Workspace.resolve`.
- **Retries repeat the whole request.** A failure in the middle of a long answer discards the streamed text and asks again, so the tokens of the failed attempt may be billed. On the Anthropic path, a failure after a compaction or `pause_turn` continuation is retried from the history as it then stands, so the text of the earlier part of that turn is not part of the final answer. Only errors that usually pass are retried; a wrongly classified error costs at most 4 extra requests (about 30 seconds) before it is shown.
- **A compaction is a lossy summary written by the small model.** Details can be missed or wrong, and the model then works from the summary as if it were what happened; the unedited history stays in the chat file but is no longer sent. The summarizing request is not included in the token and cost totals (`CompletionClient` reports no usage). The first request after a compaction misses the prompt cache. Context size is only known after a request, and the 150k suggestion is one value for every model, not a limit of the model in use (custom endpoints can have far smaller windows).
- **Undo covers the edit tools only.** Changes made by commands the assistant ran, or by anything else, have no backup. A backup is a plaintext copy of the file on disk in the app's data folder (until the chat is deleted or 50 newer edits push it out), which matters for projects with secrets. The note that tells the model about an undo is kept in memory: if the app is closed before the next message, the model is not told, and only learns of it when its next edit fails to match (the file must be read again anyway).
- **Local logs can name paths.** `logs/app.log.jsonl` never holds chat history or API keys (keys and tokens are redacted), but error messages such as "Folder not found: …" can contain file paths. The files stay on the machine and rotate at 512 KB; nothing is sent anywhere.
- **Project instructions and `AGENTS.md`** are prompt text, not trusted configuration: they are added to the system prompt, so a malicious repository can steer the model. Approvals still apply to edits and commands.

## Tests

- `npm run test:unit` — Vitest unit tests next to the code (`*.test.ts`). The provider tests run the real SDKs against a local mock HTTP server (`llm/test_server.ts`).
- `npm run test:e2e` — builds the app and drives it with Playwright's Electron support, using a throwaway profile and mock APIs: Claude (`tests/e2e/mock_claude.ts`, enabled by `CODECOMPANION_TEST_ANTHROPIC_URL`) and OpenAI (`tests/e2e/mock_openai.ts`, enabled by `CODECOMPANION_TEST_OPENAI_URL`, used only when no custom base URL is set so the Responses API path runs). Covers window security, settings, a full tool-using chat with approval on both providers (including the encrypted reasoning round trip), the UI, the panels, retries of rate limits and overloads (the Claude mock can script failures with `Retry-After`), and the local error log and Help menu. The harness also captures the main process's stderr, so tests can assert that no IPC handler errors were logged.
