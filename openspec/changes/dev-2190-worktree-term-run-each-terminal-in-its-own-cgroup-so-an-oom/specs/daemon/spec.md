## ADDED Requirements

### Requirement: Daemon placement
Once it holds the start lock and before it serves its socket, the daemon SHALL find whether it has a lasting user manager (see `platform`) and, when it has one and its cgroup is not that of `worktree-term-daemon.service`, enter a daemon scope; however it was started — by dialing, by `wtd daemon` in the foreground, or by a script. A failure to enter SHALL be reported on its standard error and the daemon SHALL run on in its cgroup.

#### Scenario: Auto-started daemon in its own scope
- **WHEN** dialing starts the daemon from a process under the user manager
- **THEN** the serving daemon's cgroup is a `wtd-<h>-daemon-<r>.scope` under `app-wtd.slice`, not the dialing process's cgroup

#### Scenario: Foreground daemon in its own scope
- **WHEN** the user runs `wtd daemon` in a terminal of another daemon
- **THEN** the new daemon's cgroup is a daemon scope, not that terminal's scope

#### Scenario: Daemon unit stays
- **WHEN** the daemon is started as `worktree-term-daemon.service`
- **THEN** its cgroup stays that unit's

#### Scenario: No lasting user manager
- **WHEN** the daemon starts without a lasting user manager
- **THEN** it serves from the cgroup it was started in

### Requirement: Terminal scopes
At start the daemon SHALL write one line to its standard error: `terminal scopes: on` when it has a lasting user manager, else `terminal scopes: off (<reason>)`. While terminal scopes are on, the daemon SHALL start each terminal's process in its terminal scope with the `memory` limits of its `createTerm`, so that every process the terminal starts, detached ones included, belongs to that scope and to no other terminal's; and at start it SHALL reset every failed unit whose name begins `wtd-<h>-term-`. While terminal scopes are off, terminals SHALL start as without scopes and their limits SHALL be ignored, the first `createTerm` with a limit writing `memory limits ignored: terminal scopes are off` to standard error once per daemon. In either case, where `/proc` exists, the shell and every process it starts SHALL have an `oom_score_adj` of at least 500, set before the shell runs.

#### Scenario: Terminal processes in the terminal's scope
- **WHEN** terminal scopes are on and a terminal's shell runs `sleep 1000 &`, `sh -c 'sleep 1001' &` and `setsid sleep 1002 &`
- **THEN** the shell and the three `sleep` processes have that terminal's `wtd-<h>-term-<instance>-<termId>.scope` cgroup, which is neither the daemon's nor another terminal's

#### Scenario: Limits applied
- **WHEN** terminal scopes are on and a terminal is created with `memory` `{max: "64M", swapMax: "0"}`
- **THEN** its scope's `memory.max` is 67108864 and its `memory.swap.max` is 0

#### Scenario: Out-of-memory kill takes one terminal
- **WHEN** terminal scopes are on, terminal A was created with `memory` `{max: "64M", swapMax: "0"}`, terminal B without limits, and A's shell allocates 300 MiB
- **THEN** A's watchers receive `termExited` with `signal` "SIGKILL" and `oom` true, the daemon still answers requests, and B still echoes input

#### Scenario: Scopes off
- **WHEN** the daemon starts while the systemd-run command fails
- **THEN** its standard error has one `terminal scopes: off (…)` line, terminals start and run in the daemon's cgroup, and their `exit` reports `oom` false

#### Scenario: Limits ignored once
- **WHEN** terminal scopes are off and two terminals are created with `memory` limits
- **THEN** both start and standard error has exactly one `memory limits ignored: terminal scopes are off` line

#### Scenario: OOM score raised early
- **WHEN** a terminal is created whose command forks a child at once
- **THEN** the shell and that child each have an `oom_score_adj` of at least 500

#### Scenario: Leftover failed unit reset
- **WHEN** a failed unit `wtd-<h>-term-<old instance>-1.scope` exists and the daemon of that state directory starts with terminal scopes on
- **THEN** the unit is no longer listed as failed

## MODIFIED Requirements

### Requirement: Terminal creation
`createTerm` SHALL fail with `unknown-worktree` unless the worktree is in the current list of a repo this connection watches, and with `busy` if that repo already has 1024 live terminals. Otherwise the daemon SHALL start `$SHELL -l -i` when `command` is null, or `$SHELL -l -i -c <command>` otherwise (`/bin/sh` when `SHELL` is unset or not absolute), in the worktree directory, with `TERM=xterm-256color`, `COLORTERM=truecolor` and `WTD_TERMINAL=<daemon pid>/<daemon instance>/<terminal id>`, at the requested size, applying `memory` as terminal scopes state. A failure to start SHALL fail with `spawn-failed`. Terminal ids SHALL count up from 1 and never be reused within a daemon instance; an id SHALL be taken before the process is started, so a failed start leaves its id unused. `preset` SHALL be stored and reported as given. The requester SHALL receive `termCreated` with its `req`; every other watcher of the repo SHALL receive `termCreated` with `req` null. Creating a terminal SHALL NOT attach it.

#### Scenario: Shell in the worktree
- **WHEN** a client creates a terminal in a worktree, attaches, and types `pwd`
- **THEN** the output shows the worktree path

#### Scenario: Terminal tagged
- **WHEN** a client creates a terminal, attaches, and types `echo $WTD_TERMINAL`
- **THEN** the output is the daemon's pid, its instance id and the terminal's id, separated by `/`

#### Scenario: Failed start leaves a gap
- **WHEN** a terminal is created after an attempt that failed with `spawn-failed`, both after terminal 1
- **THEN** the new terminal's id is 3

#### Scenario: Other watchers learn of the terminal
- **WHEN** client A creates a terminal in a repo that client B also watches
- **THEN** A receives `termCreated` with its `req` and B receives `termCreated` with `req` null

#### Scenario: Unwatched worktree
- **WHEN** a client creates a terminal in a worktree of a repo it does not watch
- **THEN** the request fails with `unknown-worktree`

### Requirement: Terminal lifetime
A terminal SHALL end only by `closeTerm`, by its process exiting, or by `shutdown`; a client disconnecting or unwatching SHALL NOT end it. An exit with code 0 and no signal SHALL be a clean exit; any other exit SHALL be a failed exit. When the process exits, the daemon SHALL first offer every remaining output byte. After a failed exit it SHALL then send `termExited{code, signal, oom}` to the repo's watchers, `signal` being the signal name or null, and the terminal SHALL remain, reporting `exit` with the same `code`, `signal` and `oom`, until closed. `oom` SHALL be true exactly when terminal scopes are on, the process was killed by `SIGKILL` and its scope's outcome is out of memory; the daemon SHALL read that outcome before sending `termExited`. After a clean exit it SHALL close the terminal itself, without sending `termExited`: it SHALL remove the terminal from its layout and send `termClosed` to the repo's watchers, sending `termClosed` even when the changed layout cannot be saved. `closeTerm` SHALL send `SIGHUP` to the terminal's process group and `SIGKILL` 5 s later if it is still alive, never signalling a process after the terminal's process has been reaped; it SHALL remove the terminal from its layout, send `termClosed` to the repo's watchers, then reply `done`.

#### Scenario: Client leaves, terminal stays
- **WHEN** the only attached client disconnects and a new client attaches later
- **THEN** the terminal is still running and its output produced meanwhile is in the snapshot

#### Scenario: Exit after a final burst
- **WHEN** a terminal's process writes 1 MiB and exits immediately with code 1
- **THEN** an attached client receives all of it before `termExited`

#### Scenario: Clean exit after a final burst
- **WHEN** a terminal's process writes 1 MiB and exits immediately with code 0
- **THEN** an attached client receives all of it before `termClosed`

#### Scenario: Exit code reported
- **WHEN** a terminal's shell runs `exit 3`
- **THEN** watchers receive `termExited` with `code` 3, `signal` null and `oom` false

#### Scenario: Killed by a signal stays
- **WHEN** a terminal's shell is killed by `SIGTERM` sent from outside the daemon
- **THEN** watchers receive `termExited` with `signal` "SIGTERM" and `oom` false, and a client watching the repo afterwards is told of the terminal with that `exit`

#### Scenario: SIGKILL that is no out-of-memory kill
- **WHEN** terminal scopes are on and a terminal's shell is killed by `SIGKILL` sent from outside the daemon
- **THEN** watchers receive `termExited` with `signal` "SIGKILL" and `oom` false

#### Scenario: Out-of-memory exit seen later
- **WHEN** a terminal was killed for lack of memory and a client watches its repo afterwards
- **THEN** that client is told of the terminal with an `exit` whose `oom` is true

#### Scenario: Clean exit closes the terminal
- **WHEN** a terminal's shell runs `exit`
- **THEN** watchers receive `termClosed` and no `termExited`, and a client watching the repo afterwards is not told of the terminal

#### Scenario: Clean exit leaves the layout
- **WHEN** the terminal in one half of a split exits with code 0
- **THEN** watchers receive `layoutChanged` in which the split is replaced by the other half, and then `termClosed`

#### Scenario: Clean exit with a layout that cannot be saved
- **WHEN** a terminal in a layout exits with code 0 and writing the changed layout fails
- **THEN** watchers receive `termClosed`, the stored layout is unchanged, and the failure is reported

#### Scenario: Close kills the process group
- **WHEN** a terminal whose shell started a background child is closed
- **THEN** both processes end and watchers receive `termClosed`

### Requirement: Memory log
While it runs, the daemon SHALL sample memory into `memory.log` as a rotating line log, at the memory sampling cadence, stopping before its shutdown completes. Each sample line SHALL be a JSON object with:
- `ts` (ISO 8601), `source` `"daemon"`, `pid`, `instance`, `version`, `intervalMs` (the base interval);
- `self`: the daemon's `rss`, `heapTotal`, `heapUsed`, `external` and `arrayBuffers` in bytes;
- `mirrors`: the number of live terminal screen mirrors and their total estimated `bytes`, a mirror's estimate being its normal and alternate buffer lines times its columns times 12;
- `terminals`: per live terminal its `termId`, `repo`, `worktree`, `preset`, shell `pid`, `mirror` (`lines`, `cols`, `bytes`), its members' and its detached processes' each as a group, and `scope`;
- `escaped`: the 20 escaped groups with the largest `rss`, each with its `tag`, `termId`, and `worktree` and `preset` when this daemon instance closed that terminal (null otherwise), and `escapedOmitted` with the `groups`, `processes`, `rss` and `anon` of the rest;
- `cgroup`: the own cgroup's figures and, as a group, its `others`; null without cgroup v2;
- `system`: the system pressure and meminfo figures, each null when absent.
A terminal's `scope` SHALL be, when its shell's cgroup is its terminal scope, `{unit, current, peak, swapCurrent, high, max, swapMax, pressure, oomKills}` from that process's cgroup (`oomKills` being its `oom_kill` count), and null otherwise.
A group SHALL give `processes`, total `rss` and `anon`, and its largest processes by `rss` (3 for a terminal's members and detached processes, 5 otherwise) each with `pid`, `rss`, `anon` and `command`. Without a process table, the groups SHALL be null and `self` and `mirrors` SHALL still be logged.
Processes of the current user other than the daemon SHALL be placed by the first rule that applies:
1. a **member** of a live terminal is in its session (session id = shell pid) or descends from its shell;
2. a process whose `WTD_TERMINAL` names this daemon's pid and instance and one of its live terminals is **detached** under that terminal;
3. a process whose `WTD_TERMINAL` names another pid that is a running `wtd` daemon belongs to that daemon and is not escaped;
4. any other process with a `WTD_TERMINAL`, and a process in the session of one of the last 256 terminals this daemon closed, is **escaped**, grouped by tag (by the closed terminal's tag for an untagged one);
5. any other member of the daemon's cgroup is among **others**.
A closed terminal SHALL be forgotten once a sample finds none of its processes.
When a terminal exits with `oom` true, the daemon SHALL append the line `{ts, source: "daemon", event: "oom-kill", pid, instance, termId, repo, worktree, preset, unit}` to `memory.log`.

#### Scenario: Terminal tree logged
- **WHEN** a terminal runs `sleep 1000` and a sample is taken
- **THEN** that terminal's record has its `termId`, `worktree` and `preset`, and its members include the `sleep` process with its `rss`

#### Scenario: Terminal scope figures logged
- **WHEN** terminal scopes are on, a terminal created with `memory` `{max: "1G"}` runs `sleep 1000`, and a sample is taken
- **THEN** that terminal's `scope` names its unit, has a `current` above zero and a `max` of 1073741824

#### Scenario: No scope figures without scopes
- **WHEN** terminal scopes are off and a sample is taken
- **THEN** every terminal's `scope` is null

#### Scenario: Out-of-memory kill logged
- **WHEN** a terminal is killed for lack of memory
- **THEN** `memory.log` gets an `oom-kill` line naming its `termId`, `worktree`, `preset` and unit

#### Scenario: setsid child of a closed terminal
- **WHEN** a terminal runs `setsid sleep 1000 &`, is closed, and a sample is taken
- **THEN** the `sleep` is in an `escaped` group with that terminal's `termId` and `worktree`

#### Scenario: Job surviving closeTerm
- **WHEN** a terminal starts a job that ignores `SIGHUP` in its own process group, is closed, and a sample is taken
- **THEN** the job's process is in an `escaped` group with that terminal's `termId`

#### Scenario: Detached child of a live terminal
- **WHEN** a live terminal runs `setsid sleep 1000 &` and a sample is taken
- **THEN** the `sleep` is among that terminal's detached processes and in no `escaped` group

#### Scenario: Escape from an earlier daemon
- **WHEN** a process carries a `WTD_TERMINAL` naming a pid that is no running `wtd` daemon
- **THEN** it is in an `escaped` group with that tag and null `worktree`

#### Scenario: Another running daemon's terminal
- **WHEN** a process carries a `WTD_TERMINAL` naming another running `wtd` daemon and no longer descends from it
- **THEN** it is in no `escaped` group

#### Scenario: Untagged process in a closed terminal's session
- **WHEN** a process without `WTD_TERMINAL` is in the session of a terminal this daemon closed
- **THEN** it is in an `escaped` group with that terminal's tag

#### Scenario: Escaped groups capped
- **WHEN** 25 escaped groups exist
- **THEN** `escaped` holds the 20 with the largest `rss` and `escapedOmitted` counts the other 5

#### Scenario: No process table
- **WHEN** the process table is unavailable
- **THEN** the sample still has `self` and `mirrors`, and its groups are null

#### Scenario: Sampling stops with the daemon
- **WHEN** the daemon shuts down
- **THEN** nothing is appended to `memory.log` after it exits
