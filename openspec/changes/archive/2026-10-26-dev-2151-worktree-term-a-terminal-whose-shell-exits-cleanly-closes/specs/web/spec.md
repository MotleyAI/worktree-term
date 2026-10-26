## MODIFIED Requirements

### Requirement: Terminal tabs
The terminal area SHALL show the selected worktree's layout tabs, each labelled by its first terminal, with the layout's active tab shown and its tab shown in the accent colour; live terminals of the worktree missing from its layout SHALL be shown as further single-pane tabs. Choosing a tab SHALL show it at once and then store it as active with `setLayout`. The tab bar SHALL offer controls to create a new tab, split the focused pane right and split it down, each naming its keyboard shortcut on hover and each starting a new terminal through the preset picker; the split controls SHALL be disabled when the focused pane's tab cannot be split further, the new-tab control when the layout holds 64 tabs, and all of them while the host is not `connected`, the worktree is prunable or gone, or no presets have been received. A new tab SHALL send `createTerm` with the chosen preset's name and command and the size of the terminal area, then add the terminal as a new active tab with `setLayout`. A terminal SHALL never be created again because a request failed or the session closed. The tab of a terminal whose process failed, and its pane header in a split, SHALL show that it exited and keep its screen readable until closed; a terminal whose process exited cleanly SHALL leave the tabs of every page, as any closed terminal does. A worktree without terminals SHALL show the presets as choices in the terminal area; no terminal SHALL be created without the user choosing one. When the selected worktree's last terminal closes and the keyboard focus is left on the page body, the choices SHALL take the keyboard focus on their first preset; otherwise showing them SHALL NOT move the keyboard focus.

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
- **WHEN** the shell in a terminal runs `exit 1`
- **THEN** its tab shows that it exited and its screen stays readable until it is closed

#### Scenario: Clean exit closes the tab
- **WHEN** the shell in one of a worktree's two single-pane tabs runs `exit`
- **THEN** its tab disappears from every page showing the worktree and the remaining tab is shown

#### Scenario: Last terminal leaves the choices
- **WHEN** the user types `exit` in the only terminal of the selected worktree and then presses 1
- **THEN** the preset choices are shown, and the first preset starts as a new terminal of that worktree

#### Scenario: Confirmed close leaves the choices focused
- **WHEN** the user closes the only, running, terminal of the selected worktree, confirms, and then presses 1
- **THEN** the first preset starts as a new terminal of that worktree

#### Scenario: Choices leave the focus elsewhere alone
- **WHEN** the only terminal of the selected worktree exits cleanly while the keyboard focus is in the worktree search
- **THEN** the preset choices are shown and the search keeps the keyboard focus

### Requirement: Pane focus
Each tab SHALL have one focused pane, kept per page and not stored: the first pane until the user chooses another, the pane the user clicks, a new pane once created, and, when the focused pane's terminal closes, the first pane of the subtree that took its place. In a split, the focused pane's header SHALL be shown in the accent colour. The focused pane SHALL hold the keyboard focus whenever its tab is shown and no picker or dialog is open.

#### Scenario: Focus follows a closed pane's sibling
- **WHEN** the focused pane of a two-pane split is closed
- **THEN** the remaining pane is focused and receives typed input

#### Scenario: Focus follows a cleanly exited pane's sibling
- **WHEN** the user types `exit` in the focused pane of a two-pane split
- **THEN** the remaining pane is focused and receives typed input

### Requirement: Closing terminals
Each pane SHALL have a close control that closes its terminal, and Ctrl+Shift+W SHALL close the focused pane's terminal; a tab's close control SHALL close every terminal of the tab. When any terminal to be closed has not exited, the page SHALL first show a dialog listing those terminals by preset and id and close nothing until the user confirms with its button or Enter; Escape or cancel SHALL close nothing. After confirmation the page SHALL send `closeTerm` for each target still live, treating `unknown-term` as done. The dialog SHALL close by itself when all its targets are gone. When every target has exited, they SHALL close without a dialog.

#### Scenario: Running terminal asks first
- **WHEN** the user presses Ctrl+Shift+W on a pane whose shell is running and then Escape
- **THEN** no `closeTerm` is sent and the terminal keeps running

#### Scenario: Tab close confirmed
- **WHEN** the user closes a tab of two running panes and confirms
- **THEN** both terminals are closed and the tab disappears from every page

#### Scenario: Exited terminal closes at once
- **WHEN** the user closes a pane whose process has exited with code 1
- **THEN** it closes without a dialog

#### Scenario: Mixed tab cancelled closes nothing
- **WHEN** the user closes a tab holding one pane whose process exited with code 1 and one running pane, and cancels
- **THEN** both terminals remain

#### Scenario: Dialog closes when its terminal exits cleanly
- **WHEN** the close dialog lists a single running terminal and that terminal's shell exits with code 0
- **THEN** the dialog closes and no `closeTerm` is sent

### Requirement: Attention indicators
Each terminal tab, and each pane of a split, SHALL show one mark for its terminal, the first that applies of: needs input (`state` `input`); exited with failure (the terminal has exited, which only a failed exit leaves visible); done (`unseen` with `state` `idle`); new output (`unseen` with `state` `working`); none otherwise. A tab holding several panes SHALL show the first-ranked mark of its terminals. Each worktree row and each repo tab SHALL show the first-ranked mark among the terminals of that worktree or of that repo's worktrees, counting an exited terminal only while it is `unseen`, with the number of terminals per mark on hover. Marks SHALL follow `activity`, `termExited` and terminal list changes without user action.

#### Scenario: Agent waiting in a hidden worktree
- **WHEN** a terminal in a non-selected worktree of a non-selected repo rings the bell
- **THEN** its worktree row and its repo tab show the needs-input mark

#### Scenario: Viewing clears new output
- **WHEN** a hidden terminal prints output and its worktree is then selected
- **THEN** its new-output mark disappears from the tab, the worktree row and the repo tab

#### Scenario: Failed exit
- **WHEN** a hidden terminal's process exits with code 1
- **THEN** its tab shows the failed-exit mark and its worktree row shows it until the terminal is viewed

#### Scenario: Killed terminal marked failed
- **WHEN** a terminal's shell is killed by a signal sent from outside the daemon
- **THEN** its tab shows the failed-exit mark
