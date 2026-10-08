# web Specification

## Purpose
The browser UI served by the hub: one tab per repo, a live worktree sidebar, and terminals per worktree that switch instantly, survive reconnects and render within a fixed GPU budget.

## Requirements

### Requirement: Authentication
On load, a URL fragment `#code=<code>` SHALL be used once to open the session, then removed from the address without a navigation; the token the hub returns SHALL be kept in session storage and used for every later connection. Without a code or stored token, or when the hub refuses the credential, the page SHALL show only a message telling the user to open worktree-term with `wtd ui`, and SHALL forget a refused stored token.

#### Scenario: Code exchanged for the token
- **WHEN** the page is opened with a valid one-time code
- **THEN** it connects, the fragment is removed from the address, and a reload connects again without a code

#### Scenario: No credential
- **WHEN** the page is opened without a code in a fresh browser session
- **THEN** it shows the `wtd ui` message and opens no session

### Requirement: Handshake and stale bundle
The page SHALL send `hello` with its own browser protocol version and the package version it was built from, and SHALL compare both with the hub's `hello`. On a difference it SHALL reload once for that hub `instance`; if the difference remains after that reload it SHALL show a message saying the UI is outdated and to run `wtd ui`, without reloading again.

#### Scenario: Hub upgraded under an open page
- **WHEN** the hub is replaced by one of another version while the page is open
- **THEN** the page reloads once and then runs the bundle the new hub serves

### Requirement: Reconnect and restore
When its WebSocket closes, the page SHALL show that it is reconnecting and reconnect with backoff from 250 ms doubling up to 5 s. Requests pending to a host SHALL fail when the session closes or the host leaves `connected`. When a host becomes `connected`, the page SHALL compare the instance with the last instance it saw `connected` for that host: if it differs, every terminal of that host SHALL be disposed and its state cleared; in both cases the page SHALL then watch each repo of the host and, once that watch is done, re-attach every terminal of that repo it had attached that is still listed. While a host stays `connected`, a `hosts` message listing a repo of that host not listed before SHALL make the page watch it, and one no longer listing a repo SHALL make the page unwatch it, drop its state and remove its tab — except that a repo whose terminals the page holds with a live process SHALL keep its tab and state until none is left.

#### Scenario: Hub restart keeps terminals
- **WHEN** the hub restarts while the daemon keeps running
- **THEN** the page reconnects and each attached terminal shows the same screen in the same terminal object

#### Scenario: Daemon restart drops terminals
- **WHEN** the local daemon is replaced by a new instance
- **THEN** the old terminals disappear from the page and no output of the new daemon is written into them

#### Scenario: Remote link loss keeps terminals
- **WHEN** the SSH process of a connected remote host is killed and the host becomes `connected` again with the same instance
- **THEN** each attached terminal of that host shows the same screen in the same terminal object and receives new output

#### Scenario: Repo added elsewhere is watched
- **WHEN** another page adds a repo to a connected host
- **THEN** this page shows the repo's tab with its worktrees

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

### Requirement: Worktree sidebar
The sidebar SHALL list the selected repo's worktrees in the daemon's order without bare entries, each labelled with its branch, or `<directory name> @ <first 7 digits of head>` when detached, or the directory name when it has no head. On hover a worktree SHALL show its path followed by one line `<preset> <id>: <status>` per terminal, or "no terminals", where the status is `waiting for input` (`state` `input`), `running` (`state` `working`), `done` (`state` `idle` and `unseen`), `idle` (`state` `idle`), `exited`, `exited with code <code>` or `killed by <signal>`, the exit taking precedence. A prunable worktree SHALL be shown greyed and SHALL offer no new terminal. A worktree no longer listed that still has live terminals SHALL be listed after the others, marked as gone, without a checkbox, until its last terminal closes. Each listed worktree SHALL have a checkbox reflecting the daemon's checked state, and toggling it SHALL send `setChecked`. Worktree list changes SHALL show without user action.

#### Scenario: Labels
- **WHEN** worktrees are on branch `feature/x`, detached at `0123456789…` in directory `wt2`, and bare
- **THEN** the sidebar shows `feature/x` and `wt2 @ 0123456`, and no bare entry

#### Scenario: Status on hover
- **WHEN** a worktree has a terminal `probe` 3 printing continuously and a terminal `probe` 4 that exited with code 1
- **THEN** hovering it shows its path, `probe 3: running` and `probe 4: exited with code 1`

#### Scenario: Vanished worktree keeps its terminals
- **WHEN** a worktree with a running terminal is removed with `git worktree remove --force`
- **THEN** it stays listed as gone, its terminal remains usable, and it disappears after the terminal is closed

#### Scenario: Checkbox shared
- **WHEN** a worktree is checked in one page
- **THEN** it shows as checked in another page connected to the same hub

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

### Requirement: Selection
The selected repo tab and each repo's selected worktree SHALL be stored per browser and restored on reload; a repo without a stored selection SHALL select its first listed worktree.

#### Scenario: Selection restored
- **WHEN** a worktree of the second repo is selected and the page is reloaded
- **THEN** the second repo tab and that worktree are selected

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

### Requirement: Terminal lifetime
Each terminal SHALL have exactly one terminal object and container in the page, created on the first view of its worktree, which also attaches every terminal of that worktree. The object SHALL never be re-created or removed from the document while its PTY lives — not by switching, renderer changes, reconnects or snapshots — and SHALL be disposed when its terminal is closed or its daemon instance is gone. Hidden terminals SHALL keep receiving output. Each terminal SHALL keep 10000 lines of scrollback, open links in a new window without access to the page, and measure character widths per Unicode 11.

#### Scenario: Identity across switches
- **WHEN** the user switches away from a worktree and back 20 times
- **THEN** each of its terminals is the same object in the same container throughout

#### Scenario: Hidden terminal keeps output
- **WHEN** a hidden terminal prints output and its worktree is shown again
- **THEN** the output is on its screen without a new attach

### Requirement: Attach and acknowledgement
On a snapshot for a terminal the page SHALL clear the terminal, write the snapshot, and expect output from the snapshot's offset; snapshot bytes SHALL NOT be acknowledged. Output SHALL be written in order and acknowledged with the end offset of the output the terminal has finished processing, whenever that is at least `ACK_EVERY` bytes past the last acknowledgement and whenever the terminal has processed everything it received. Acknowledgements SHALL never decrease, and processing that belongs to an earlier attach SHALL never be acknowledged. Output at an offset other than the expected one SHALL make the page attach the terminal again.

#### Scenario: Restore after reload
- **WHEN** a terminal shows a full-screen program and the page is reloaded
- **THEN** the terminal shows the same screen

#### Scenario: Large output completes
- **WHEN** a terminal prints 50 MiB of numbered lines while shown
- **THEN** every line appears once and in order, and the daemon never detaches the page

### Requirement: Lagging terminals
On `detached{reason: lagging}` the page SHALL attach the terminal again immediately if it is shown and the page is visible, and otherwise when it is next shown or the page becomes visible.

#### Scenario: Re-attach on show
- **WHEN** a hidden terminal is detached as lagging and its worktree is then shown
- **THEN** the terminal is attached again and shows the current screen

### Requirement: Worktree switching
Selecting a worktree SHALL show every pane of its active tab and hide the previous ones without waiting for any reply, fit each shown terminal to its pane, send `setVisible` with the host's shown terminals, and, while the page has the focus, send `resize` for each shown terminal whose size differs from the last one the page sent. It SHALL send no request that has a `req`. Resizing the window SHALL fit the shown terminals and, while the page has the focus, resize them.

#### Scenario: Switch sends no request
- **WHEN** the user switches between two worktrees whose terminals were already viewed
- **THEN** the page sends only `setVisible` and `resize` messages

#### Scenario: Split tab shown whole
- **WHEN** the user switches to a worktree whose active tab holds three panes
- **THEN** all three terminals are shown, each fitted to its pane, and `setVisible` lists all three

### Requirement: Renderer budget
At most 8 terminals SHALL render with WebGL at any time: the most recently shown ones. Every other terminal SHALL render with the DOM renderer. A terminal SHALL fall back to the DOM renderer when WebGL is unavailable, cannot be started, or its context is lost, and SHALL be eligible for WebGL again when it is next shown.

#### Scenario: Budget held
- **WHEN** terminals in 12 worktrees are viewed one after another
- **THEN** never more than 8 WebGL contexts are live and the 8 most recently shown terminals use WebGL

#### Scenario: Context loss
- **WHEN** a shown terminal's WebGL context is lost
- **THEN** it keeps rendering with the DOM renderer and still shows its screen

### Requirement: Outdated host
For an `outdated` host the page SHALL show that its daemon is outdated, with an action — "Restart daemon" for the local host, "Reinstall & restart" for a remote host — that first asks for confirmation in the page and then sends `restartDaemon` or `reinstallDaemon`. For a `down` remote host it SHALL offer "Install", confirmed the same way, sending `reinstallDaemon`. The confirmation SHALL list the running terminals the page last saw on the daemon instance the host reports — each by worktree label and preset — with the time it last saw them; without such a record it SHALL say that every running terminal on the host will be killed. The page SHALL keep, per host, the running terminals it last saw with their daemon instance in browser storage, keyed separately for the local host and for each remote host name, at most 256 terminals per host; unavailable storage SHALL only lose the list. A failed action SHALL show its error on the page.

#### Scenario: Restart from the page
- **WHEN** the local host is `outdated` and the user confirms the restart
- **THEN** the daemon is restarted and the host's repos are shown again

#### Scenario: Confirmation names the terminals
- **WHEN** the page saw terminals `claude` on worktree `feat` and `shell` on `main` running on a daemon instance, is reloaded, and that host is then `outdated` with the same instance
- **THEN** the confirmation lists both terminals before anything is sent

#### Scenario: Unknown terminals stated
- **WHEN** a host is `outdated` with an instance the page has no record of
- **THEN** the confirmation says every running terminal on the host will be killed

#### Scenario: Reinstall from the page
- **WHEN** a remote host is `outdated` and the user confirms "Reinstall & restart"
- **THEN** the page sends `reinstallDaemon` and shows the host's repos once it is `connected`

#### Scenario: Cancel sends nothing
- **WHEN** the user cancels the confirmation
- **THEN** no request is sent

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
Each tab SHALL have one focused pane, kept per page and not stored: the first pane until the user chooses another, the pane the user clicks, a new pane once created, and, when the focused pane's terminal closes, the first pane of the subtree that took its place. In a split, the focused pane's header SHALL be shown in the accent colour. The focused pane SHALL hold the keyboard focus whenever its tab is shown and no picker or dialog is open.

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

### Requirement: Host status display
For each host that is `down` or `outdated` the page SHALL show a banner naming the host, its status and its `reason` when present, with the action the outdated host requirement states. A `connecting` or `reconnecting` host SHALL show its status only on its repo tabs.

#### Scenario: Down host banner
- **WHEN** a remote host `box` is `down` with reason `ssh: Could not resolve hostname box`
- **THEN** the page shows a banner naming `box`, `down` and that reason, with an "Install" action

#### Scenario: Recovered host clears the banner
- **WHEN** a `down` host becomes `connected`
- **THEN** its banner disappears

### Requirement: Add repo
The repo tab bar SHALL end with an "Add repo" control opening a dialog with a host selector — listing every host with its status, hosts that are not `connected` disabled, preselecting the host of the selected tab — a list of the repos discovered on the selected host minus those it lists, a filter narrowing that list by substring, and a field for typing an absolute path. Choosing a repo or submitting a path SHALL send `addRepo`; on `done` the dialog SHALL close and the added repo's tab SHALL be selected once the hub lists it; an error SHALL be shown in the dialog. Escape SHALL close the dialog without sending anything.

#### Scenario: Discovered repo added
- **WHEN** the user opens "Add repo", picks a discovered repo of the local host
- **THEN** its tab appears, is selected, and shows its worktrees

#### Scenario: Configured repos not offered
- **WHEN** the local host lists repo `/r/a` and discovery finds `/r/a` and `/r/b`
- **THEN** the dialog offers only `/r/b`

#### Scenario: Typed path refused
- **WHEN** the user submits a typed path that is not a repository's main worktree
- **THEN** the dialog shows the `not-a-repo` error and stays open

### Requirement: Remove repo
Each repo tab SHALL offer a "Remove repo" action that asks for confirmation in the page and then sends `removeRepo`. A `busy` reply SHALL tell the user to close the repo's terminals first; on `done` the tab SHALL disappear once the hub no longer lists the repo.

#### Scenario: Repo removed
- **WHEN** the user removes a repo without terminals and confirms
- **THEN** its tab disappears

#### Scenario: Busy repo kept
- **WHEN** the user removes a repo with a terminal and confirms
- **THEN** the tab stays and the page says to close the repo's terminals first

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
The preset picker and a worktree's preset choices SHALL offer "+ Add preset", opening a form for a name and a command; submitting SHALL trim both, treat an empty command as the login shell (`command` null) and send `addPreset`, closing the form on `done` and showing the refusal in the form otherwise. A blank name, a name of more than 64 characters, a name already taken, or a command of more than 4096 characters SHALL be refused in the form without sending anything; Escape SHALL close the form without sending anything and without closing the picker. While more than one preset exists, each SHALL offer a remove control sending `removePreset` for it; a refusal SHALL be shown on the page. While more than one preset exists, each SHALL be draggable to another position, the gap it would be dropped into marked while dragging, and dropping it elsewhere SHALL send `movePreset` with its new position; Alt+Up and Alt+Down SHALL move the highlighted preset one position, which stays highlighted and focused; until the new order arrives, or the move fails, further keyboard moves SHALL be ignored, so each moves the preset that is highlighted. Every list SHALL show the presets the hub last sent, and the picker SHALL stay open while presets are edited.

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

### Requirement: Deleting worktrees
Right-clicking a worktree SHALL open a menu offering "Delete worktree", disabled with the reason on hover for the main worktree, a locked or gone worktree, or while its host is not `connected`; Escape or a press outside SHALL close the menu. Choosing it SHALL send `removeWorktree` with `force` false. On `done` nothing more SHALL be asked. On `worktreeAtRisk` the page SHALL show an in-page confirmation naming the worktree, listing every reason that applies — the commits not in the base ref, or that there is no `origin/main` to check against; the uncommitted changes, untracked files included; the running terminals that will be closed, by preset and id — and saying that its branch is kept or, for a detached worktree, that its commits not in the base ref become unreachable, naming its head commit; confirming SHALL send `removeWorktree` with `force` true, cancelling SHALL send nothing. A failure SHALL be shown on the page.

#### Scenario: Clean worktree deleted without asking
- **WHEN** the user deletes a worktree whose branch is in `origin/main`, without changes or running terminals
- **THEN** it disappears from the sidebar, its directory is gone and no confirmation was shown

#### Scenario: Every reason listed
- **WHEN** the user deletes a worktree with one commit not in `origin/main`, one untracked file and a running terminal `probe` 5
- **THEN** the confirmation lists "It has 1 commit not in origin/main.", "It has 1 uncommitted change, untracked files included." and "Running terminals will be closed: probe 5."

#### Scenario: Detached worktree
- **WHEN** the user deletes a detached worktree with one commit not in `origin/main`
- **THEN** the confirmation lists that commit, says its commits become unreachable and names its head

#### Scenario: Cancel keeps the worktree
- **WHEN** the user cancels that confirmation
- **THEN** nothing is sent and the worktree and its terminal remain

#### Scenario: Confirm deletes it
- **WHEN** the user confirms it
- **THEN** the worktree disappears, its terminal is closed and its branch remains

#### Scenario: Main worktree
- **WHEN** the user right-clicks the main worktree
- **THEN** "Delete worktree" is disabled and says the main worktree cannot be deleted

### Requirement: Terminal size with several pages
Only a page that has the focus SHALL send `resize`. A page that gains the focus SHALL send `resize` with the size of every terminal it shows, and so SHALL a page for the shown terminals of a host whose link connects again; afterwards it SHALL send a terminal's size only when it differs from the last one it sent. A page without the focus SHALL fit its terminals to its own panes without sending `resize`.

#### Scenario: Background page leaves the size alone
- **WHEN** a second page opens in the background with a smaller window and shows a terminal of the focused page
- **THEN** the PTY keeps the focused page's size

#### Scenario: Focus takes the size over
- **WHEN** the second page gains the focus
- **THEN** the PTY takes the second page's size, and resizing the first page's window while it is in the background does not change it

#### Scenario: Refocus takes it back
- **WHEN** the first page gains the focus again
- **THEN** the PTY takes the first page's current size
