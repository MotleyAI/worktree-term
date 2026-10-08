## MODIFIED Requirements

### Requirement: Handshake and stale bundle
The page SHALL send `hello` with its own browser protocol version and the package version it was built from, and SHALL compare both with the hub's `hello`. On a difference it SHALL reload once for that hub `instance`; if the difference remains after that reload it SHALL show a message saying the UI is outdated and to run `wtd ui`, without reloading again.

#### Scenario: Hub upgraded under an open page
- **WHEN** the hub is replaced by one of another version while the page is open
- **THEN** the page reloads once and then runs the bundle the new hub serves

### Requirement: Repo tabs
The page SHALL show one tab per repo of each host, in the order the hub lists them, labelled with the repo directory's name, adding leading path segments until labels of the same host are unique, and prefixed `<host>:` for a remote host; the full path SHALL show on hover. The selected tab SHALL be shown in the accent colour. A repo whose watch fails SHALL show the error and its path in its tab's area. A tab of a host that is not `connected` SHALL show the host's status.

#### Scenario: Duplicate names disambiguated
- **WHEN** the repos are `/a/x/app` and `/b/y/app`
- **THEN** the tabs are labelled `x/app` and `y/app`

#### Scenario: Watch failure shown
- **WHEN** a configured repo path is not a repository's main worktree
- **THEN** its tab shows the `not-a-repo` error naming the path

#### Scenario: Remote tab shows host status
- **WHEN** a remote host `box` with repo `/srv/app` is `reconnecting`
- **THEN** the tab labelled `box:app` shows the status `reconnecting`

### Requirement: Checked filter
The page SHALL offer, for the selected repo, a toggle between showing all worktrees and only checked ones; each repo SHALL keep its own setting, stored per browser across reloads, and a repo without one SHALL show all. With "checked only", the sidebar SHALL list the checked worktrees and the selected worktree. Selecting another repo SHALL show that repo's setting without animating the toggle; only the user's toggling SHALL animate it.

#### Scenario: Filter persists
- **WHEN** the filter is set to "checked only" and the page is reloaded
- **THEN** the filter is still "checked only" and only checked worktrees are listed

#### Scenario: Filter belongs to its repo
- **WHEN** the filter is "checked only" in one repo and another repo is selected
- **THEN** the other repo lists all its worktrees, and turning its filter on and off leaves the first repo's "checked only"

#### Scenario: Switching repos does not animate the toggle
- **WHEN** two repos have different filter settings and the user switches between them
- **THEN** the toggle shows each repo's setting without a transition

#### Scenario: Selected worktree stays listed
- **WHEN** the selected worktree is unchecked while the filter is "checked only"
- **THEN** it stays listed and selected

### Requirement: Terminal tabs
The terminal area SHALL show the selected worktree's layout tabs, each labelled by its first terminal, with the layout's active tab shown and its tab shown in the accent colour; live terminals of the worktree missing from its layout SHALL be shown as further single-pane tabs. Choosing a tab SHALL show it at once and then store it as active with `setLayout`. The tab bar SHALL offer controls to create a new tab, split the focused pane right and split it down, each naming its keyboard shortcut on hover and each starting a new terminal through the preset picker; the split controls SHALL be disabled when the focused pane's tab cannot be split further, the new-tab control when the layout holds 64 tabs, and all of them while the host is not `connected`, the worktree is prunable or gone, or no presets have been received. A new tab SHALL send `createTerm` with the chosen preset's name and command and the size of the terminal area, then add the terminal as a new active tab with `setLayout`. A terminal SHALL never be created again because a request failed or the session closed. An exited terminal's tab, and its pane header in a split, SHALL show that it exited and keep its screen readable until closed. A worktree without terminals SHALL show the presets as choices in the terminal area; no terminal SHALL be created without the user choosing one.

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

### Requirement: Pane focus
Each tab SHALL have one focused pane, kept per page and not stored: the first pane until the user chooses another, the pane the user clicks, a new pane once created, and, when the focused pane's terminal closes, the first pane of the subtree that took its place. In a split, the focused pane's header SHALL be shown in the accent colour. The focused pane SHALL hold the keyboard focus whenever its tab is shown and no picker or dialog is open.

#### Scenario: Focus follows a closed pane's sibling
- **WHEN** the focused pane of a two-pane split is closed
- **THEN** the remaining pane is focused and receives typed input

### Requirement: Attention indicators
Each terminal tab, and each pane of a split, SHALL show one mark for its terminal, the first that applies of: needs input (`state` `input`); exited with failure (a non-zero code or a signal); exited; done (`unseen` with `state` `idle`); new output (`unseen` with `state` `working`); none otherwise. A tab holding several panes SHALL show the first-ranked mark of its terminals. Each worktree row and each repo tab SHALL show the first-ranked mark among the terminals of that worktree or of that repo's worktrees, counting an exited terminal only while it is `unseen`, with the number of terminals per mark on hover. Marks SHALL follow `activity`, `termExited` and terminal list changes without user action.

#### Scenario: Agent waiting in a hidden worktree
- **WHEN** a terminal in a non-selected worktree of a non-selected repo rings the bell
- **THEN** its worktree row and its repo tab show the needs-input mark

#### Scenario: Viewing clears new output
- **WHEN** a hidden terminal prints output and its worktree is then selected
- **THEN** its new-output mark disappears from the tab, the worktree row and the repo tab

#### Scenario: Failed exit
- **WHEN** a hidden terminal's process exits with code 1
- **THEN** its tab shows the failed-exit mark and its worktree row shows it until the terminal is viewed

## ADDED Requirements

### Requirement: Pane headers
A pane SHALL have a header, naming its terminal's preset and id and holding its mark and a close control, only while its tab holds more than one pane; a lone pane's terminal SHALL fill the pane.

#### Scenario: Lone pane without header
- **WHEN** a tab holds one pane
- **THEN** the pane shows no header and its terminal starts at the pane's top

#### Scenario: Split panes with headers
- **WHEN** a single-pane tab is split right
- **THEN** both panes show a header with a close control, and closing one returns the other to a pane without header

### Requirement: Sidebar width
The sidebar's right edge SHALL be a separator that the user can drag, and move by 16 px with the left and right arrow keys when focused, to set the sidebar's width between 160 and 640 px; the terminal area SHALL take the remaining width. The width SHALL be stored per browser when a drag ends or a key moves it and restored on reload; without a stored width, or with a malformed one, it SHALL be 260 px.

#### Scenario: Drag within bounds
- **WHEN** the edge is dragged to 400 px, then to 20 px, then to 5000 px from the sidebar's left
- **THEN** the sidebar is 400 px wide, then 160 px, then 640 px

#### Scenario: Width restored
- **WHEN** the width is set to 384 px and the page is reloaded
- **THEN** the sidebar is 384 px wide

### Requirement: Editing presets
The preset picker and a worktree's preset choices SHALL offer "+ Add preset", opening a form for a name and a command; submitting SHALL trim both, treat an empty command as the login shell (`command` null) and send `addPreset`, closing the form on `done` and showing the refusal in the form otherwise. A blank name, a name of more than 64 characters, a name already taken, or a command of more than 4096 characters SHALL be refused in the form without sending anything; Escape SHALL close the form without sending anything and without closing the picker. While more than one preset exists, each SHALL offer a remove control sending `removePreset` for it; a refusal SHALL be shown on the page. Every list SHALL show the presets the hub last sent, and the picker SHALL stay open while presets are edited.

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
