## MODIFIED Requirements

### Requirement: Terminal tabs
The terminal area SHALL show the selected worktree's layout tabs, each labelled by its first terminal, with the layout's active tab shown; live terminals of the worktree missing from its layout SHALL be shown as further single-pane tabs. Choosing a tab SHALL show it at once and then store it as active with `setLayout`. The tab bar SHALL offer controls to create a new tab, split the focused pane right and split it down, each naming its keyboard shortcut on hover and each starting a new terminal through the preset picker; the split controls SHALL be disabled when the focused pane's tab cannot be split further, the new-tab control when the layout holds 64 tabs, and all of them while the host is not `connected`, the worktree is prunable or gone, or no presets have been received. A new tab SHALL send `createTerm` with the chosen preset's name and command and the size of the terminal area, then add the terminal as a new active tab with `setLayout`. A terminal SHALL never be created again because a request failed or the session closed. An exited terminal's tab and pane SHALL show that it exited and keep its screen readable until closed. A worktree without terminals SHALL show the presets as choices in the terminal area; no terminal SHALL be created without the user choosing one.

#### Scenario: New terminal
- **WHEN** the user picks a preset in a worktree without terminals
- **THEN** that preset runs in that worktree's directory, its tab is active, and it is listed in the layout of every page

#### Scenario: Terminal without a layout tab still shown
- **WHEN** a live terminal of the worktree is missing from its layout
- **THEN** it is shown as a tab

#### Scenario: Created terminal survives a lost layout write
- **WHEN** the session closes after a terminal is created and before its `setLayout` is answered
- **THEN** after reconnecting the terminal is shown as a tab, and no second terminal was created

#### Scenario: Exited terminal
- **WHEN** the shell in a terminal exits
- **THEN** its tab shows that it exited and its screen stays readable until it is closed

### Requirement: Worktree switching
Selecting a worktree SHALL show every pane of its active tab and hide the previous ones without waiting for any reply, fit each shown terminal to its pane, send `setVisible` with the host's shown terminals, and send `resize` for each shown terminal whose size changed. It SHALL send no request that has a `req`. Resizing the window SHALL fit and resize the shown terminals.

#### Scenario: Switch sends no request
- **WHEN** the user switches between two worktrees whose terminals were already viewed
- **THEN** the page sends only `setVisible` and `resize` messages

#### Scenario: Split tab shown whole
- **WHEN** the user switches to a worktree whose active tab holds three panes
- **THEN** all three terminals are shown, each fitted to its pane, and `setVisible` lists all three

### Requirement: Performance budgets
With a repo of 58 worktrees and 2 terminals in each, the median of 20 measured switches SHALL be at most 16 ms between a worktree whose terminals are among the 8 WebGL terminals and at most 50 ms to a worktree whose terminals must start WebGL again, each measured from the input event to just after the first frame painted with the switch applied. The median of 20 switches to a worktree whose active tab holds 8 panes that must start WebGL again SHALL be at most 100 ms, measured the same way. While a divider of a tab holding 8 panes is dragged, the median time from a pointer move to the first frame painted with the new pane sizes SHALL be at most 16 ms. A worktree added or removed with git SHALL show in, or leave, the sidebar within 250 ms of the git command finishing.

#### Scenario: Recently viewed switch
- **WHEN** 20 switches between recently viewed worktrees are measured
- **THEN** their median is at most 16 ms

#### Scenario: WebGL reattach switch
- **WHEN** 20 switches to worktrees whose terminals render with the DOM renderer are measured
- **THEN** their median is at most 50 ms

#### Scenario: Eight-pane switch
- **WHEN** 20 switches to a worktree whose active tab holds 8 panes rendering with the DOM renderer are measured
- **THEN** their median is at most 100 ms

#### Scenario: Divider drag
- **WHEN** a divider of an 8-pane tab is dragged across 60 pointer moves
- **THEN** the median from pointer move to painted frame is at most 16 ms

#### Scenario: Sidebar follows git
- **WHEN** `git worktree add` and `git worktree remove` finish
- **THEN** the sidebar reflects each within 250 ms

## ADDED Requirements

### Requirement: Split panes
Splitting SHALL start a new terminal through the preset picker, send `createTerm` with the chosen preset's name and command and the size the new pane will have, and, once `termCreated` arrives, take the latest layout, replace the focused pane by a split of direction `right` or `down` with ratio 0.5 holding the focused pane as `a` and the new terminal as `b`, store it with `setLayout`, and focus the new pane. A focused terminal missing from the layout SHALL first get its own tab. A tab SHALL hold at most 8 panes and nest at most 16 levels; a split that would exceed either SHALL not be offered. Every pane of the shown tab SHALL be shown at its share of the terminal area, with a draggable divider between the two sides of each split; dragging SHALL resize the panes as the pointer moves, keep the ratio from 0.05 to 0.95, and store the layout with one `setLayout` when released. A `layoutChanged` for the worktree during a drag SHALL cancel the drag and show the new layout. A layout the page stored that the daemon rejects SHALL be replaced by the last layout the daemon reported. Moving a terminal into or out of a split SHALL NOT re-create its terminal object.

#### Scenario: Split right
- **WHEN** the user splits a single-pane tab right and picks a preset
- **THEN** the tab shows the old terminal on the left and the new one on the right, the new one focused, and every page shows the same split

#### Scenario: Drag persists
- **WHEN** the user drags a divider and releases it
- **THEN** one `setLayout` is sent with the new ratio and a second page shows the new sizes

#### Scenario: Remote change during a drag
- **WHEN** another page closes a pane of the tab while a divider is being dragged
- **THEN** the drag ends and the page shows the layout without the closed pane

#### Scenario: Pane limit
- **WHEN** the focused pane's tab holds 8 panes
- **THEN** the split controls are disabled and the split shortcuts do nothing

#### Scenario: Rejected layout reverts
- **WHEN** a `setLayout` the page sent fails
- **THEN** the page shows the last layout the daemon reported

#### Scenario: Concurrent creation from two pages
- **WHEN** two pages split panes of the same tab at the same time
- **THEN** both new terminals stay visible, each in the layout or as a further tab

### Requirement: Pane focus
Each tab SHALL have one focused pane, kept per page and not stored: the first pane until the user chooses another, the pane the user clicks, a new pane once created, and, when the focused pane's terminal closes, the first pane of the subtree that took its place. The focused pane SHALL be marked and SHALL hold the keyboard focus whenever its tab is shown and no picker or dialog is open.

#### Scenario: Focus follows a closed pane's sibling
- **WHEN** the focused pane of a two-pane split is closed
- **THEN** the remaining pane is focused and receives typed input

### Requirement: Preset picker
The page SHALL keep the presets the hub sent for the session and forget them when the session closes. Starting a new terminal SHALL open a picker listing the presets in order, over the terminal area, for the selected worktree and the requested operation; with exactly one preset it SHALL use that preset without showing the picker. Digits 1–9 SHALL choose the preset at that position; arrow keys and Enter SHALL move and choose; Escape or a click outside SHALL cancel without creating anything. The picker SHALL close without creating anything when the selected worktree changes, its host leaves `connected`, the pane it would split closes, or the operation is no longer possible; choosing SHALL check again that the operation is possible. A worktree without terminals SHALL show the same list in the terminal area, choosable by click, digits or arrows and Enter.

#### Scenario: Picker chooses a preset
- **WHEN** two presets are configured and the user presses Ctrl+Shift+T and then 2
- **THEN** a terminal running the second preset's command opens as a new active tab

#### Scenario: Single preset skips the picker
- **WHEN** only one preset is configured and the user presses Ctrl+Shift+T
- **THEN** a terminal with that preset opens without a picker

#### Scenario: Escape cancels
- **WHEN** the picker is open and the user presses Escape
- **THEN** the picker closes and no `createTerm` is sent

#### Scenario: Worktree switch cancels
- **WHEN** the picker is open and the user selects another worktree
- **THEN** the picker closes and no `createTerm` is sent

### Requirement: Closing terminals
Each pane SHALL have a close control that closes its terminal, and Ctrl+Shift+W SHALL close the focused pane's terminal; a tab's close control SHALL close every terminal of the tab. When any terminal to be closed has not exited, the page SHALL first show a dialog listing those terminals by preset and id and close nothing until the user confirms with its button or Enter; Escape or cancel SHALL close nothing. After confirmation the page SHALL send `closeTerm` for each target still live, treating `unknown-term` as done. The dialog SHALL close by itself when all its targets are gone. When every target has exited, they SHALL close without a dialog.

#### Scenario: Running terminal asks first
- **WHEN** the user presses Ctrl+Shift+W on a pane whose shell is running and then Escape
- **THEN** no `closeTerm` is sent and the terminal keeps running

#### Scenario: Tab close confirmed
- **WHEN** the user closes a tab of two running panes and confirms
- **THEN** both terminals are closed and the tab disappears from every page

#### Scenario: Exited terminal closes at once
- **WHEN** the user closes a pane whose process has exited
- **THEN** it closes without a dialog

#### Scenario: Mixed tab cancelled closes nothing
- **WHEN** the user closes a tab holding one exited and one running pane and cancels
- **THEN** both terminals remain

### Requirement: Keyboard shortcuts
The page SHALL handle these shortcuts whether the keyboard focus is in a terminal or elsewhere on the page, except while a picker or dialog is open or text is being composed with an input method; a handled shortcut SHALL act once per key press, SHALL NOT reach the terminal's program, and SHALL suppress the browser's own action:
- Alt+Up / Alt+Down: select the previous / next worktree as listed in the sidebar under the current filter, doing nothing at either end.
- Alt+Left / Alt+Right: choose the previous / next terminal tab, doing nothing at either end.
- Alt+Shift+Left/Right/Up/Down: focus the pane in that direction — among panes lying wholly beyond the focused pane's edge on that side, the one overlapping it most along the other axis, then the nearest, then the first in the tab's order; nothing when there is none.
- Ctrl+Shift+T: new tab; Ctrl+Shift+D: split right; Ctrl+Shift+E: split down; each through the preset picker and only when the corresponding control is enabled.
- Ctrl+Shift+W: close the focused pane, as specified for closing terminals.
- Ctrl+Shift+C: copy the focused terminal's selection to the clipboard; nothing without a selection; a failed copy SHALL be reported on the page.
- Ctrl+Shift+V: paste the clipboard into the focused terminal as pasted text; the browser's paste SHALL be let through to the terminal.
Holding a navigation shortcut SHALL repeat it; holding any other shortcut SHALL act once.

#### Scenario: Worktree navigation respects the filter
- **WHEN** the filter is "checked only" and the user presses Alt+Down
- **THEN** the next checked worktree is selected, skipping unchecked ones

#### Scenario: Navigation stops at the end
- **WHEN** the last listed worktree is selected and the user presses Alt+Down
- **THEN** the selection does not change

#### Scenario: Tab navigation
- **WHEN** the first of three terminal tabs is active and the user presses Alt+Right twice
- **THEN** the third tab is active

#### Scenario: Pane navigation
- **WHEN** a tab is split right and its right pane split down with ratio 0.3, the top-right pane is focused, and the user presses Alt+Shift+Left and then Alt+Shift+Right
- **THEN** the left pane is focused and then the bottom-right pane, the one overlapping the left pane most

#### Scenario: Shortcut does not reach the program
- **WHEN** a terminal running `cat -v` is focused and the user presses Alt+Up
- **THEN** nothing is echoed by `cat`

#### Scenario: Copy and paste
- **WHEN** the user selects text in a terminal, presses Ctrl+Shift+C, focuses another terminal and presses Ctrl+Shift+V
- **THEN** the selected text is typed into the second terminal

### Requirement: Attention indicators
Each pane and terminal tab SHALL show one mark for its terminal, the first that applies of: needs input (`state` `input`); exited with failure (a non-zero code or a signal); exited; done (`unseen` with `state` `idle`); new output (`unseen` with `state` `working`); none otherwise. A tab holding several panes SHALL show the first-ranked mark of its terminals. Each worktree row and each repo tab SHALL show the first-ranked mark among the terminals of that worktree or of that repo's worktrees, counting an exited terminal only while it is `unseen`, with the number of terminals per mark on hover. Marks SHALL follow `activity`, `termExited` and terminal list changes without user action.

#### Scenario: Agent waiting in a hidden worktree
- **WHEN** a terminal in a non-selected worktree of a non-selected repo rings the bell
- **THEN** its worktree row and its repo tab show the needs-input mark

#### Scenario: Viewing clears new output
- **WHEN** a hidden terminal prints output and its worktree is then selected
- **THEN** its new-output mark disappears from the tab, the worktree row and the repo tab

#### Scenario: Failed exit
- **WHEN** a hidden terminal's process exits with code 1
- **THEN** its tab shows the failed-exit mark and its worktree row shows it until the terminal is viewed

### Requirement: Page visibility
The page SHALL tell each host which of its terminals the page shows: every pane of the shown tab while the page is visible, none while it is hidden. On becoming hidden or being unloaded it SHALL send `setVisible` with no terminals to every host it told of shown terminals; on becoming visible again, and after every host is restored following a reconnect, it SHALL send the terminals it shows.

#### Scenario: Hidden page sees nothing
- **WHEN** the page becomes hidden and a shown terminal then prints output
- **THEN** the terminal's `unseen` becomes true

#### Scenario: Visible again clears
- **WHEN** the page becomes visible again
- **THEN** it sends `setVisible` with the shown terminals and their `unseen` becomes false

#### Scenario: Reconnect restores visibility
- **WHEN** the hub restarts while the page shows a two-pane tab
- **THEN** after the page reconnects the daemon counts both terminals as visible
