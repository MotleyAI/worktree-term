## MODIFIED Requirements

### Requirement: Host paths
The state directory SHALL be `$XDG_STATE_HOME/worktree-term` when `XDG_STATE_HOME` is an absolute path, and `~/.local/state/worktree-term` otherwise. Under it, `run/<host>.sock` SHALL be the daemon socket, `run/<host>.lock` the start lock, `state.json` the persisted daemon state, `daemon.log` the log of an auto-started daemon, and `memory.log` the daemon's memory log. `<host>` SHALL be the host name with every character outside `[A-Za-z0-9._-]` replaced by `_`. A socket path whose UTF-8 encoding exceeds 107 bytes SHALL be refused with an error naming the path.

#### Scenario: XDG_STATE_HOME honoured
- **WHEN** `XDG_STATE_HOME` is `/tmp/x` and the host name is `box`
- **THEN** the socket path is `/tmp/x/worktree-term/run/box.sock` and the memory log is `/tmp/x/worktree-term/memory.log`

#### Scenario: Relative XDG_STATE_HOME ignored
- **WHEN** `XDG_STATE_HOME` is `rel/dir`
- **THEN** the state directory is `~/.local/state/worktree-term`

#### Scenario: Host name sanitised
- **WHEN** the host name is `my box/1`
- **THEN** the socket file name is `my_box_1.sock`

#### Scenario: Over-long socket path refused
- **WHEN** the socket path encodes to 108 bytes
- **THEN** resolving the socket path fails with an error naming the path

### Requirement: Hub and configuration paths
The configuration directory SHALL be `$XDG_CONFIG_HOME/worktree-term` when `XDG_CONFIG_HOME` is an absolute path, and `~/.config/worktree-term` otherwise, with `config.json` the hub configuration. The daemon's systemd user unit file SHALL be `systemd/user/worktree-term-daemon.service` under `$XDG_CONFIG_HOME` when it is an absolute path, and under `~/.config` otherwise. Under the state directory, `hub-token` SHALL be the hub token, `hub.log` the log of a detached hub, `hub-memory.log` the hub's memory log, `run/hub.lock` and `run/hub.json` the hub start lock and hub record, and `run/ssh-%C` the SSH control path, `%C` standing for the 40 hexadecimal digits SSH substitutes. A control path whose UTF-8 encoding, with `%C` substituted, exceeds 107 bytes SHALL be refused with an error naming the path. Files and directories created for them SHALL be owner-only, as for the daemon's.

#### Scenario: XDG_CONFIG_HOME honoured
- **WHEN** `XDG_CONFIG_HOME` is `/tmp/c`
- **THEN** the configuration file is `/tmp/c/worktree-term/config.json` and the unit file is `/tmp/c/systemd/user/worktree-term-daemon.service`

#### Scenario: Relative XDG_CONFIG_HOME ignored
- **WHEN** `XDG_CONFIG_HOME` is `rel/dir`
- **THEN** the configuration file is `~/.config/worktree-term/config.json`

#### Scenario: Hub memory log path
- **WHEN** `XDG_STATE_HOME` is `/tmp/x`
- **THEN** the hub memory log is `/tmp/x/worktree-term/hub-memory.log`

#### Scenario: Over-long control path refused
- **WHEN** the state directory is so long that the substituted control path encodes to 108 bytes
- **THEN** resolving the control path fails with an error naming the path

## ADDED Requirements

### Requirement: Memory sources
Memory figures SHALL be read as follows, each source independently and each yielding null when its files are absent or unreadable (`ENOENT`, `EACCES`), so that a host without `/proc` or cgroup v2 still yields the others:
- the **process table**: every process of the current user, with its pid, parent pid, session id, resident memory (`VmRSS`) and anonymous resident memory (`RssAnon`) in bytes; on request, a process's `WTD_TERMINAL` environment value and its command line (arguments joined by spaces, at most 200 characters). A process that vanishes while being read SHALL be left out without error.
- the **own cgroup** (cgroup v2): its path, `memory.current`, `memory.peak`, `memory.max`, `memory.high` and `memory.swap.current` (null each when absent, `max` as null), `memory.pressure` `some` and `full` `avg10`, `avg60` and `avg300`, and its member pids.
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

### Requirement: Memory sampling cadence
A memory sampler SHALL take its first sample when it starts. Every 5 s it SHALL check system and own-cgroup memory pressure and system meminfo, and SHALL take a sample when the base interval (60 s, or `WTD_MEMORY_SAMPLE_MS` when that is a positive integer) has passed since the last sample, or when memory is tight: system or own-cgroup `some avg10` at least 10, or `MemAvailable` below 10% of `MemTotal`. The check period SHALL be the base interval when that is shorter than 5 s. A check or sample SHALL start only after the previous one has finished. Its timer SHALL NOT keep the process alive, and once the sampler is stopped it SHALL write nothing more. A failed sample or write SHALL be reported and sampling SHALL continue.

#### Scenario: Calm cadence
- **WHEN** memory is not tight for 3 minutes
- **THEN** samples are taken at start and then 60 s apart

#### Scenario: Tight memory samples often
- **WHEN** system `some avg10` rises to 25 between two calm samples
- **THEN** a sample is taken within 5 s, and further samples every 5 s while it stays at or above 10

#### Scenario: Back to calm
- **WHEN** memory stops being tight
- **THEN** the next sample is taken 60 s after the previous one

#### Scenario: Slow sample
- **WHEN** a sample takes longer than the check period
- **THEN** no second sample starts before it finishes

#### Scenario: Stopped sampler
- **WHEN** the sampler is stopped while a sample is being taken
- **THEN** that sample is not written and nothing is written afterwards

#### Scenario: Write failure
- **WHEN** appending a sample fails
- **THEN** the failure is reported and the next sample is still taken

### Requirement: Rotating line log
A memory log SHALL be appended to one JSON object per line, each line written by a single append of the whole line, to a file created with mode 0600. Before an append that would make the log exceed 16 MiB, the log SHALL be rotated: `<log>.2` renamed to `<log>.3`, `<log>.1` to `<log>.2` and `<log>` to `<log>.1`, missing files skipped and an existing `<log>.3` replaced. A line longer than 16 MiB SHALL still be written, after rotating. A failed rotation SHALL be reported, the line SHALL still be appended, and the rotation SHALL be retried before the next append.

#### Scenario: Rotation at the limit
- **WHEN** a log of 16 MiB less 10 bytes gets a 100-byte line
- **THEN** the previous content is in `<log>.1` and `<log>` holds only the new line

#### Scenario: Three old files kept
- **WHEN** `<log>`, `<log>.1`, `<log>.2` and `<log>.3` exist and the log rotates
- **THEN** the old `<log>.3` is gone, the old `<log>.2` is `<log>.3`, and so on

#### Scenario: Owner-only log
- **WHEN** a memory log is created
- **THEN** it has mode 0600

#### Scenario: Rotation failure recovers
- **WHEN** renaming `<log>` to `<log>.1` fails once
- **THEN** the failure is reported, the line is appended to `<log>`, and the next append rotates and writes
