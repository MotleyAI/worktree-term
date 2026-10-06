## Purpose

The browser UI served by the hub: one tab per repo, a live worktree sidebar, and terminals per worktree that switch instantly, survive reconnects and render within a fixed GPU budget.

## ADDED Requirements

### Requirement: Authentication
On load, a URL fragment `#code=<code>` SHALL be used once to open the session, then removed from the address without a navigation; the token the hub returns SHALL be kept in session storage and used for every later connection. Without a code or stored token, or when the hub refuses the credential, the page SHALL show only a message telling the user to open worktree-term with `wtd ui`, and SHALL forget a refused stored token.

#### Scenario: Code exchanged for the token
- **WHEN** the page is opened with a valid one-time code
- **THEN** it connects, the fragment is removed from the address, and a reload connects again without a code

#### Scenario: No credential
- **WHEN** the page is opened without a code in a fresh browser session
- **THEN** it shows the `wtd ui` message and opens no session

### Requirement: Handshake and stale bundle
The page SHALL send `hello` with its own protocol version and the package version it was built from, and SHALL compare both with the hub's `hello`. On a difference it SHALL reload once for that hub `instance`; if the difference remains after that reload it SHALL show a message saying the UI is outdated and to run `wtd ui`, without reloading again.

#### Scenario: Hub upgraded under an open page
- **WHEN** the hub is replaced by one of another version while the page is open
- **THEN** the page reloads once and then runs the bundle the new hub serves

### Requirement: Reconnect and restore
When its WebSocket closes, the page SHALL show that it is reconnecting and reconnect with backoff from 250 ms doubling up to 5 s. Requests pending to a host SHALL fail when the session closes or the host leaves `connected`. When a host becomes `connected`, the page SHALL compare the instance with the last instance it saw `connected` for that host: if it differs, every terminal of that host SHALL be disposed and its state cleared; in both cases the page SHALL then watch each repo of the host and, once that watch is done, re-attach every terminal of that repo it had attached that is still listed.

#### Scenario: Hub restart keeps terminals
- **WHEN** the hub restarts while the daemon keeps running
- **THEN** the page reconnects and each attached terminal shows the same screen in the same terminal object

#### Scenario: Daemon restart drops terminals
- **WHEN** the local daemon is replaced by a new instance
- **THEN** the old terminals disappear from the page and no output of the new daemon is written into them

### Requirement: Repo tabs
The page SHALL show one tab per repo of each host, in the order the hub lists them, labelled with the repo directory's name, adding leading path segments until labels of the same host are unique, and prefixed `<host>:` for a remote host; the full path SHALL show on hover. A repo whose watch fails SHALL show the error and its path in its tab's area.

#### Scenario: Duplicate names disambiguated
- **WHEN** the repos are `/a/x/app` and `/b/y/app`
- **THEN** the tabs are labelled `x/app` and `y/app`

#### Scenario: Watch failure shown
- **WHEN** a configured repo path is not a repository's main worktree
- **THEN** its tab shows the `not-a-repo` error naming the path

### Requirement: Worktree sidebar
The sidebar SHALL list the selected repo's worktrees in the daemon's order without bare entries, each labelled with its branch, or `<directory name> @ <first 7 digits of head>` when detached, or the directory name when it has no head, with the path on hover. A prunable worktree SHALL be shown greyed and SHALL offer no new terminal. A worktree no longer listed that still has live terminals SHALL be listed after the others, marked as gone, without a checkbox, until its last terminal closes. Each listed worktree SHALL have a checkbox reflecting the daemon's checked state, and toggling it SHALL send `setChecked`. Worktree list changes SHALL show without user action.

#### Scenario: Labels
- **WHEN** worktrees are on branch `feature/x`, detached at `0123456789…` in directory `wt2`, and bare
- **THEN** the sidebar shows `feature/x` and `wt2 @ 0123456`, and no bare entry

#### Scenario: Vanished worktree keeps its terminals
- **WHEN** a worktree with a running terminal is removed with `git worktree remove --force`
- **THEN** it stays listed as gone, its terminal remains usable, and it disappears after the terminal is closed

#### Scenario: Checkbox shared
- **WHEN** a worktree is checked in one page
- **THEN** it shows as checked in another page connected to the same hub

### Requirement: Checked filter
The page SHALL offer a toggle between showing all worktrees and only checked ones, stored per browser across reloads and shared by all repos. With "checked only", the sidebar SHALL list the checked worktrees and the selected worktree.

#### Scenario: Filter persists
- **WHEN** the filter is set to "checked only" and the page is reloaded
- **THEN** the filter is still "checked only" and only checked worktrees are listed

#### Scenario: Selected worktree stays listed
- **WHEN** the selected worktree is unchecked while the filter is "checked only"
- **THEN** it stays listed and selected

### Requirement: Selection
The selected repo tab and each repo's selected worktree SHALL be stored per browser and restored on reload; a repo without a stored selection SHALL select its first listed worktree.

#### Scenario: Selection restored
- **WHEN** a worktree of the second repo is selected and the page is reloaded
- **THEN** the second repo tab and that worktree are selected

### Requirement: Terminal tabs
The terminal area SHALL show the selected worktree's layout tabs, each showing its first terminal, with the layout's active tab shown; live terminals of the worktree missing from its layout SHALL be shown as further tabs. Choosing a tab SHALL show it at once and then store it as active with `setLayout`. Creating a terminal SHALL send `createTerm` with preset `shell`, no command and the size of the terminal area, then add it as a new active tab with `setLayout`. Closing a tab SHALL send `closeTerm`. An exited terminal's tab SHALL show that it exited. A worktree without terminals SHALL show a button to create one; no terminal SHALL be created without the user asking.

#### Scenario: New terminal
- **WHEN** the user creates a terminal in a worktree without terminals
- **THEN** a shell runs in that worktree's directory, its tab is active, and it is listed in the layout of every page

#### Scenario: Terminal without a layout tab still shown
- **WHEN** a live terminal of the worktree is missing from its layout
- **THEN** it is shown as a tab

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
Selecting a worktree SHALL show its active terminals and hide the previous ones without waiting for any reply, fit the shown terminals to the area, send `setVisible` with the host's shown terminals, and send `resize` for each shown terminal whose size changed. It SHALL send no request that has a `req`. Resizing the window SHALL fit and resize the shown terminals.

#### Scenario: Switch sends no request
- **WHEN** the user switches between two worktrees whose terminals were already viewed
- **THEN** the page sends only `setVisible` and `resize` messages

### Requirement: Renderer budget
At most 8 terminals SHALL render with WebGL at any time: the most recently shown ones. Every other terminal SHALL render with the DOM renderer. A terminal SHALL fall back to the DOM renderer when WebGL is unavailable, cannot be started, or its context is lost, and SHALL be eligible for WebGL again when it is next shown.

#### Scenario: Budget held
- **WHEN** terminals in 12 worktrees are viewed one after another
- **THEN** never more than 8 WebGL contexts are live and the 8 most recently shown terminals use WebGL

#### Scenario: Context loss
- **WHEN** a shown terminal's WebGL context is lost
- **THEN** it keeps rendering with the DOM renderer and still shows its screen

### Requirement: Outdated host
For an `outdated` host the page SHALL show that its daemon is outdated, with an action to restart it that first asks for confirmation stating that every terminal on that host will be killed, and then sends `restartDaemon`.

#### Scenario: Restart from the page
- **WHEN** the local host is `outdated` and the user confirms the restart
- **THEN** the daemon is restarted and the host's repos are shown again

### Requirement: Performance budgets
With a repo of 58 worktrees and 2 terminals in each, the median of 20 measured switches SHALL be at most 16 ms between a worktree whose terminals are among the 8 WebGL terminals and at most 50 ms to a worktree whose terminals must start WebGL again, each measured from the input event to just after the first frame painted with the switch applied. A worktree added or removed with git SHALL show in, or leave, the sidebar within 250 ms of the git command finishing.

#### Scenario: Recently viewed switch
- **WHEN** 20 switches between recently viewed worktrees are measured
- **THEN** their median is at most 16 ms

#### Scenario: WebGL reattach switch
- **WHEN** 20 switches to worktrees whose terminals render with the DOM renderer are measured
- **THEN** their median is at most 50 ms

#### Scenario: Sidebar follows git
- **WHEN** `git worktree add` and `git worktree remove` finish
- **THEN** the sidebar reflects each within 250 ms
