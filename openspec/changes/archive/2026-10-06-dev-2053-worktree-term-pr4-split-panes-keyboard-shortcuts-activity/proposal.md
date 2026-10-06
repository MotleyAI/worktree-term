## Why

PR 3 (DEV-2052) made worktree-term usable, but each terminal tab holds exactly one terminal, every new terminal is a plain shell, nothing is reachable by keyboard, and nothing tells the user which agent needs them. This change (DEV-2053, PR 4 of 5 for DEV-1989) adds split panes, keyboard shortcuts, attention indicators and terminal presets — the "Should" list of DEV-1989.

## What Changes

- **BREAKING** (wire): `PROTOCOL_VERSION` 4 — a terminal's `bell` flag is replaced by an attention `state` (`working`, `idle`, `input`) in terminal entries and `activity`; a layout tab holds at most 8 panes; preset names must contain a non-space character and a preset's `command` is null or non-empty.
- `daemon.terminals`: attention state per terminal — `working` on output, `idle` after 3 s without output, `input` on a bell or a desktop-notification escape (OSC 9, OSC 777 `notify`, OSC 99), cleared by typing or by output resuming; an exit while not visible sets `unseen`.
- `hub.config` + `hub.router`: `presets` in `config.json` (default: one plain `shell`), sent to each session as `presets` before `hosts`.
- Web:
  - split panes: binary split tree per tab, at most 8 panes, drag handles, focused pane, per-pane and per-tab close;
  - a preset picker for every new terminal (new tab, split right, split down, empty worktree), skipped when only one preset exists;
  - confirmation before closing running terminals;
  - keyboard shortcuts: Alt+Up/Down worktrees, Alt+Left/Right terminal tabs, Alt+Shift+arrows panes, Ctrl+Shift+T/D/E/W, Ctrl+Shift+C/V;
  - attention indicators on panes, terminal tabs, worktree rows and repo tabs;
  - a hidden page shows no terminals to the daemon.
- Deviations from the DEV-2053 brief agreed during planning: split navigation uses Alt+Shift+arrows (Alt+Up/Down stay worktree navigation); Alt+Left/Right switch terminal tabs; Space on a sidebar row is dropped; the "activity" flags become attention states, aggregated up to repo tabs; split and new-tab buttons in the tab bar.
- README: how to make Claude Code signal that it needs input (`preferredNotifChannel: terminal_bell`).

## Capabilities

### New Capabilities

### Modified Capabilities
- `protocol`: version 4; terminal `state` replaces `bell`; `activity{termId, unseen, state}`; at most 8 panes per layout tab; preset name and command limits.
- `daemon`: protocol 4 handshake; attention state replaces the bell flag; exit while hidden sets `unseen`.
- `hub`: `presets` configuration key; the session receives `presets` before `hosts`.
- `web`: terminal tabs with splits and presets; worktree switching shows every pane of the active tab; visibility follows the page; new requirements for split panes, preset picker, closing, keyboard shortcuts and attention indicators.
- `cli`: version line shows protocol 4.

## Impact

- Code: `src/protocol/**`, `src/daemon/terminals/**`, `src/daemon/server/**`, `src/hub/config/**`, `src/hub/router/**`, `src/web/**`, `README.md`.
- Tests: unit tests beside the code; `test/process/daemon-terminals.test.ts`, `test/process/hub-router.test.ts`, `test/process/hub-server.test.ts`; `test/e2e/**` (new specs for splits, keyboard, presets, attention; perf at the 8-pane maximum).
- Wire: `wire.golden.json` re-blessed for version 4; `frozen.golden.json` unchanged. A protocol-3 daemon shows as `outdated` and is restarted from the page.
- Dependencies, architecture model and arc42 principles: unchanged.
