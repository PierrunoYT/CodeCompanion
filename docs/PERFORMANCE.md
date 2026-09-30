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

### Follow-up: scrolling to the bottom (2026-09-30, 0.2.0 audit)

`content-visibility: auto` broke scrolling to the bottom. Items that were off screen count at their 80 px placeholder height until laid out, so:
- opening a chat of 200 tall items landed 3,300 px above the end;
- a new approval card appended while following the chat left Approve out of view.

The fix:
- after a chat is opened, the view jumps to the bottom again for 10 frames, and for 2 frames after an item is added;
- a view at the bottom stays there when the scroll area gets smaller;
- the user's own scrolling ends all of this.

`tests/e2e/transcript_view.test.ts` covers it.

**Cost, from three runs of each variant:**

| Streaming, frame p50 / p95 | 250 turns | 1,000 turns |
|---|---|---|
| Before the fix | 7 / 7 ms | 7 / 14 ms (one run in three: 21 / 28 ms) |
| With the fix | 7 / 21 ms | 14–21 / 28 ms |

Opening times are unchanged. For comparison, the same 1,000-turn chat was at 42 / 49 ms before the three changes above.

**Other ways that were measured and dropped:** each made streaming in the 1,000-turn chat two to three times slower.
- following every height change, with a frame loop or with a ResizeObserver on the transcript;
- laying out the newest items with an inline `content-visibility` style.

**Not yet found:** which part of the kept fix costs the remaining time at 1,000 turns. Every piece was measured on its own and none accounts for it alone. It is a task in `TASKS.md`.

**The benchmark is noisy:** the same build sometimes measures 7 ms and sometimes 21 ms, so compare at least three runs.

### Not changed, and why

- **Re-rendering the streaming message's Markdown on each frame.** The whole answer so far is re-parsed, highlighted and sanitized on every frame: about 2.2 s of script over the 20,000-character answer, or about 3 ms per frame. This cost depends on the answer, not the chat, and is the same in an empty chat. If very long answers stutter, render only the last Markdown block while streaming.
- **Opening still renders every message's Markdown** (about 0.2 ms per item). A 5,000-item chat opens in about 1.1 s. Rendering off-screen messages lazily, or full virtualization, would help chats far longer than this. It would cost scroll-position bookkeeping and would break Find in page and the screen-reader view of the full chat, so it is not worth it yet.
- **The main process** also applies every streamed event to its copy of the transcript (`applyChatEvent`, which copies the item list). This was not measured here.
- **`Performance.getMetrics` did not attribute the opening's script time** (it reported about 2 ms), so opening is measured by wall-clock time in the page instead.
