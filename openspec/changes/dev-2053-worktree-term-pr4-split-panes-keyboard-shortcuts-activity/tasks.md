## 1. Feasibility gate (STOP and flag on any failure)

- [x] 1.1 Probe a headed Chrome `--app` window serving a test page with an xterm.js terminal: Ctrl+Shift+T/W/C/D/E with `preventDefault` trigger no Chrome action; Ctrl+Shift+V with only the xterm custom key handler returning false reaches xterm as a paste event; Alt+arrows and Alt+Shift+arrows reach the page; record the outcome in a handoff comment on DEV-2053 (design D11)
- [x] 1.2 Probe Claude Code with `preferredNotifChannel: terminal_bell` in a PTY whose output is logged with timestamps: the bytes it emits at a permission prompt, at the idle prompt and around the bell; whether it keeps drawing during a 2-minute tool call; whether focus-in/out reports (`ESC [ I` / `ESC [ O`) make it draw within or after 1 s of a signal; record the outcome on DEV-2053 (design D11)

## 2. Tests (pr-tests stage; all fail before implementation)

- [x] 2.1 Protocol v4 unit tests: `PROTOCOL_VERSION` 4, terminal and `activity` `state` (accepted values, `bell` rejected), 8-pane tab limit (8 accepted, 9 rejected), preset name and command limits; `wire.golden.json` expectations for version 4; CLI `--version` shows `(protocol 4)`; verify they fail
- [x] 2.2 Daemon unit tests for the attention state machine with an injected clock: every daemon "Activity" scenario incl. signals split across chunks, OSC 9 progress excluded, bell within/after 1 s of input, focus-only frames (single, repeated, mixed with text), output before/after the 1 s grace, idle deadline under sustained output, exit and close with a pending deadline; verify they fail
- [x] 2.3 Hub unit tests: `presets` schema (default, replacement and order, empty list, duplicate and blank names, empty command, unknown preset key); verify they fail
- [x] 2.4 Web unit tests: `web.layout` split (incl. missing terminal gets its tab first), `setRatio` clamping, `paneRects`/`dividers`, `neighbour` (nested, unequal, ties, none), capacity (8 panes, depth, 64 tabs); keymap (each shortcut, composition, repeat); indicator `mark`/`aggregate`; picker context invalidation and key handling; close-dialog target handling; optimistic layout revert; `HubStore` presets lifetime; verify they fail
- [x] 2.5 `test/process/daemon-terminals.test.ts`: the daemon "Activity" scenarios end to end (two connections for unseen, BEL, OSC 9/777/99, ConEmu progress, typing and focus reports, output grace, idle after 3 s, exit while hidden) and the protocol-4 hello; verify they fail
- [x] 2.6 `test/process/hub-server.test.ts` / `hub-router.test.ts`: `presets` before `hosts`; default, configured and last-valid presets per session; invalid presets refuse the start; a protocol-3 fake daemon is `outdated` and is restarted; verify they fail
- [x] 2.7 `test/e2e/`: fixture presets (a plain shell and a command preset); every new and modified `web` scenario — splits (key and button, drag persists to a second page, remote close during a drag, pane limit, rejected layout reverts, concurrent splits from two pages), pane focus, picker (choose by digit, single preset, Escape, worktree switch), closing (pane, tab, mixed, exited, Escape), keyboard shortcuts (filter-respecting worktree navigation, ends, tabs, panes, `cat -v` sees nothing, copy and paste), attention marks at pane, tab, worktree and repo level (BEL, new output, failed exit, viewing clears), page visibility (hidden, visible, hub restart with a two-pane tab), session loss between `createTerm` and `setLayout`; update PR 3 tests that used `+ New terminal` or an unconfirmed close; verify they fail
- [x] 2.8 `test/e2e/perf.spec.ts`: 8-pane switch median ≤ 100 ms and divider-drag pointer-to-paint median ≤ 16 ms; existing budgets unchanged; verify they fail

## 3. Protocol v4

- [x] 3.1 `PROTOCOL_VERSION` 4, terminal and `activity` `state`, `MAX_PANES` layout refinement, `presetName`/`presetCommand` schemas; re-bless `wire.golden.json` (`frozen.golden.json` unchanged); verify 2.1 and the existing protocol tests pass

## 4. Daemon

- [x] 4.1 `daemon.terminals`: `Attention` state machine, mirror OSC/bell handlers with receipt-time FIFO, lazily re-armed idle deadline, focus-only input frames, exit sets `unseen` when hidden (design D2); `daemon.server` reports `state`; verify 2.2 and 2.5 pass

## 5. Hub

- [x] 5.1 `hub.config` presets with defaults and the shared schemas; `hub.router` sends `presets` before `hosts` from the session snapshot (design D3); verify 2.3 and 2.6 pass

## 6. Web

- [x] 6.1 `web.client`: presets in `HubStore` (cleared on session close), `state` in terminal entries, last daemon-reported layout per worktree; verify their unit tests pass
- [x] 6.2 `web.layout`: split, ratio, geometry, neighbour and capacity functions (design D4); verify their unit tests pass
- [x] 6.3 `web.terminals`: pane placement per rectangle without re-creating containers, injected key filter, desired visibility per host with hidden/pagehide/restore handling (design D5, D7, D9); verify their unit tests pass
- [x] 6.4 `web.ui`: tab bar controls, split rendering with dividers and drag, pane focus, preset picker, close dialog, keyboard dispatcher, attention marks on panes, tabs, worktree rows and repo tabs, optimistic layout revert (design D6–D8, D10); `web.main` wiring; verify 2.4, 2.7 and 2.8 pass

## 7. Documentation

- [x] 7.1 README: shortcuts, presets in `config.json`, and setting Claude Code's `preferredNotifChannel` to `terminal_bell` so waiting agents show as needing input; verify the README renders and its examples parse as valid configuration in a unit test

## 8. Final gates

- [x] 8.1 `pnpm test` green (incl. Playwright); `la-typecheck`, `la-arch-check`, `likec4 validate architecture` exit 0; `pnpm build` succeeds; `openspec validate dev-2053-worktree-term-pr4-split-panes-keyboard-shortcuts-activity --strict` passes
