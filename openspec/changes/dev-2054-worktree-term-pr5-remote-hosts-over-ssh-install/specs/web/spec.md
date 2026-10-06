## MODIFIED Requirements

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
The page SHALL show one tab per repo of each host, in the order the hub lists them, labelled with the repo directory's name, adding leading path segments until labels of the same host are unique, and prefixed `<host>:` for a remote host; the full path SHALL show on hover. A repo whose watch fails SHALL show the error and its path in its tab's area. A tab of a host that is not `connected` SHALL show the host's status.

#### Scenario: Duplicate names disambiguated
- **WHEN** the repos are `/a/x/app` and `/b/y/app`
- **THEN** the tabs are labelled `x/app` and `y/app`

#### Scenario: Watch failure shown
- **WHEN** a configured repo path is not a repository's main worktree
- **THEN** its tab shows the `not-a-repo` error naming the path

#### Scenario: Remote tab shows host status
- **WHEN** a remote host `box` with repo `/srv/app` is `reconnecting`
- **THEN** the tab labelled `box:app` shows the status `reconnecting`

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

## ADDED Requirements

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
