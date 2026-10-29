# platform Specification

## Purpose
Host-level infrastructure shared by daemon, hub and CLI: where worktree-term keeps its files and socket, how it writes files safely, and how a client reaches this host's daemon, starting it when needed.

## Requirements

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

### Requirement: Owner-only files and directories
The state directory and `run/` SHALL be created with mode 0700; when they already exist, an owner other than the current user SHALL be an error, and a looser mode SHALL be tightened to 0700. Every file created SHALL have mode 0600.

#### Scenario: Directories created owner-only
- **WHEN** the state directory does not exist and is prepared
- **THEN** it and `run/` exist with mode 0700

#### Scenario: Loose directory tightened
- **WHEN** `run/` exists with mode 0755 and is prepared
- **THEN** its mode becomes 0700

#### Scenario: Foreign owner refused
- **WHEN** the state directory is owned by another user
- **THEN** preparing it fails with an error naming the directory

#### Scenario: Files created owner-only
- **WHEN** a file is written atomically or the log is opened
- **THEN** the file has mode 0600

### Requirement: Atomic file writes
A file write SHALL replace the file's content entirely or not at all: a reader SHALL see either the previous content or the new content, and a failed write SHALL leave the previous content intact and no temporary file behind. A completed write SHALL be durable, except that a failure to sync its directory after the file was replaced SHALL NOT fail the write.

#### Scenario: Failed write keeps the old file
- **WHEN** a write fails after part of the new content was written
- **THEN** the file holds its previous content, no temporary file remains, and the error is reported

#### Scenario: Read of a missing file
- **WHEN** a file that does not exist is read
- **THEN** the read yields no content rather than an error

### Requirement: Start lock
The start lock SHALL record the holder's process id and a random nonce. A lock SHALL be considered stale only when its recorded process is not alive; a stale lock SHALL be replaced, and a live one SHALL be waited for, retrying every 50 ms for up to 5 s. Only the holder SHALL release a lock, and only if it still holds its own nonce.

#### Scenario: Stale lock reclaimed
- **WHEN** the lock names a process id that is not alive
- **THEN** acquiring the lock succeeds

#### Scenario: Live holder waited for
- **WHEN** the lock is held by a live process that keeps it for longer than 10 s
- **THEN** a second acquirer does not take the lock and fails after 5 s

### Requirement: Daemon dialing with auto-start
Dialing SHALL connect to this host's daemon socket. When the socket does not exist or refuses connections, dialing SHALL start the daemon: when the daemon's systemd user unit file exists, by running the systemctl command with `--user start worktree-term-daemon.service`; otherwise, or when that command fails, by starting the daemon command it was given, detached in its own session with stdin ignored and stdout and stderr appended to `daemon.log` (moved to `daemon.log.1` first when over 1 MiB). It SHALL then retry connecting every 50 ms for up to 5 s. If no connection succeeds, dialing SHALL fail with `daemon did not start; see <log path>`. The systemctl command SHALL be `$WTD_SYSTEMCTL` when set and non-empty, else `systemctl`.

#### Scenario: Running daemon reused
- **WHEN** a daemon serves the socket and a client dials
- **THEN** the client connects and no daemon is started

#### Scenario: Absent daemon started
- **WHEN** no daemon serves the socket, no unit file exists, and a client dials
- **THEN** a daemon is started detached, its output goes to `daemon.log`, and the client connects

#### Scenario: Absent daemon started through systemd
- **WHEN** the unit file exists, no daemon serves the socket, and a client dials
- **THEN** the systemctl command is run with `--user start worktree-term-daemon.service` and the daemon command is not started directly

#### Scenario: Failing systemctl falls back
- **WHEN** the unit file exists, the systemctl command exits non-zero, and a client dials
- **THEN** the daemon command is started detached and the client connects

#### Scenario: Concurrent dials start one daemon
- **WHEN** two clients dial at the same time with no daemon running
- **THEN** both connect to the same daemon instance

#### Scenario: Start failure reported
- **WHEN** the daemon command exits without serving the socket
- **THEN** dialing fails after 5 s with a message naming the log path

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

### Requirement: SSH command line
The SSH command for an alias SHALL be the SSH program followed by `-o BatchMode=yes -o ConnectTimeout=10 -o ControlMaster=auto -o ControlPersist=10m -o ControlPath=<control path> -o ServerAliveInterval=15 --`, the alias, and the remote command as one argument. The SSH program SHALL be `$WTD_SSH` when set and non-empty, else `ssh`. An alias that is empty, longer than 255 characters, starts with `-`, or contains whitespace or a control character SHALL be refused with an error naming it. Every SSH process the hub or an installer starts SHALL use this command line.

#### Scenario: Options precede the alias
- **WHEN** the SSH command for alias `box` and remote command `"$HOME/.local/bin/wtd" connect` is built
- **THEN** its arguments are the options above, `--`, `box` and `"$HOME/.local/bin/wtd" connect`, in that order

#### Scenario: Option-like alias refused
- **WHEN** the SSH command for alias `-oProxyCommand=touch /tmp/x` is built
- **THEN** building fails with an error naming the alias and nothing is run

### Requirement: Installed layout
An installation SHALL place under the data directory `~/.local/share/worktree-term` a release directory `versions/<version>-<12 random lowercase hex digits>` holding `wtd.mjs`, the web bundle as `web/`, and `node_modules/@homebridge/node-pty-prebuilt-multiarch/` with only that package's `package.json`, `LICENSE`, `lib/` and `prebuilds/`. A release SHALL be assembled under a name starting with `.` in `versions/` and renamed into place once complete, and SHALL never be changed afterwards. The symbolic link `current` in the data directory SHALL then be replaced atomically to point to the new release. Afterwards every release other than the new one and the one `current` pointed to before SHALL be removed. The shim `~/.local/bin/wtd` SHALL be a POSIX shell script that runs the installation's Node, given by absolute path, with `$HOME/.local/share/worktree-term/current/wtd.mjs` and all its arguments, written atomically with mode 0700. The Node SHALL be an absolute path without NUL or newline, of version 20 or later, and the shim SHALL run it correctly whatever other characters its path holds. Directories created for the installation SHALL be owner-only; existing parent directories outside the data directory SHALL be left as they are. A path the installation owns — the data directory and everything below it, the shim, the launcher and the unit file — that exists but is a symbolic link where a directory or file is expected (other than `current`), is of the wrong type, or is owned by another user SHALL make the installation fail naming it, changing nothing.

#### Scenario: Fresh layout
- **WHEN** an installation of version 0.2.0 runs in an empty home
- **THEN** `current` points to `versions/0.2.0-<hex>`, which holds `wtd.mjs`, `web/index.html` and the PTY package's `prebuilds/`, and `~/.local/bin/wtd --version` prints the version

#### Scenario: Same version reinstalled
- **WHEN** version 0.2.0 is installed twice
- **THEN** `current` points to a different release directory than after the first installation, and the first release still exists

#### Scenario: Old releases removed
- **WHEN** three installations run one after the other
- **THEN** only the releases of the second and third remain

#### Scenario: Running release keeps working during a swap
- **WHEN** a process started through the shim keeps running while a new release is installed
- **THEN** that process keeps working and the shim's next run uses the new release

#### Scenario: Unusual Node path
- **WHEN** the Node path contains a space, a single quote, `$` and `%`
- **THEN** the shim runs that Node

#### Scenario: Planted symbolic link refused
- **WHEN** `~/.local/share/worktree-term/versions` is a symbolic link
- **THEN** the installation fails naming that path and nothing is written

### Requirement: Local installation
A local installation SHALL install, as the installed layout states, the bundle of the running `wtd` — its `wtd.mjs`, the web bundle beside it and the PTY package it resolves — using the running Node. It SHALL then write the launcher `~/.local/share/applications/worktree-term.desktop`, owner-only, as a desktop entry of type `Application` named `worktree-term`, not run in a terminal, whose `Exec` runs the shim with `ui`, whose `Icon` is `icon.svg` of the web bundle under `current`, and whose `StartupWMClass` is the window class of the Chrome app window `wtd ui` opens; each value SHALL be escaped as desktop entries require. With the systemd option it SHALL also write the unit file, owner-only, running the shim with `daemon` (escaped as unit files require), with `Restart=on-failure` and installed for `default.target`; run the systemctl command with `--user daemon-reload` and then `--user enable worktree-term-daemon.service`; and start the unit as dialing does only when no daemon serves this host's socket, leaving a running daemon alone. A failing systemctl command SHALL fail the installation naming the command.

#### Scenario: Launcher written
- **WHEN** a local installation runs in a home whose path contains a space
- **THEN** the launcher exists and its `Exec` line, unescaped as desktop entries define, runs the shim with `ui`

#### Scenario: Unit installed and enabled
- **WHEN** a local installation runs with the systemd option and no daemon is running
- **THEN** the unit file exists, the systemctl command was run with daemon-reload, enable and start, and the unit's `ExecStart` runs the shim with `daemon`

#### Scenario: Running daemon left alone
- **WHEN** a local installation runs with the systemd option while a daemon serves the socket
- **THEN** the unit is enabled but not started, and the running daemon keeps its instance

### Requirement: Remote installation
A remote installation SHALL send the bundle of the running `wtd` as one tar archive to the SSH command for the alias, whose remote command SHALL be fixed and contain no quote inside its single-quoted part, so that every common login shell runs it alike. Every value the remote side needs — the version, the Node path given, the install script — SHALL travel inside the archive, never in the command. On the remote host it SHALL refuse a system other than Linux; take the given Node path, refusing it when it is older than 20; without one, take the first Node of version 20 or later among `node` on the command's PATH, the path `$SHELL -l -i -c 'command -v node'` prints between markers, and the Node the installed shim runs, in that order; and install as the installed layout states, without launcher or unit file. It SHALL succeed naming the release and the Node used, and fail with one line naming the cause: the remote installer's message, or else the last non-empty line SSH wrote to standard error.

#### Scenario: Remote installed
- **WHEN** a remote installation runs to a host with Node 22 only in its login shell's PATH
- **THEN** the remote `~/.local/bin/wtd connect` bridges to a daemon of the installed version, run by that Node

#### Scenario: Old Node on the command's PATH passed over
- **WHEN** the command's PATH holds Node 18 and the login shell's PATH holds Node 22
- **THEN** the installation uses the login shell's Node 22

#### Scenario: Hostile Node path is data
- **WHEN** the given Node path is `/opt/n'; touch x; '/node`
- **THEN** no file `x` is created and the installation fails naming that path as not a usable Node

#### Scenario: Missing Node reported
- **WHEN** the remote host has no Node of version 20 or later
- **THEN** the installation fails with a line naming the alias and the missing Node, and the remote layout is unchanged

#### Scenario: Unreachable host reported
- **WHEN** SSH cannot reach the alias
- **THEN** the installation fails with SSH's last error line

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
