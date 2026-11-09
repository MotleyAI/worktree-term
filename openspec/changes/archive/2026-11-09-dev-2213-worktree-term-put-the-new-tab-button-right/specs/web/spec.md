## MODIFIED Requirements

### Requirement: Terminal tabs
The terminal area SHALL show the selected worktree's layout tabs, each labelled by its name, or without a name by its first terminal, with the layout's active tab shown and its tab shown in the accent colour; live terminals of the worktree missing from its layout SHALL be shown as further single-pane tabs. Choosing a tab SHALL show it at once and then store it as active with `setLayout`. The tab bar SHALL offer controls to create a new tab, split the focused pane right and split it down, each naming its keyboard shortcut on hover and each starting a new terminal through the preset picker; the new-tab control SHALL sit directly after the last tab, or at the left end of the tab bar when there are no tabs, and the split controls at the tab bar's right end; when the tabs overflow the tab bar they SHALL scroll horizontally while all three controls stay fully visible and usable, without making the tab bar taller; the split controls SHALL be disabled when the focused pane's tab cannot be split further, the new-tab control when the layout holds 64 tabs, and all of them while the host is not `connected`, the worktree is prunable or gone, or no presets have been received. Double-clicking a tab, outside its close button, SHALL replace its label with a text field holding the label's text without its exit note and marks, selected and focused; keys typed in the field SHALL reach only the field. Enter or the field losing focus SHALL close the field and, unless the trimmed text equals the text it started with, store it, at most 64 characters, as the tab's name with exactly one `setLayout`, an empty text removing the name; Escape SHALL close the field and store nothing. Each edit SHALL end exactly once, however Enter, Escape and the loss of focus follow one another. Renaming a tab missing from the layout SHALL add it to the layout as choosing it does; such a tab SHALL NOT be renamable while the layout holds 64 tabs. A new tab SHALL send `createTerm` with the chosen preset's name and command and the size of the terminal area, then add the terminal as a new active tab with `setLayout`. A terminal SHALL never be created again because a request failed or the session closed. The tab of a terminal whose process failed, and its pane header in a split, SHALL show that it exited and keep its screen readable until closed; a terminal whose process exited cleanly SHALL leave the tabs of every page, as any closed terminal does. A worktree without terminals SHALL show the presets as choices in the terminal area; no terminal SHALL be created without the user choosing one. When the selected worktree's last terminal closes and the keyboard focus is left on the page body, the choices SHALL take the keyboard focus on their first preset; otherwise showing them SHALL NOT move the keyboard focus.

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

#### Scenario: Rename a tab
- **WHEN** the user double-clicks a tab, types "build server" and presses Enter
- **THEN** exactly one `setLayout` names the tab "build server", and the tab is labelled "build server" on every page showing the worktree, and still after a reload

#### Scenario: Rename by leaving the field
- **WHEN** the user double-clicks a tab, types "logs" and clicks elsewhere on the page
- **THEN** the tab is labelled "logs"

#### Scenario: Escape keeps the name
- **WHEN** the user double-clicks a tab named "logs", types "other" and presses Escape
- **THEN** the tab is still labelled "logs" on every page, and no `setLayout` changes its name

#### Scenario: Unchanged label stores no name
- **WHEN** the user double-clicks an unnamed tab of an exited terminal and presses Enter without typing
- **THEN** the tab stays unnamed and its label still shows that it exited

#### Scenario: Clearing the name
- **WHEN** the user double-clicks a tab named "logs", clears the field and presses Enter
- **THEN** the tab is labelled by its first terminal again and the stored tab has no name

#### Scenario: Typing in the field stays in the field
- **WHEN** the user renames a tab and types a space, Ctrl+Shift+T and letters into the field
- **THEN** the characters go into the field, no tab is chosen or created, and the terminal receives no input

#### Scenario: Renaming a tab missing from the layout
- **WHEN** the user renames a tab whose live terminal is missing from the layout
- **THEN** the tab is added to the layout with that name

#### Scenario: Name kept when a pane closes
- **WHEN** one terminal of a split tab named "build" is closed
- **THEN** the remaining tab is still labelled "build"
