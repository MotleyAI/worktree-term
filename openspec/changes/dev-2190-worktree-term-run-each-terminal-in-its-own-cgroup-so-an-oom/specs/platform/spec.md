## ADDED Requirements

### Requirement: Process scopes
A process SHALL find a **lasting user manager** at most once in its lifetime, as both of: the scope probe — the systemd-run command with `--user --scope --quiet --collect --slice=app-wtd.slice -- true` — exits 0 within 2 s; and the process's own cgroup (the `0::` line of `/proc/self/cgroup`) lies under `/user.slice/user-<uid>.slice/user@<uid>.service/`, or `/var/lib/systemd/linger/<user name>` exists. Otherwise the outcome SHALL name the first reason in one line (the probe's failure, its timeout, or `not under the user manager and not lingering`). A probe still running after 2 s SHALL be killed with `SIGKILL` and reaped before the outcome is given. The systemd-run command SHALL be `$WTD_SYSTEMD_RUN` when set and non-empty, else `systemd-run`; the busctl command `$WTD_BUSCTL` when set and non-empty, else `busctl`; the systemctl command as dialing states. Once the user manager is found lasting, the process SHALL run the scope probe once more with `--expand-environment=no` added after `--collect`; the option is **supported** when that run exits 0 within 2 s.
Every scope SHALL be in the slice `app-wtd.slice`. Its unit name SHALL begin `wtd-<h>-`, `<h>` being the first 8 lowercase hexadecimal digits of the SHA-256 of the state directory path: `wtd-<h>-daemon-<r>.scope` for a daemon, `wtd-<h>-hub-<r>.scope` for a hub, `<r>` being 8 random lowercase hexadecimal digits, and `wtd-<h>-term-<instance>-<termId>.scope` for a terminal, `<instance>` being its daemon's instance id.
A process **entering its scope** SHALL ask the user manager, through the busctl command, to start the transient scope with its own pid as the only member, in that slice, and wait for the start to complete. A process **started in a scope** SHALL be started through the systemd-run command with `--user --scope --quiet --unit=<unit> --slice=app-wtd.slice -p OOMPolicy=kill`, then `--expand-environment=no` when the option is supported, a `-p MemoryHigh=<v>`, `-p MemoryMax=<v>` or `-p MemorySwapMax=<v>` for each memory limit given, `--`, and its command, so that it keeps its pid, environment and arguments as given.
A scope's **outcome** SHALL be read by querying its `ActiveState` and `Result` through the systemctl command every 50 ms until `ActiveState` is `inactive` or `failed`, for up to 2 s; it SHALL be out of memory exactly when `Result` is `oom-kill` by then. A scope found `failed` SHALL then be reset with `reset-failed`. A query that fails or yields output that does not parse SHALL count as not out of memory and SHALL be reported.

#### Scenario: Lasting under the user manager
- **WHEN** a process whose cgroup lies under its user's `user@<uid>.service` finds the scope probe succeeding
- **THEN** it has a lasting user manager

#### Scenario: Session without lingering
- **WHEN** a process in a login session scope, outside `user@<uid>.service`, without a linger file for its user, finds the scope probe succeeding
- **THEN** it has no lasting user manager, the reason saying it is not under the user manager and not lingering

#### Scenario: Lingering session
- **WHEN** a process outside `user@<uid>.service` finds the scope probe succeeding and its user's linger file exists
- **THEN** it has a lasting user manager

#### Scenario: Probe fails
- **WHEN** the systemd-run command exits non-zero, or cannot be started
- **THEN** there is no lasting user manager and the reason names the failure

#### Scenario: Probe hangs
- **WHEN** the systemd-run command does not exit within 2 s
- **THEN** it is killed and reaped, and there is no lasting user manager, the reason naming the timeout

#### Scenario: Started in a scope
- **WHEN** a command is started in a terminal scope with limits `max` `64M` and `swapMax` `0`
- **THEN** its process runs with its own pid in the unit's cgroup under `app-wtd.slice`, whose `memory.max` is 67108864, `memory.swap.max` 0 and `memory.oom.group` 1

#### Scenario: Command arguments kept as given
- **WHEN** a command is started in a terminal scope with arguments holding `$$` and `${HOME}`
- **THEN** its process receives them unchanged

#### Scenario: Entering a scope
- **WHEN** a running process enters a hub scope
- **THEN** its cgroup becomes that unit's, under `app-wtd.slice`, named `wtd-<h>-hub-<r>.scope`

#### Scenario: Out-of-memory outcome
- **WHEN** a scope's processes are killed because it exceeded its `memory.max`
- **THEN** its outcome is out of memory and the unit is reset, no longer listed as failed

#### Scenario: Ordinary end
- **WHEN** a scope's only process exits with code 1
- **THEN** its outcome is not out of memory

## MODIFIED Requirements

### Requirement: Memory sources
Memory figures SHALL be read as follows, each source independently and each yielding null when its files are absent or unreadable (`ENOENT`, `EACCES`), so that a host without `/proc` or cgroup v2 still yields the others:
- the **process table**: every process of the current user, with its pid, parent pid, session id, resident memory (`VmRSS`) and anonymous resident memory (`RssAnon`) in bytes; on request, a process's `WTD_TERMINAL` environment value and its command line (arguments joined by spaces, at most 200 characters). A process that vanishes while being read SHALL be left out without error.
- the **own cgroup** (cgroup v2): its path, `memory.current`, `memory.peak`, `memory.max`, `memory.high` and `memory.swap.current` (null each when absent, `max` as null), `memory.pressure` `some` and `full` `avg10`, `avg60` and `avg300`, and its member pids.
- a **process's cgroup** (cgroup v2), on request for a pid: the path named by the `0::` line of its `/proc/<pid>/cgroup`, `memory.current`, `memory.peak`, `memory.high`, `memory.max`, `memory.swap.current` and `memory.swap.max` (null each when absent, `max` as null), `memory.pressure` as for the own cgroup, and the `oom_kill` count of `memory.events`; null when the process is gone.
- the **system**: `/proc/pressure/memory` `some` and `full` `avg10`, `avg60` and `avg300`, and `MemTotal`, `MemAvailable`, `SwapTotal` and `SwapFree` from `/proc/meminfo` in bytes.
Malformed content SHALL be a reported failure of that source, never a coerced value.

#### Scenario: Process table read
- **WHEN** the process table is read while a child of the reader runs `sleep`
- **THEN** it contains the child with its parent pid, session id, and a resident memory above zero

#### Scenario: Process vanishing mid-read
- **WHEN** a process's `stat` exists but its `status` is gone by the time it is read
- **THEN** the table omits that process and reading succeeds

#### Scenario: No cgroup v2
- **WHEN** the reader's cgroup has no `memory.current`
- **THEN** the own-cgroup source yields null and the system source is still read

#### Scenario: No /proc
- **WHEN** `/proc` is absent
- **THEN** the process table and system sources yield null

#### Scenario: Malformed pressure file
- **WHEN** `/proc/pressure/memory` lacks the `some` line
- **THEN** the system pressure is null and the failure is reported

#### Scenario: A process's cgroup
- **WHEN** a process's cgroup is read for a pid whose cgroup has `memory.max` `max` and `memory.events` `oom_kill 2`
- **THEN** it yields that cgroup's path, `max` null and an `oom_kill` count of 2

#### Scenario: Process gone before its cgroup is read
- **WHEN** a process's cgroup is requested for a pid that no longer exists
- **THEN** it yields null without a reported failure
