## MODIFIED Requirements

### Requirement: Pane focus
Each tab SHALL have one focused pane, kept per page and not stored: the first pane until the user chooses another, the pane the user clicks, a new pane once created, and, when the focused pane's terminal closes, the first pane of the subtree that took its place. In a split, the focused pane's header SHALL be shown in the accent colour. While its tab is shown and no picker or dialog is open, the focused pane's terminal is the current terminal: it SHALL take the keyboard focus when its tab is shown, when it becomes the focused pane and when a picker or dialog closes. Nothing holds the keyboard while the keyboard focus is on the page body or on a control the user clicked, and no text field, open menu, picker or dialog is present to hold it; a control focused from the keyboard or by the page holds it. While nothing holds the keyboard, a pointer click and the window regaining the focus SHALL give the keyboard focus to the current terminal unless text outside the terminals is selected, and a key SHALL reach the current terminal, the first key included, unless it is a keyboard shortcut, is being composed with an input method, or is pressed with Ctrl or Meta while text outside the terminals is selected. Without a current terminal, none of this SHALL move the keyboard focus.

#### Scenario: Focus follows a closed pane's sibling
- **WHEN** the focused pane of a two-pane split is closed
- **THEN** the remaining pane is focused and receives typed input

#### Scenario: Focus follows a cleanly exited pane's sibling
- **WHEN** the user types `exit` in the focused pane of a two-pane split
- **THEN** the remaining pane is focused and receives typed input

#### Scenario: Clicking another worktree focuses its terminal
- **WHEN** a terminal of the selected worktree has the keyboard focus, the user clicks the row of another worktree that has a terminal, and types `echo b` and Enter
- **THEN** the other worktree's current terminal has the keyboard focus and runs `echo b`, without a further click

#### Scenario: Clicking another repo tab focuses its terminal
- **WHEN** the user clicks another repo tab whose selected worktree has a terminal and types text
- **THEN** the text reaches that repo's current terminal

#### Scenario: Typing after clicking the selected worktree's row
- **WHEN** the user clicks the selected worktree's row and types `echo row`
- **THEN** `echo row` reaches the current terminal

#### Scenario: Typing after clicking the active terminal tab
- **WHEN** the user clicks the active terminal tab and types text
- **THEN** the text reaches the current terminal

#### Scenario: Typing after clicking the page background
- **WHEN** the user clicks an empty part of the tab bar and types text
- **THEN** the text reaches the current terminal

#### Scenario: Typing after clicking a disabled control
- **WHEN** the split controls are disabled, the user clicks one and types text
- **THEN** the text reaches the current terminal

#### Scenario: Typing after dragging the sidebar edge
- **WHEN** the user drags the sidebar's right edge to a new width and types text
- **THEN** the text reaches the current terminal

#### Scenario: Typing after the clicked control disappears
- **WHEN** the user closes a tab whose terminal exited with its close control, no dialog is shown, and the user types text
- **THEN** the text reaches the current terminal

#### Scenario: First key not lost
- **WHEN** the keyboard focus is on the page body and the user presses, one at a time, a lower-case letter, an upper-case letter, an arrow key, Backspace, Enter and Ctrl+C
- **THEN** the current terminal's program receives each of those keys exactly once, the first included

#### Scenario: Window refocus
- **WHEN** the keyboard focus is on the page body or on a control the user clicked, the window loses the focus and regains it, and the user types text
- **THEN** the current terminal has the keyboard focus and the text reaches it

#### Scenario: Search keeps its keys
- **WHEN** the worktree search has the keyboard focus and the user types text
- **THEN** the text appears in the search and nothing reaches the current terminal

#### Scenario: Add form keeps its keys
- **WHEN** the add form in the preset picker has the keyboard focus and the user types text
- **THEN** the text appears in the form and nothing reaches the current terminal

#### Scenario: Rename field keeps its keys
- **WHEN** the user double-clicks a terminal tab and types text
- **THEN** the rename field has the keyboard focus with its text selected before typing, the typed text replaces it, and nothing reaches the current terminal

#### Scenario: Open menu keeps its keys
- **WHEN** the Hubs menu is open and the user types a letter
- **THEN** the menu stays open and nothing reaches the current terminal

#### Scenario: A control focused from the keyboard keeps its keys
- **WHEN** the user focuses an inactive terminal tab from the keyboard and presses Enter
- **THEN** that tab is shown with its terminal focused, and no Enter reached the previously focused terminal's program

#### Scenario: Copying selected page text
- **WHEN** the user selects a worktree's name in the sidebar with the pointer and presses Ctrl+C, then types `x`
- **THEN** the name is copied to the clipboard, the current terminal's program receives no Ctrl+C, and `x` reaches the current terminal

#### Scenario: Shortcut while nothing holds the keyboard
- **WHEN** the keyboard focus is on the page body and the user presses Alt+Down
- **THEN** the next worktree is selected, its current terminal has the keyboard focus, and nothing reached any terminal's program

#### Scenario: No current terminal
- **WHEN** the selected worktree has no terminals and the user clicks an empty part of the terminal area
- **THEN** no terminal takes the keyboard focus

### Requirement: Keyboard shortcuts
The page SHALL handle these shortcuts whether the keyboard focus is in a terminal or elsewhere on the page, except while a picker or dialog is open or text is being composed with an input method; a handled shortcut SHALL act once per key press, SHALL NOT reach the terminal's program, and SHALL suppress the browser's own action:
- Alt+Up / Alt+Down: select the previous / next worktree as listed in the sidebar under the current filter, doing nothing at either end.
- Alt+Left / Alt+Right: select the previous / next repo tab in the order the tabs are shown, doing nothing at either end.
- Ctrl+Shift+Left / Ctrl+Shift+Right: choose the previous / next terminal tab, doing nothing at either end.
- Alt+Shift+Left/Right/Up/Down: focus the pane in that direction — among panes lying wholly beyond the focused pane's edge on that side, the one overlapping it most along the other axis, then the nearest, then the first in the tab's order; nothing when there is none.
- Ctrl+Shift+T: new tab; Ctrl+Shift+D: split right; Ctrl+Shift+E: split down; each through the preset picker and only when the corresponding control is enabled.
- Ctrl+Shift+W: close the focused pane, as specified for closing terminals.
- Ctrl+Shift+C: copy the focused terminal's selection to the clipboard; nothing without a selection; a failed copy SHALL be reported on the page.
- Ctrl+Shift+V: paste the clipboard into the focused terminal as pasted text; the browser's paste SHALL be let through to the terminal.
Holding a navigation shortcut (worktree, repo tab, terminal tab or pane) SHALL repeat it; holding any other shortcut SHALL act once.

#### Scenario: Worktree navigation respects the filter
- **WHEN** the filter is "checked only" and the user presses Alt+Down
- **THEN** the next checked worktree is selected, skipping unchecked ones

#### Scenario: Navigation stops at the end
- **WHEN** the last listed worktree is selected and the user presses Alt+Down
- **THEN** the selection does not change

#### Scenario: Navigation keeps the keyboard in the terminal
- **WHEN** a terminal has the keyboard focus and the user presses Alt+Down onto a worktree that has a terminal, then types text
- **THEN** that worktree's current terminal has the keyboard focus and the text reaches it

#### Scenario: Repo navigation
- **WHEN** the first of three repo tabs is selected and the user presses Alt+Right twice, then once more
- **THEN** the third repo tab is selected, its current terminal has the keyboard focus, and the last press changes nothing

#### Scenario: Tab navigation
- **WHEN** the first of three terminal tabs is active and the user presses Ctrl+Shift+Right twice
- **THEN** the third tab is active

#### Scenario: Pane navigation
- **WHEN** a tab is split right and its right pane split down with ratio 0.3, the top-right pane is focused, and the user presses Alt+Shift+Left and then Alt+Shift+Right
- **THEN** the left pane is focused and then the bottom-right pane, the one overlapping the left pane most

#### Scenario: Shortcut does not reach the program
- **WHEN** a terminal running `cat -v` is focused and the user presses Alt+Up, Alt+Left or Ctrl+Shift+Left
- **THEN** nothing is echoed by `cat`

#### Scenario: Copy and paste
- **WHEN** the user selects text in a terminal, presses Ctrl+Shift+C, focuses another terminal and presses Ctrl+Shift+V
- **THEN** the selected text is typed into the second terminal
