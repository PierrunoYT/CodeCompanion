# Performance

## Long chats in the renderer (2026-09-30)

**Question:** does the chat UI need a virtualized or paginated message list for long chats?

**Answer:** not at this point. Three targeted changes made streaming in a 5,000-item chat as smooth as in an empty one, and roughly halved the time to open it. The remaining costs grow with the length of the answer being streamed, or linearly with the chat at about 0.2 ms per item when it is opened.

### How it is measured

`npm run perf` (builds first) runs `tests/perf/long_chat.perf.ts`. The test is not part of `npm test` and asserts nothing. It writes its results to `out/perf-long-chat.json`.

- **The chat:** a synthetic saved chat of `PERF_TURNS` turns (default 250). Each turn has 5 items:
  - a request
  - a Markdown answer with a list and a 25-line highlighted code block
  - a `read_file` card
  - an `edit_file` card with a 30-line diff
  - a short reply
- **Open:** the time from `history:open` until the transcript is on screen and painted, measured in the page.
- **Streaming:** a 20,000-character answer (prose, lists, code blocks) streamed by the mock API as 400 deltas, 5 ms apart. The chat is streamed into twice: once empty, once after the long chat has been opened. Measured while it arrives:
  - `requestAnimationFrame` intervals (p50, p95, worst)
  - Chromium's script, layout and style-recalculation time, from the DevTools protocol's `Performance.getMetrics`
- **Window:** the invisible e2e test window, with background throttling off.

Machine: Intel Core Ultra 9 285K (24 threads), 47 GB RAM, Windows 11, Electron 44.4.5, 144 Hz display (a 7 ms frame is a full frame rate). Treat the numbers as relative; they vary by machine.

### Results

1,000 turns (5,000 items):

| | DOM nodes | Open | Frame p50 / p95 while streaming | Layout / style during the stream |
|---|---|---|---|---|
| Empty chat (reference) | 1.8k | — | 7 / 14 ms | 0.48 s / 0.32 s |
| Before | 456k | 3,205 ms | 42 / 49 ms (~24 fps) | 1.94 s / 0.20 s |
| + `content-visibility: auto` | 456k | 2,472 ms | 28 / 35 ms | 0.62 s / 3.02 s |
| + update changed items in place | 456k | 2,465 ms | 7 / 14 ms | 0.07 s / 0.05 s |
| + build card bodies on first expand | 166k | 1,104 ms | 7 / 14 ms | 0.07 s / 0.05 s |

250 turns (1,250 items):

| | DOM nodes | Open | Frame p50 / p95 while streaming |
|---|---|---|---|
| Before | 114k | 841 ms | 7 / 21 ms |
| After all three changes | 41.5k | 297 ms | 7 / 7 ms |

### What was slow, and what changed

1. **Layout of the whole chat on every streamed frame.** The transcript is a flex column, and the message being streamed changes on every frame, so Chromium re-laid out the whole list each time.
   - *Fix:* `.transcript > *` now has `content-visibility: auto` with `contain-intrinsic-size: auto 80px`. Items off screen are skipped for layout and paint, but stay in the DOM and the accessibility tree.
2. **Style recalculation of the whole chat on every frame.** This showed up once layout was cheap. Each frame, the streaming message's element was swapped for a new one, which invalidated the styles of its siblings (Bootstrap uses sibling and `:last-child` selectors).
   - *Fix:* `TranscriptView` now updates a changed item's element in place (`morph`: same element, new attributes and children).
3. **Every finished tool card built its diff up front,** even though the card is collapsed. The diffs were most of the DOM (diff2html lays out a table row per line).
   - *Fix:* a finished card's diff and output are built the first time the card is opened. Approval cards and running cards are unchanged.

### Not changed, and why

- **Re-rendering the streaming message's Markdown on each frame.** The whole answer so far is re-parsed, highlighted and sanitized on every frame: about 2.2 s of script over the 20,000-character answer, or about 3 ms per frame. This cost depends on the answer, not the chat, and is the same in an empty chat. If very long answers stutter, render only the last Markdown block while streaming.
- **Opening still renders every message's Markdown** (about 0.2 ms per item). A 5,000-item chat opens in about 1.1 s. Rendering off-screen messages lazily, or full virtualization, would help chats far longer than this. It would cost scroll-position bookkeeping and would break Find in page and the screen-reader view of the full chat, so it is not worth it yet.
- **The main process** also applies every streamed event to its copy of the transcript (`applyChatEvent`, which copies the item list). This was not measured here.
- **`Performance.getMetrics` did not attribute the opening's script time** (it reported about 2 ms), so opening is measured by wall-clock time in the page instead.
