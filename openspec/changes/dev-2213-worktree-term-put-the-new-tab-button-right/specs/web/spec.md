## MODIFIED Requirements

### Requirement: Terminal tabs
The terminal area SHALL show the selected worktree's layout tabs, each labelled by its first terminal, with the layout's active tab shown and its tab shown in the accent colour; live terminals of the worktree missing from its layout SHALL be shown as further single-pane tabs. Choosing a tab SHALL show it at once and then store it as active with `setLayout`. The tab bar SHALL offer controls to create a new tab, split the focused pane right and split it down, each naming its keyboard shortcut on hover and each starting a new terminal through the preset picker; the new-tab control SHALL sit directly after the last tab, or at the left end of the tab bar when there are no tabs, and the split controls at the tab bar's right end; when the tabs overflow the tab bar they SHALL scroll horizontally while all three controls stay fully visible and usable, without making the tab bar taller; the split controls SHALL be disabled when the focused pane's tab cannot be split further, the new-tab control when the layout holds 64 tabs, and all of them while the host is not `connected`, the worktree is prunable or gone, or no presets have been received. A new tab SHALL send `createTerm` with the chosen preset's name and command and the size of the terminal area, then add the terminal as a new active tab with `setLayout`. A terminal SHALL never be created again because a request failed or the session closed. The tab of a terminal whose process failed, and its pane header in a split, SHALL show that it exited and keep its screen readable until closed; a terminal whose process exited cleanly SHALL leave the tabs of every page, as any closed terminal does. A worktree without terminals SHALL show the presets as choices in the terminal area; no terminal SHALL be created without the user choosing one. When the selected worktree's last terminal closes and the keyboard focus is left on the page body, the choices SHALL take the keyboard focus on their first preset; otherwise showing them SHALL NOT move the keyboard focus.

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

#### Scenario: New-tab control follows the last tab
- **WHEN** the selected worktree shows two tabs and the user opens a third, then closes it
- **THEN** the new-tab control sits directly after the last tab each time, and the split controls stay at the tab bar's right end

#### Scenario: New-tab control without tabs
- **WHEN** the selected worktree has no terminals
- **THEN** the new-tab control sits at the left end of the tab bar and the split controls at its right end

#### Scenario: Overflowing tabs keep the controls visible
- **WHEN** the selected worktree shows more tabs than fit in the tab bar
- **THEN** the tabs scroll horizontally, the tab bar keeps its height, and the new-tab and split controls stay fully visible and clickable at either end of the scroll
