## MODIFIED Requirements

### Requirement: Terminal creation
`createTerm` SHALL fail with `unknown-worktree` unless the worktree is in the current list of a repo this connection watches, and with `busy` if that repo already has 1024 live terminals. Otherwise the daemon SHALL start `$SHELL -l -i` when `command` is null, or `$SHELL -l -i -c <command>` otherwise (`/bin/sh` when `SHELL` is unset or not absolute), in the worktree directory, with `TERM=xterm-256color`, `COLORTERM=truecolor` and `WTD_TERMINAL=<daemon pid>/<daemon instance>/<terminal id>`, at the requested size. A failure to start SHALL fail with `spawn-failed`. Terminal ids SHALL count up from 1 and never be reused within a daemon instance; an id SHALL be taken before the process is started, so a failed start leaves its id unused. `preset` SHALL be stored and reported as given. The requester SHALL receive `termCreated` with its `req`; every other watcher of the repo SHALL receive `termCreated` with `req` null. Creating a terminal SHALL NOT attach it.

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

## ADDED Requirements

### Requirement: Memory log
While it runs, the daemon SHALL sample memory into `memory.log` as a rotating line log, at the memory sampling cadence, stopping before its shutdown completes. Each line SHALL be a JSON object with:
- `ts` (ISO 8601), `source` `"daemon"`, `pid`, `instance`, `version`, `intervalMs` (the base interval);
- `self`: the daemon's `rss`, `heapTotal`, `heapUsed`, `external` and `arrayBuffers` in bytes;
- `mirrors`: the number of live terminal screen mirrors and their total estimated `bytes`, a mirror's estimate being its normal and alternate buffer lines times its columns times 12;
- `terminals`: per live terminal its `termId`, `repo`, `worktree`, `preset`, shell `pid`, `mirror` (`lines`, `cols`, `bytes`), and its members' and its detached processes' each as a group;
- `escaped`: the 20 escaped groups with the largest `rss`, each with its `tag`, `termId`, and `worktree` and `preset` when this daemon instance closed that terminal (null otherwise), and `escapedOmitted` with the `groups`, `processes`, `rss` and `anon` of the rest;
- `cgroup`: the own cgroup's figures and, as a group, its `others`; null without cgroup v2;
- `system`: the system pressure and meminfo figures, each null when absent.
A group SHALL give `processes`, total `rss` and `anon`, and its largest processes by `rss` (3 for a terminal's members and detached processes, 5 otherwise) each with `pid`, `rss`, `anon` and `command`. Without a process table, the groups SHALL be null and `self` and `mirrors` SHALL still be logged.
Processes of the current user other than the daemon SHALL be placed by the first rule that applies:
1. a **member** of a live terminal is in its session (session id = shell pid) or descends from its shell;
2. a process whose `WTD_TERMINAL` names this daemon's pid and instance and one of its live terminals is **detached** under that terminal;
3. a process whose `WTD_TERMINAL` names another pid that is a running `wtd` daemon belongs to that daemon and is not escaped;
4. any other process with a `WTD_TERMINAL`, and a process in the session of one of the last 256 terminals this daemon closed, is **escaped**, grouped by tag (by the closed terminal's tag for an untagged one);
5. any other member of the daemon's cgroup is among **others**.
A closed terminal SHALL be forgotten once a sample finds none of its processes.

#### Scenario: Terminal tree logged
- **WHEN** a terminal runs `sleep 1000` and a sample is taken
- **THEN** that terminal's record has its `termId`, `worktree` and `preset`, and its members include the `sleep` process with its `rss`

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
