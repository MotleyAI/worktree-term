## Context

PR 4 of 5 for DEV-1989 (see proposal.md). Binding: PR 1's design (archived change `2026-10-05-dev-1989-…`) D5 (activity from `setVisible`; preset picker; `$SHELL -l -i [-c <command>]`; last `resize` wins) and D6; PR 2's design (change `dev-2051-…`); PR 3's design (change `dev-2052-…`) D10 (restore), D11 (terminal manager, attach generations), D12 (WebGL LRU), D13 (switch measurement). `architecture/` is normative; principles applied: system 3, 5, 6, 8; protocol 2–4; daemon 4, 5; hub 5; web 1, 3–7. No model arrow, allowlist entry or arc42 edit is needed.

Today: the protocol already carries split trees, `setVisible`, `activity{unseen, bell}` and a hub-to-browser `presets` message that the hub never sends; `hub.config` rejects a `presets` key; the daemon tracks `unseen` and `bell`; `web.layout` holds tab operations only; the terminal manager shows terminals in one full-area layer.

## Goals / Non-Goals

**Goals:**
- Tell the user which terminals need them, with no setup beyond Claude Code's `preferredNotifChannel`.
- Splits and keyboard use without breaking web principles 4–6 or the PR 3 perf budgets.

**Non-Goals:**
- Prompt detection by screen content; arbitrating resizes between pages (PR 1 D5: last `resize` wins); revisions or compare-and-set for layouts (D6); Space on a sidebar row (dropped by the user).

## Decisions

### D1 Protocol v4
`bell` becomes `state: working | idle | input` in terminal entries and `activity`; a layout tab holds at most 8 panes (`MAX_PANES`, refined in `protocol/layout.ts`); preset names need a non-whitespace character and a preset's `command` is null or non-empty, through one `presetName`/`presetCommand` schema pair used by both the `presets` message and `hub.config`. `wire.golden.json` re-blessed, `frozen.golden.json` untouched; every protocol-3 reference (golden assertion, version and sample tests, CLI `--version`) moves to 4. A protocol-3 daemon is `outdated` and restarted through PR 3's flow.

### D2 Attention state in `daemon.terminals`
A pure `Attention` state machine per terminal with an injected clock (spec: daemon "Activity"). Signals are recognised by the headless mirror's parser — `onBell` and `parser.registerOscHandler` for 9, 777, 99 — so control-string grammar, chunk boundaries and UTF-8 are handled by xterm's parser rather than a second one. Because mirror writes are asynchronous, each signal is stamped with the receipt time of the output chunk that carried it: `onOutput` pushes the receipt time into a FIFO alongside each `mirror.write`, the write callback pops it, and the handlers read the head. All 1 s rules compare receipt times, so mirror lag cannot shift them. Alternative — a separate byte scanner before the mirror (Codex) — rejected: it duplicates the escape-sequence grammar the mirror already parses.
The idle deadline is one lazily re-armed timer per terminal: output records `lastOutput`; the timer, when it fires, sets `idle` if `lastOutput + 3 s` has passed and otherwise re-arms for the remainder, so a flood costs no timer churn. It is cancelled on exit and close, and a callback after either is ignored.
Input frames come from xterm's `onData`, which emits focus reports as their own call, so "the frame consists only of focus reports" is decided per frame; bytes are never removed from what the PTY receives.

### D3 Presets
`hub.config` parses `presets` with the D1 schemas plus uniqueness, defaulting to `[{name: "shell", command: null}]`; the router sends `presets` before `hosts`. The web client keeps them in `HubStore` (cleared when the session closes), and creation controls stay disabled until they arrive, so the one-preset shortcut can never act on a stale or default list.

### D4 Split tree and geometry in `web.layout` (web principle 1)
Pure functions: `split(layout, termId, dir, newTerm)` (adds a missing terminal's tab first), `setRatio(layout, tab, path, ratio)` (clamped 0.05–0.95), `paneRects(root, area)` and `dividers(root, area)` (pixel rectangles and divider handles addressed by path), `neighbour(rects, termId, dir)` (spec: keyboard shortcuts), capacity checks (8 panes, depth 16, 64 tabs; local constants, as `web.layout` has no runtime import of `protocol`).

### D5 Pane placement in `web.terminals`
`manager.show(host, panes)` takes `{termId, rect}` per shown pane and positions each terminal's existing container absolutely inside the layer, fitting each to its rectangle; containers are never re-created or re-parented (web principle 4). With at most 8 shown panes the existing LRU keeps every shown terminal on WebGL, so no reconciliation pass is needed. During a drag `web.ui` updates the local layout per animation frame and the manager re-fits; one `setLayout` goes out on release.

### D6 Layout writes: optimistic, last writer wins, self-healing
The page applies its own layout at once, keeps the daemon's last reported layout per worktree, and reverts to it when a `setLayout` fails. Concurrent edits from two pages are last-writer-wins; nothing is lost, because a live terminal missing from the layout is still shown as a tab (PR 3). `createTerm` is never retried; a terminal created whose `setLayout` never lands shows as a tab after restore. Alternative — layout revisions with compare-and-set (Codex) — rejected: wire and daemon machinery for a rare two-page edit whose worst outcome is a pane shown as a tab.

### D7 One keyboard dispatcher in `web.ui`
A pure `keymap(event) → Action | null` plus one dispatcher. `web.terminals` accepts an injected key filter (`TerminalKeyFilter`, wired from `web.main`) that it installs with `attachCustomKeyEventHandler`; it returns false for consumed shortcuts and lets Ctrl+Shift+V through to xterm's own paste handling. A document-level `keydown` listener handles shortcuts when focus is outside the terminal layer and ignores events whose target is inside it, so no shortcut runs twice. Shortcuts are ignored while `isComposing`, and while a picker or dialog owns the keys; `event.repeat` is honoured only for navigation. Ctrl+Shift+C uses `navigator.clipboard.writeText`; a rejection is reported on the page.

### D8 Picker and close dialog
The picker is bound to an immutable context `(host, repo, worktree, operation, target termId)` and closes when any part becomes invalid (selection change, host status, target closed, capacity reached); the split is computed from the latest layout after `termCreated`. The close dialog snapshots its targets, closes nothing until confirmed, then closes the targets still live and treats `unknown-term` as done.

### D9 Visibility
The manager owns the desired visible set per host and sends it (spec: "Page visibility"); `visibilitychange` and `pagehide` send empty sets; the restorer's completion per host re-sends the set.

### D10 Indicators
One pure `mark(terminal)` and `aggregate(terminals, level)` in `web.ui` serve panes, tabs, worktree rows and repo tabs, so the ranking is defined once.

### D11 Feasibility probes before tests
Chrome `--app` window: Ctrl+Shift+T/W/C/D/E with `preventDefault` do not trigger Chrome's actions; Ctrl+Shift+V reaches xterm as a paste; Alt and Alt+Shift arrows reach the page. Claude Code with `preferredNotifChannel: terminal_bell`: the bytes it emits at a permission prompt, at the idle prompt and around the bell; whether it keeps drawing during a long tool call; whether focus changes make it redraw within or after 1 s of a signal (which would clear `input` spuriously). Outcomes go into a handoff comment on DEV-2053; any failure stops the work.

## Risks / Trade-offs

- [The 3 s idle timer is not prompt detection: a program waiting on a background job looks `idle`] → `input` is set only by explicit signals; `idle` + `unseen` reads as "done", not "needs you".
- [Claude Code reports a finished turn only after ~60 s, and only when configured] → README documents `preferredNotifChannel`; permission prompts are reported after ~6 s.
- [A program that keeps redrawing after its signal clears `input` after 1 s] → probed for Claude Code (D11); a failure is flagged before tests.
- [Two pages with different pane sizes fight over a terminal's size] → accepted per PR 1 D5.
- [8 panes on one tab hold all 8 WebGL contexts, so other worktrees fall back to DOM] → budgets in the web spec cover an 8-pane switch and a drag.

## Migration Plan

Protocol 4: a protocol-3 daemon shows as `outdated`; the page offers the restart. `state.json` layouts with more than 8 panes in a tab cannot exist (no client could create them).
