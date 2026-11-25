## ADDED Requirements

### Requirement: Clone discovery
When its session starts, the page SHALL send `discoverRepos` once for every `connected` host, this machine included, and for every other host once, when it first becomes `connected` in the session; it SHALL NOT discover again in that session. It SHALL watch, once per (host, path), every discovered repo that its host does not list and whose origin is not null and equals the known origin of a listed repo of any host, as soon as both are known, also when that origin becomes known after the discovery reply; it SHALL NOT watch any other discovered repo. Replies to these requests SHALL be told apart from the "Add repo" dialog's by their request ids, and neither SHALL affect the other.

#### Scenario: Remote clone found and watched
- **WHEN** this machine lists `/r/app` with origin `github.com/acme/app`, and discovery on remote host `box` finds `/home/me/src/app` with that origin and `/home/me/src/other` with another
- **THEN** the page watches `/home/me/src/app` on `box` and not `/home/me/src/other`

#### Scenario: Local clone found
- **WHEN** this machine lists `/r/app` and discovery on this machine finds `/r/app-2` with the same origin
- **THEN** the page watches `/r/app-2`

#### Scenario: Host connecting later is discovered once
- **WHEN** remote host `box` is `down` when the session starts, becomes `connected`, drops and connects again
- **THEN** the page sends `discoverRepos` for `box` exactly once, after its first connection

#### Scenario: Origin known after discovery
- **WHEN** discovery on `box` replies before the `repoState` of this machine's listed `/r/app` arrives with the matching origin
- **THEN** the page watches `box`'s matching clone once that `repoState` arrives

#### Scenario: Null origins never match
- **WHEN** a listed repo and a discovered repo both have a null origin
- **THEN** the discovered repo is not watched

#### Scenario: Add repo unaffected
- **WHEN** the "Add repo" dialog's discovery and the session's discovery for the same host are both pending
- **THEN** the dialog shows only its own reply's repos and the session's watches follow only its own reply

### Requirement: Host and clone pills
A row of a remote host's worktree SHALL show, after its label, a pill with the host's name, coloured by a hue derived from the name alone; when the tab holds more than one clone on that host, the pill SHALL read `<host> · <clone>`. A row of a local worktree SHALL show no pill, unless the tab holds more than one clone on this machine, in which case it SHALL show a muted pill reading `<clone>`. A clone's label SHALL be its directory name, adding leading path segments until the labels of that host's clones in the tab are unique. While a row's host is `connecting` or `reconnecting` its pill SHALL be dimmed, and while it is `down`, `outdated` or `needs-login` the pill SHALL be shown in the error colour; the pill's hover text SHALL give the host's name and status. Pills SHALL take no part in the name search, and at the minimum sidebar width the pill SHALL stay visible while the label is truncated.

#### Scenario: Single local clone unchanged
- **WHEN** a tab holds one local clone and no other
- **THEN** its rows show no pill

#### Scenario: Remote rows carry the host
- **WHEN** a tab holds this machine's `/r/app` and remote host `box`'s `/srv/app`
- **THEN** `box`'s rows show a pill `box` and this machine's rows show none

#### Scenario: Several clones on one host
- **WHEN** a tab holds `box`'s `/srv/app` and `/srv/x/app`, and this machine's `/r/app` and `/r/app-2`
- **THEN** `box`'s rows show `box · srv/app` and `box · x/app`, and this machine's rows show `app` and `app-2`

#### Scenario: Same colour everywhere
- **WHEN** rows of `box` appear in two tabs and in two pages
- **THEN** every `box` pill has the same colour

#### Scenario: Host status on the pill
- **WHEN** `box` becomes `reconnecting` and then `down`
- **THEN** its pills are dimmed and then shown in the error colour, and hovering one says `box: down`

## MODIFIED Requirements

### Requirement: Repo tabs
The page SHALL show one tab per repo group. Every repo a host lists SHALL belong to exactly one group: the group of its origin when its origin is known and not null, otherwise a group of its own. A listed repo's origin SHALL be known from its latest `repoState` in the session, and SHALL stay known while its host is not `connected`. A discovered clone SHALL join the group of its origin and SHALL NOT form a group. Tabs SHALL be in the order of each group's first listed member in hub order — the hosts in the hub's order, each host's repos in order — and each tab SHALL be labelled like that member: the repo directory's name, adding leading path segments until the labels of that host's repos are unique, prefixed `<host>:` for a remote host. Hovering a tab SHALL show the path of every repo in its group, prefixed `<host>:` for a remote host. The selected tab SHALL be shown in the accent colour. A listed repo whose watch fails SHALL show the error and its path in its tab's area. A tab whose first listed member's host is not `connected` SHALL show that host's status. A tab's view preferences — its filter switches, name search and selected worktree — SHALL be stored under its group's key, `origin:<origin>` for an origin group and `<host name>:<repo>` for a repo of its own; a preference stored under any other key SHALL be ignored.

#### Scenario: Duplicate names disambiguated
- **WHEN** the repos are `/a/x/app` and `/b/y/app` with different origins
- **THEN** the tabs are labelled `x/app` and `y/app`

#### Scenario: Watch failure shown
- **WHEN** a configured repo path is not a repository's main worktree
- **THEN** its tab shows the `not-a-repo` error naming the path

#### Scenario: Remote tab shows host status
- **WHEN** a remote host `box` with repo `/srv/app` is `reconnecting` and the session has not yet learnt that repo's origin
- **THEN** the tab labelled `box:app` shows the status `reconnecting`

#### Scenario: Same origin, one tab
- **WHEN** this machine lists `/r/app` and remote host `box` lists `/srv/app`, both with origin `github.com/acme/app`
- **THEN** there is one tab, labelled `app`, whose sidebar lists the worktrees of both

#### Scenario: Remote-only repo keeps its tab
- **WHEN** remote hosts `box` and `gpu` list `/srv/api` and `/data/api` with the same origin, which no repo of this machine has
- **THEN** there is one tab, labelled `box:api`, listing the worktrees of both

#### Scenario: Origin-less repos stay apart
- **WHEN** this machine lists `/r/a` and `box` lists `/srv/a`, both without an origin
- **THEN** they have two tabs

#### Scenario: Down host's repo merges once connected
- **WHEN** `box` lists `/srv/app` and is `down` when the page loads, then becomes `connected` and its `repoState` has the origin of this machine's `/r/app`
- **THEN** the tab `box:app` is shown while `box` is down and disappears once `box`'s worktrees appear in the tab `app`

#### Scenario: Merged while reconnecting
- **WHEN** `box`'s `/srv/app` has joined the tab `app` and `box` becomes `reconnecting`
- **THEN** no tab `box:app` appears

#### Scenario: Two listed local clones share a tab
- **WHEN** this machine lists `/r/app` and then `/r/app-2`, both with the same origin
- **THEN** there is one tab, labelled `app`

#### Scenario: Preferences follow the origin
- **WHEN** "Starred" is turned on in the tab of origin `github.com/acme/app`, `config.json` lists another clone of it first, and the page is reloaded
- **THEN** "Starred" is still on in that tab

### Requirement: Selection
The selected repo tab and each tab's selected worktree, identified by its host and path, SHALL be stored per browser and restored on reload. A tab without a stored selection, or whose stored worktree is no longer among the worktrees and gone worktrees of its group, SHALL select the first worktree its filter switches show, else its first worktree, when it is first shown in the page, whenever the user toggles one of its filter switches, and whenever the worktree so selected is no longer among its group's worktrees and gone worktrees; it SHALL keep that worktree selected otherwise, whatever terminal or checked changes occur. When groups merge or split, the selected tab SHALL become the tab whose group now holds the selected worktree, which SHALL stay selected.

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

#### Scenario: Same path on two hosts
- **WHEN** a tab holds this machine's and `box`'s worktrees at the same path `/srv/app`, and `box`'s is selected
- **THEN** only `box`'s row is shown selected, and its terminals are shown

#### Scenario: Merge keeps the selection
- **WHEN** a worktree of the tab `box:app` is selected and that tab's repo joins the tab `app`
- **THEN** the tab `app` is selected with that worktree

### Requirement: Hubs menu
The page header SHALL show a hub menu button when there is at least one remote host: on a home page the session's remote hosts, on a remote page its kept `hubs`. The button SHALL be labelled with the name of the page's own hub: on a home page the local host's name as the hub lists it, on a remote page its `host`. The menu SHALL list "This machine" followed by each such host name in order, marking the page's own hub — "This machine" on a home page, its `host` on a remote page. Picking the marked entry SHALL do nothing. On a home page, picking a host SHALL close the menu and open that host's hub as the hub opening requirement states. On a remote page, picking "This machine" SHALL navigate the tab to `http://127.0.0.1:<home>/`, and picking another host SHALL navigate it to `http://127.0.0.1:<home>/#hub=<name>`. On a home page, a fragment with `hub` SHALL open that host's hub once the session greets; a name no remote host carries SHALL show the status `no host named <name>`.

#### Scenario: Menu lists hubs
- **WHEN** a home page's session lists remote hosts `box` and `gpu`
- **THEN** the Hubs menu lists "This machine", `box` and `gpu`, with "This machine" marked

#### Scenario: Button names the page's hub
- **WHEN** a home page's session lists the local host `laptop` and the remote host `box`, and a remote page for `box` is opened
- **THEN** the home page's button reads `laptop` and the remote page's button reads `box`

#### Scenario: No menu without remote hosts
- **WHEN** a home page's session lists only the local host
- **THEN** the header shows no Hubs menu

#### Scenario: Back home from a remote page
- **WHEN** a remote page with `home` 7417, opened from a home page in the same tab, picks "This machine"
- **THEN** the tab shows the home page on `http://127.0.0.1:7417/`, connected with its stored token

#### Scenario: Switching between remotes goes through home
- **WHEN** a remote page for `box` with `home` 7417 picks `gpu`
- **THEN** the tab navigates to `http://127.0.0.1:7417/#hub=gpu`, which opens `gpu`'s hub

#### Scenario: Opening from the address
- **WHEN** a home page is opened with `#code=<code>&hub=box`
- **THEN** it connects and opens `box`'s hub without any click

#### Scenario: Unknown hub in the address
- **WHEN** a home page is opened with `#hub=nope` and no remote host is named `nope`
- **THEN** the status line shows `no host named nope` and the page stays

#### Scenario: Hubs keep their own tabs
- **WHEN** the home page lists repos `/r/app` and `/r/lib`, and `box`'s own hub lists only `/srv/api`
- **THEN** the remote page for `box` shows only the tab of `/srv/api` and its clones on the hosts `box`'s hub lists

### Requirement: Remove repo
Each repo tab SHALL offer a "Remove repo" action that asks for confirmation in the page, naming every listed repo of its group, prefixed `<host>:` for a remote host, and then sends `removeRepos` with every listed repo of its group. A `busy` reply SHALL tell the user to close the terminals of the repo it names first; any other error SHALL be shown with its message; on `done` the tab SHALL disappear once the hub no longer lists any of them.

#### Scenario: Repo removed
- **WHEN** the user removes a repo without terminals and confirms
- **THEN** its tab disappears

#### Scenario: Busy repo kept
- **WHEN** the user removes a repo with a terminal and confirms
- **THEN** the tab stays and the page says to close the repo's terminals first

#### Scenario: Group removed together
- **WHEN** the tab `app` holds this machine's listed `/r/app`, `box`'s listed `/srv/app` and a discovered clone on `gpu`, and the user removes it and confirms
- **THEN** the confirmation names `/r/app` and `box:/srv/app`, the page sends one `removeRepos` with both, and the tab disappears

### Requirement: Open in editor
The tab bar SHALL offer an "Open in editor" control at its right end, after the split controls, titled `Open in editor (right-click to change the command)` and showing a code-window icon — a window outline with `</>` inside — drawn in the current text colour; when the tabs overflow the tab bar it SHALL stay fully visible and usable. It SHALL be disabled, its title then giving the reason, while no worktree is selected, the selected worktree is prunable or gone, the selected worktree's host is not `connected`, the page is a remote page, no `editor` has been received, or a request it sent has not been answered. Choosing it SHALL send `openEditor{req, host, worktree}` with the selected worktree's host and path and show nothing on `done`. An `error` answer SHALL open a dialog with a Close control: for `editor-missing` it SHALL say "Could not find `<program>`. Install it, or right-click the editor button to set the command of the editor you prefer.", `<program>` being `sshfs` or `fusermount3` when the error's message is exactly that name, else the first word of the editor command the page shows; for any other code it SHALL say "Could not open the editor: <message>" with the error's message, shown as text.

#### Scenario: Control at the right end
- **WHEN** a worktree with three tabs is selected
- **THEN** the "Open in editor" control is the last control of the tab bar, after split right and split down

#### Scenario: Control stays visible on overflow
- **WHEN** the tabs overflow the tab bar
- **THEN** the "Open in editor" control is fully visible and choosing it sends `openEditor`

#### Scenario: Code-window icon
- **WHEN** the page is shown
- **THEN** the control shows the code-window icon and no text glyph

#### Scenario: Opening the selected worktree
- **WHEN** a local worktree at `/r/feat x` is selected and the control is chosen
- **THEN** the page sends `openEditor` with this machine's host and `worktree` `/r/feat x`, and the control is disabled until the answer arrives

#### Scenario: Opening a remote worktree
- **WHEN** a worktree `/srv/app-wt` of the `connected` remote host `box` is selected on a home page and the control is chosen
- **THEN** the page sends `openEditor` with `box`'s host index and `worktree` `/srv/app-wt`

#### Scenario: Disabled without a worktree
- **WHEN** no worktree is selected
- **THEN** the control is disabled and its title says no worktree is selected

#### Scenario: Disabled for remote worktrees
- **WHEN** any worktree is selected on a remote page
- **THEN** the control is disabled and its title says to open the editor from this machine's page

#### Scenario: Disabled while the host is not connected
- **WHEN** a worktree of a remote host that is `reconnecting` is selected
- **THEN** the control is disabled and its title gives the host's status

#### Scenario: Disabled for prunable and gone worktrees
- **WHEN** a prunable worktree, or a gone worktree with live terminals, is selected
- **THEN** the control is disabled

#### Scenario: Missing editor
- **WHEN** the editor command is `kate` and the answer is `error` with code `editor-missing`
- **THEN** a dialog says "Could not find `kate`. Install it, or right-click the editor button to set the command of the editor you prefer."

#### Scenario: Missing mount program
- **WHEN** a remote worktree is opened and the answer is `error` with code `editor-missing` and message `sshfs`
- **THEN** the dialog names `sshfs`

#### Scenario: Other launch failure
- **WHEN** the answer is `error` with code `editor-failed` and message `<b>no</b>`
- **THEN** a dialog says "Could not open the editor: <b>no</b>" with the markup shown as text

### Requirement: Worktree sidebar
The sidebar SHALL list the worktrees of every repo in the selected tab's group — this machine's repos first, then each remote host's in the hub's order, a host's repos in path order, each repo's worktrees in its daemon's order — without bare entries, each row identified by its host and path, each labelled with its branch, or `<directory name> @ <first 7 digits of head>` when detached, or the directory name when it has no head. On hover a worktree SHALL show its path, prefixed `<host>:` for a remote host's worktree, followed by one line `<preset> <id>: <status>` per terminal, or "no terminals", where the status is `waiting for input` (`state` `input`), `running` (`state` `working`), `done` (`state` `idle` and `unseen`), `idle` (`state` `idle`), `exited`, `exited with code <code>`, `killed: out of memory` (an `exit` whose `oom` is true) or `killed by <signal>`, the exit taking precedence. A prunable worktree SHALL be shown greyed and SHALL offer no new terminal. A worktree no longer listed that still has live terminals SHALL be listed after the others, marked as gone, without a checkbox, until its last terminal closes. Each listed worktree SHALL have a checkbox reflecting the daemon's checked state, and toggling it SHALL send `setChecked` to the worktree's host. A primary click anywhere in a worktree's row SHALL select it, except on its checkbox, which only toggles it; a right-click SHALL open the worktree menu without selecting. Enter or Space on a worktree's label SHALL select it. Worktree list changes SHALL show without user action.

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

#### Scenario: The whole row selects
- **WHEN** the user clicks an unselected worktree's row at its top edge, at its bottom edge, in the space right of its label, or just above its checkbox
- **THEN** that worktree is selected

#### Scenario: The checkbox only toggles
- **WHEN** the user clicks an unselected worktree's checkbox
- **THEN** the checkbox toggles and the selected worktree does not change

#### Scenario: Right-click does not select
- **WHEN** the user right-clicks an unselected worktree's row
- **THEN** the worktree menu opens and the selected worktree does not change

#### Scenario: Keyboard selects
- **WHEN** the user focuses an unselected worktree's label and presses Enter, or another's and presses Space
- **THEN** that worktree is selected

#### Scenario: Out-of-memory status on hover
- **WHEN** a worktree has a terminal `tests` 5 whose `exit` has `signal` "SIGKILL" and `oom` true
- **THEN** hovering it shows `tests 5: killed: out of memory`

#### Scenario: Rows of every clone
- **WHEN** the selected tab holds this machine's `/r/app` with worktrees `main` and `feat`, and `box`'s `/srv/app` with worktrees `main` and `fix`
- **THEN** the sidebar lists this machine's `main` and `feat`, then `box`'s `main` and `fix`

#### Scenario: Remote path on hover
- **WHEN** a worktree `/srv/app-fix` of `box` without terminals is hovered
- **THEN** it shows `box:/srv/app-fix` and "no terminals"

#### Scenario: Checkbox goes to the row's host
- **WHEN** the user toggles the checkbox of a `box` row
- **THEN** `setChecked` goes to `box` and only that row changes


### Requirement: Host status display
For each host that is `down` or `outdated` the page SHALL show a banner naming the host, its status and its `reason` when present, with the action the outdated host requirement states. For each host that is `needs-login` the page SHALL show a banner naming the host and saying it needs Tailscale login, with an "Open login link" button that opens the host's `login` URL in a new tab without giving that tab access to the page, and no other action; the tabs it labels SHALL show the status `needs login` and the pills of its rows SHALL show it as the pill requirement states. A `connecting` or `reconnecting` host SHALL show its status only on the tabs it labels and on the pills of its rows.

#### Scenario: Down host banner
- **WHEN** a remote host `box` is `down` with reason `ssh: Could not resolve hostname box`
- **THEN** the page shows a banner naming `box`, `down` and that reason, with an "Install" action

#### Scenario: Recovered host clears the banner
- **WHEN** a `down` host becomes `connected`
- **THEN** its banner disappears

#### Scenario: Needs-login banner with link
- **WHEN** a remote host `box` with repo `/srv/app` is `needs-login` with `login` `https://login.tailscale.com/a/abc123`
- **THEN** the page shows a banner naming `box` with an "Open login link" button linking to that URL in a new tab with no opener, and the tab labelled `box:app` shows `needs login`

#### Scenario: Approved login clears the banner
- **WHEN** a `needs-login` host becomes `connected`
- **THEN** its banner disappears and the tabs it labels show no status

