## Why

The `+` button that opens a new terminal tab sits in the right corner of the terminal tab bar with the split buttons, far from the tabs it adds to — unlike the usual browser/terminal convention of a new-tab button right after the last tab.

## What Changes

- The new-tab `+` control is rendered directly after the last terminal tab and moves as tabs open and close; with no tabs it sits at the left of the tab bar.
- The split-right / split-down controls stay at the right end of the tab bar.
- When the tabs overflow the bar, the tabs scroll horizontally and the `+` and split controls stay visible.
- The new-tab control's behaviour is unchanged: same test id, hover title, Ctrl+Shift+T shortcut and disabled states.

## Capabilities

### New Capabilities

### Modified Capabilities
- `web`: the `Terminal tabs` requirement gains the placement of the tab-bar controls and their visibility when tabs overflow.

## Impact

- `src/web/ui/app.tsx` (terminal tab bar markup, `TabControls`), `src/web/main/styles.css` (tab bar styles).
- Playwright e2e tests under `test/e2e/`.
- No protocol, daemon, hub or dependency changes.
