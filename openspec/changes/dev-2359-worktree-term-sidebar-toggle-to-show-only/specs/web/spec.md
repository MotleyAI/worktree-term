## RENAMED Requirements

- FROM: `### Requirement: Checked filter`
- TO: `### Requirement: Worktree filters`

## MODIFIED Requirements

### Requirement: Worktree filters
The sidebar header SHALL offer, for the selected repo, two independent switches after the name search: "Starred", with the hover text "Show starred worktrees only", showing only checked worktrees; and directly after it "Open", with the hover text "Show only worktrees with open terminals", showing only worktrees that have at least one terminal in any state, an exited terminal that is still shown included. "Open" SHALL go by the presence of terminals, the condition under which a worktree row shows an attention mark or a hollow ring, not by the mark shown; a gone worktree SHALL count as having terminals. The sidebar SHALL list the worktrees shown by every switch that is on, narrowed by the name search, and the selected worktree. Each repo SHALL keep its own setting for each switch, stored per browser across reloads; a repo without one SHALL have that switch off, and a "Starred" setting stored before "Open" existed SHALL keep applying. The list SHALL follow checked changes and terminals being created and closed, from any page, without user action. Selecting another repo SHALL show that repo's settings without animating the switches; only the user's toggling SHALL animate a switch. "Open"'s on colour SHALL differ from the star's colour and from every attention mark's colour. At the minimum sidebar width both switches SHALL lie wholly inside the sidebar and be usable; the header MAY wrap onto more rows.

#### Scenario: Filter persists
- **WHEN** "Starred" is turned on and the page is reloaded
- **THEN** "Starred" is still on and only checked worktrees are listed

#### Scenario: Filter belongs to its repo
- **WHEN** "Starred" is on in one repo and another repo is selected
- **THEN** the other repo lists all its worktrees, and turning its "Starred" on and off leaves the first repo's "Starred" on

#### Scenario: Switching repos does not animate the toggle
- **WHEN** two repos have different settings for a switch and the user switches between them
- **THEN** that switch shows each repo's setting without a transition, for "Starred" and for "Open" alike

#### Scenario: Selected worktree stays listed
- **WHEN** the selected worktree is unchecked while "Starred" is on
- **THEN** it stays listed and selected

#### Scenario: Open lists worktrees with terminals
- **WHEN** a repo has worktree `a` with a running terminal, `b` with a terminal waiting for input, `c` whose only terminal exited with code 1 and has been viewed, `d` with no terminals, and a gone worktree `e` with a running terminal, `a` is selected and "Open" is turned on
- **THEN** `a`, `b`, `c` and `e` are listed and `d` is not

#### Scenario: Both switches on
- **WHEN** "Starred" and "Open" are on, `a` is checked and has a terminal, `b` is checked without terminals, `c` is unchecked with a terminal, and `d`, which is selected, has neither
- **THEN** only `a` and `d` are listed

#### Scenario: Terminal created from another page
- **WHEN** "Open" is on in one page and another page connected to the same hub creates a terminal in a worktree the first page does not list
- **THEN** the first page lists that worktree

#### Scenario: Last terminal closed from another page
- **WHEN** "Open" is on in one page and another page closes the last terminal of a worktree the first page lists but has not selected
- **THEN** the first page no longer lists that worktree

#### Scenario: Selected worktree keeps its place when its last terminal closes
- **WHEN** "Open" is on and the last terminal of the selected worktree closes
- **THEN** it stays listed and selected, showing the preset choices, until another worktree is selected, after which it is no longer listed

#### Scenario: Selected gone worktree leaves with its last terminal
- **WHEN** "Open" is on and the last terminal of the selected gone worktree closes
- **THEN** that worktree is no longer listed, and the first worktree the switches show, else the first worktree, is selected

#### Scenario: Open persists per repo and keeps "Starred"
- **WHEN** a repo has "Starred" stored as on from before "Open" existed, "Open" is turned on there and the page is reloaded
- **THEN** both switches are on in that repo, another repo shows both off, and turning "Open" off leaves "Starred" on, also after a reload

#### Scenario: Open's colour
- **WHEN** "Open" is on
- **THEN** its colour differs from the star's and from the needs-input, failed-exit, done and new-output marks'

#### Scenario: Narrow sidebar
- **WHEN** the sidebar is 160 px wide
- **THEN** both switches lie wholly inside the sidebar and each toggles when clicked

### Requirement: Selection
The selected repo tab and each repo's selected worktree SHALL be stored per browser and restored on reload. A repo without a stored selection, or whose stored worktree is no longer among its worktrees and gone worktrees, SHALL select the first worktree its filter switches show, else its first worktree, when it is first shown in the page, whenever the user toggles one of its filter switches, and whenever the worktree so selected is no longer among its worktrees and gone worktrees; it SHALL keep that worktree selected otherwise, whatever terminal or checked changes occur.

#### Scenario: Selection restored
- **WHEN** a worktree of the second repo is selected and the page is reloaded
- **THEN** the second repo tab and that worktree are selected

#### Scenario: Default follows the switches
- **WHEN** a repo without a stored selection shows its first worktree, which has no terminals, and the user turns "Open" on
- **THEN** the first worktree with a terminal is selected

#### Scenario: Default stays when its last terminal closes
- **WHEN** a repo without a stored selection has, with "Open" on, selected its first worktree with a terminal, and that worktree's last terminal closes
- **THEN** it stays selected and listed

#### Scenario: Default stays when unchecked
- **WHEN** a repo without a stored selection has, with "Starred" on, selected its first checked worktree, and that worktree is unchecked
- **THEN** it stays selected and listed

### Requirement: Worktree name search
The sidebar header SHALL hold, between its title and the filter switches, a text box for the selected repo: while it holds text, the sidebar SHALL list only the worktrees whose label contains that text, trimmed and ignoring case, that the filter switches also list, and the selected worktree. While it holds text, a control beside it SHALL empty it. Each repo SHALL keep its own text, stored per browser across reloads; a repo without one SHALL list every worktree the filter switches list. The text SHALL play no part in which worktree is selected without a stored selection. When the browser refuses to store a setting of the page, the change SHALL still apply and the page SHALL show that saving failed.

#### Scenario: Search narrows the list
- **WHEN** a repo has worktrees on `feature/login`, `fix/Logout` and `docs`, `feature/login` is selected and the user types `LOG`
- **THEN** the sidebar lists `feature/login` and `fix/Logout` only

#### Scenario: Selected worktree stays listed
- **WHEN** the selected worktree's label does not contain the typed text
- **THEN** it stays listed and selected

#### Scenario: Search belongs to its repo and persists
- **WHEN** text is typed in one repo, another repo is selected and the page is reloaded
- **THEN** the other repo shows an empty box and every worktree its filter switches list, and the first repo shows its text and lists only the matching worktrees and the selected one

#### Scenario: Clear control empties the search
- **WHEN** the user activates the clear control
- **THEN** the box is empty and focused, the clear control is gone, and every worktree the filter switches list is listed, with the selected one, also after a reload

#### Scenario: Search with "checked only"
- **WHEN** the search is `feat` and "Starred" is on
- **THEN** only checked worktrees whose label contains `feat`, and the selected worktree, are listed

#### Scenario: Refused storage write
- **WHEN** the browser refuses to store the search and the user types text
- **THEN** the list is narrowed by the text and the page shows that saving its settings failed

### Requirement: Keyboard shortcuts
The page SHALL handle these shortcuts whether the keyboard focus is in a terminal or elsewhere on the page, except while a picker or dialog is open or text is being composed with an input method; a handled shortcut SHALL act once per key press, SHALL NOT reach the terminal's program, and SHALL suppress the browser's own action:
- Alt+Up / Alt+Down: select the previous / next worktree as the sidebar lists them under the current filter switches and name search, doing nothing at either end.
- Alt+Left / Alt+Right: select the previous / next repo tab in the order the tabs are shown, doing nothing at either end.
- Ctrl+Shift+Left / Ctrl+Shift+Right: choose the previous / next terminal tab, doing nothing at either end.
- Alt+Shift+Left/Right/Up/Down: focus the pane in that direction — among panes lying wholly beyond the focused pane's edge on that side, the one overlapping it most along the other axis, then the nearest, then the first in the tab's order; nothing when there is none.
- Ctrl+Shift+T: new tab; Ctrl+Shift+D: split right; Ctrl+Shift+E: split down; each through the preset picker and only when the corresponding control is enabled.
- Ctrl+Shift+W: close the focused pane, as specified for closing terminals.
- Ctrl+Shift+C: copy the focused terminal's selection to the clipboard; nothing without a selection; a failed copy SHALL be reported on the page.
- Ctrl+Shift+V: paste the clipboard into the focused terminal as pasted text; the browser's paste SHALL be let through to the terminal.
Holding a navigation shortcut (worktree, repo tab, terminal tab or pane) SHALL repeat it; holding any other shortcut SHALL act once.

#### Scenario: Worktree navigation respects the filter
- **WHEN** "Starred" is on and the user presses Alt+Down
- **THEN** the next checked worktree is selected, skipping unchecked ones

#### Scenario: Worktree navigation respects "Open"
- **WHEN** "Open" is on and the user presses Alt+Down
- **THEN** the next worktree with a terminal is selected, skipping worktrees without terminals

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
