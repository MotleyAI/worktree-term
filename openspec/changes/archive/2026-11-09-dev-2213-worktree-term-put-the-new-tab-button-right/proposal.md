## Why

The `+` button that opens a new terminal tab sits in the right corner of the terminal tab bar with the split buttons, far from the tabs it adds to — unlike the usual browser/terminal convention of a new-tab button right after the last tab. Tabs are also only labelled `<preset> <termId>`, so several tabs of the same preset can't be told apart; the user wants to name them.

## What Changes

- The new-tab `+` control is rendered directly after the last terminal tab and moves as tabs open and close; with no tabs it sits at the left of the tab bar.
- The split-right / split-down controls stay at the right end of the tab bar.
- When the tabs overflow the bar, the tabs scroll horizontally and the `+` and split controls stay visible.
- The new-tab control's behaviour is unchanged: same test id, hover title, Ctrl+Shift+T shortcut and disabled states.
- Double-clicking a terminal tab edits its name in place; the name is stored in the worktree's layout, so every page shows it.
- **BREAKING** (wire): a layout tab gains an optional `name`; both `DAEMON_PROTOCOL_VERSION` (8 → 9) and `BROWSER_PROTOCOL_VERSION` (11 → 12) are raised, so running daemons are reported outdated until restarted.

## Capabilities

### New Capabilities

### Modified Capabilities
- `web`: the `Terminal tabs` requirement gains the placement of the tab-bar controls, their visibility when tabs overflow, and renaming tabs.
- `protocol`: `Layout validity` gains the optional tab `name`; `Protocol version and frozen handshake messages` raises both link versions.
- `daemon`: `Checked state and layouts` keeps a tab's id and name when one of its panes closes.

## Impact

- `src/protocol/layout.ts`, `src/protocol/constants.ts`, wire/frozen goldens.
- `src/daemon/state/layout.ts` (pruning keeps the name).
- `src/web/ui/app.tsx` (tab bar markup, `TabControls`, `TermTab`), `src/web/ui/view.ts` (rename action), `src/web/layout/tree.ts` (keep the name), `src/web/main/styles.css`.
- Unit tests beside the changed modules; Playwright e2e under `test/e2e/`.
