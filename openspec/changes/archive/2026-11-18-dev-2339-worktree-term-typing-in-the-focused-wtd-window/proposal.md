## Why

Keys typed in the focused wtd window often go nowhere until the user clicks into the terminal: after clicking a sidebar row (even a newly selected worktree's), a repo or terminal tab, a pane header button or the page background, or after the window regains the focus. The `Pane focus` requirement already promises the focused pane holds the keyboard, but the page only moves the focus when the shown tab, focused pane or modal state changes, so every other way of losing it is never repaired. Switching repos also has no keyboard shortcut, although it is far more frequent than switching terminal tabs.

## What Changes

- One rule decides whether the current terminal may take the keyboard focus. Three triggers apply it: a pointer click, a key pressed while nothing holds the keyboard, and the window regaining the focus.
- A control the user clicked no longer holds the keyboard; a control focused from the keyboard or by the page still does. Text fields, open menus, pickers and dialogs keep the keyboard as now.
- A key pressed while nothing holds the keyboard reaches the current terminal, the first key included (Enter, arrows, Backspace and Ctrl keys too), except shortcuts, keys being composed with an input method, and Ctrl/Meta keys while text outside the terminals is selected.
- Clicking an unselected worktree's row or a repo tab gives the new current terminal the keyboard focus without a second click.
- **BREAKING** (keyboard): Alt+Left / Alt+Right select the previous / next repo tab; choosing the previous / next terminal tab moves to Ctrl+Shift+Left / Ctrl+Shift+Right.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `web`: `Pane focus` (when the current terminal takes the keyboard focus) and `Keyboard shortcuts` (repo-tab navigation on Alt+Left/Right, terminal-tab navigation on Ctrl+Shift+Left/Right).

## Impact

- `src/web/ui`: new `focus.ts` (the rule, the focus classifier moved from `picker.ts` and `app.tsx`, focus-origin tracking, page-selection classification); `view.ts` (claiming the focus, repo-tab stepping); `keymap.ts` (new bindings); `app.tsx` (uses the moved classifier).
- `src/web/terminals/manager.ts`: a public method forwarding a key event to a terminal.
- `src/web/main/index.ts`: wiring of the click, key and window-focus triggers.
- `README.md` shortcut table.
- No architecture model change: the existing `ui → terminals` and `main → terminals` arrows cover the new calls.
