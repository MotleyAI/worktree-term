## MODIFIED Requirements

### Requirement: Terminal tabs
The terminal area SHALL show the selected worktree's layout tabs, each labelled by its name, or without a name by its first terminal, with the layout's active tab shown and its tab shown in the accent colour; live terminals of the worktree missing from its layout SHALL be shown as further single-pane tabs. Choosing a tab SHALL show it at once and then store it as active with `setLayout`. The tab bar SHALL offer controls to create a new tab, split the focused pane right and split it down, each naming its keyboard shortcut on hover and each starting a new terminal through the preset picker; the new-tab control SHALL sit directly after the last tab, or at the left end of the tab bar when there are no tabs, and the split controls at the tab bar's right end; when the tabs overflow the tab bar they SHALL scroll horizontally while all three controls stay fully visible and usable, without making the tab bar taller; the split controls SHALL be disabled when the focused pane's tab cannot be split further, the new-tab control when the layout holds 64 tabs, and all of them while the host is not `connected`, the worktree is prunable or gone, or no presets have been received. Double-clicking a tab, outside its close button, SHALL replace its label with a text field holding the label's text without its exit note and marks, selected and focused; keys typed in the field SHALL reach only the field. Enter or the field losing focus SHALL close the field and, unless the trimmed text equals the text it started with, store it, at most 64 characters, as the tab's name with exactly one `setLayout`, an empty text removing the name; Escape SHALL close the field and store nothing. Each edit SHALL end exactly once, however Enter, Escape and the loss of focus follow one another. Renaming a tab missing from the layout SHALL add it to the layout as choosing it does; such a tab SHALL NOT be renamable while the layout holds 64 tabs. A new tab SHALL send `createTerm` with the chosen preset's name and command and the size of the terminal area, then add the terminal as a new active tab with `setLayout`. A terminal SHALL never be created again because a request failed or the session closed. The tab of a terminal whose process failed, and its pane header in a split, SHALL show that it exited and keep its screen readable until closed; a terminal whose process exited cleanly SHALL leave the tabs of every page, as any closed terminal does. A worktree without terminals SHALL show the presets as choices in the terminal area; no terminal SHALL be created without the user choosing one. Each time a worktree's choices are shown, their first preset SHALL be highlighted. When the choices are shown they SHALL take the keyboard focus, on their highlighted preset, unless the keyboard focus is in a text field of the page other than a terminal; when a picker or dialog over them closes and leaves the keyboard focus on the page body, they SHALL take it again. Showing the choices SHALL NOT otherwise move the keyboard focus.

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

#### Scenario: Choices focused on selection
- **WHEN** the user clicks a worktree without terminals in the sidebar, then presses ArrowDown and Enter
- **THEN** the first preset is highlighted and focused once the choices are shown, then the second, and exactly one `createTerm` is sent, for the second preset in that worktree

#### Scenario: Choices focused after worktree navigation
- **WHEN** a terminal has the keyboard focus, the user presses Alt+Down onto a worktree without terminals and then presses Enter
- **THEN** the first preset starts as a new terminal of that worktree

#### Scenario: Choices focused after a repo switch
- **WHEN** the user selects a repo tab whose selected worktree has no terminals and then presses Enter
- **THEN** the first preset starts as a new terminal of that worktree

#### Scenario: Each showing starts at the first preset
- **WHEN** the user highlights the second preset in the choices of one worktree without terminals and then selects another worktree without terminals
- **THEN** the other worktree's choices show the first preset highlighted and focused

#### Scenario: Choices focused again after the picker
- **WHEN** the selected worktree has no terminals and the user presses Ctrl+Shift+T, then Escape, then Enter
- **THEN** the first preset starts as a new terminal of that worktree

#### Scenario: Choices focused after a close dialog ends by itself
- **WHEN** the close dialog for the only, running, terminal of the selected worktree is open and another page closes that terminal
- **THEN** the dialog closes, the preset choices are shown with their first preset focused, and Enter starts it in that worktree

#### Scenario: Presets arriving after a reconnect leave the search focused
- **WHEN** the selected worktree has no terminals, the keyboard focus is in the worktree search, and the session closes and reconnects
- **THEN** the preset choices are shown again and the search keeps the keyboard focus

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

### Requirement: Preset picker
The page SHALL keep the presets the hub sent for the session and forget them when the session closes. Starting a new terminal SHALL open a picker listing the presets in order, over the terminal area, for the selected worktree and the requested operation; with exactly one preset it SHALL use that preset without showing the picker. Digits 1–9 SHALL choose the preset at that position; arrow keys and Enter SHALL move and choose; Escape or a click outside SHALL cancel without creating anything. The picker SHALL close without creating anything when the selected worktree changes, its host leaves `connected`, the pane it would split closes, or the operation is no longer possible; choosing SHALL check again that the operation is possible. A worktree without terminals SHALL show the same list in the terminal area, choosable by click, digits or arrows and Enter. In either list, the repeats of a held digit or Enter SHALL choose nothing; the repeats of a held arrow key SHALL keep moving.

#### Scenario: Held Enter starts nothing
- **WHEN** the user focuses the label of a worktree without terminals and holds Enter until it repeats
- **THEN** that worktree is selected, its choices are shown, and no `createTerm` is sent

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

### Requirement: Editing presets
The preset picker and a worktree's preset choices SHALL offer "+ Add preset", opening a form for a name and a command; submitting SHALL trim both, treat an empty command as the login shell (`command` null) and send `addPreset`, closing the form on `done` and showing the refusal in the form otherwise. A blank name, a name of more than 64 characters, a name already taken, or a command of more than 4096 characters SHALL be refused in the form without sending anything; Escape SHALL close the form without sending anything and without closing the picker. While more than one preset exists, each SHALL offer a remove control sending `removePreset` for it; a refusal SHALL be shown on the page. While more than one preset exists, each SHALL be draggable to another position, the gap it would be dropped into marked while dragging, and dropping it elsewhere SHALL send `movePreset` with its new position; in the picker, Alt+Up and Alt+Down SHALL move the highlighted preset one position, which stays highlighted and focused; until the new order arrives, or the move fails, further keyboard moves SHALL be ignored, so each moves the preset that is highlighted. In a worktree's choices, Alt+Up and Alt+Down SHALL act as the worktree shortcuts. Every list SHALL show the presets the hub last sent, and the picker SHALL stay open while presets are edited. A change to the presets SHALL NOT move the keyboard focus out of the add form, and SHALL keep it on the list's highlighted preset when the list had it; closing the add form SHALL return the keyboard focus to the list's highlighted preset.

#### Scenario: Alt+Down in the choices selects the next worktree
- **WHEN** the choices of a worktree without terminals have the keyboard focus and the user presses Alt+Down once
- **THEN** the next listed worktree is selected, exactly one worktree further, and the presets keep their order with no `movePreset` sent

#### Scenario: Add form keeps the focus while presets change
- **WHEN** the add form is open in a worktree's choices with the keyboard focus in its name field and another page moves a preset
- **THEN** the list shows the new order and the name field keeps the keyboard focus

#### Scenario: Escape returns the focus to the list
- **WHEN** the user opens the add form in a worktree's choices, presses Escape and then Enter
- **THEN** the form closes and the first preset starts as a new terminal of that worktree

#### Scenario: Preset added from the choices
- **WHEN** the user adds a preset `echo` with a command in a worktree's preset choices while another page is open
- **THEN** `addPreset` is sent once, both pages list `echo` last, `config.json` lists it, and choosing it runs its command

#### Scenario: Preset added in the picker
- **WHEN** the user adds a preset in the new-tab picker
- **THEN** the picker stays open, lists the new preset, and choosing it opens a terminal running it

#### Scenario: Preset removed
- **WHEN** the user removes one of two presets
- **THEN** `removePreset` is sent, every page lists only the other preset, `config.json` lists only it, and no remove control is offered any more

#### Scenario: Taken name refused in the form
- **WHEN** the user submits a name that a preset already has, or a blank name
- **THEN** the form says why, nothing is sent, and Escape then closes the form

#### Scenario: Preset dragged to the front
- **WHEN** the user drags the second of two presets onto the upper half of the first in a worktree's choices while another page is open
- **THEN** `movePreset` is sent with position 0, and both pages and `config.json` list the dragged preset first

#### Scenario: Quick keyboard moves
- **WHEN** the first of three presets is highlighted and the user presses Alt+Down twice in quick succession
- **THEN** only that preset moves, by one or two positions

#### Scenario: Preset moved with the keyboard
- **WHEN** the second preset is highlighted in the new-tab picker and the user presses Alt+Up and then Enter
- **THEN** it is listed first, still highlighted and focused, and a terminal running it opens

