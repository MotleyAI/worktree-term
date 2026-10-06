# platform Specification

## Purpose
Host-level infrastructure shared by daemon, hub and CLI: where worktree-term keeps its files and socket, how it writes files safely, and how a client reaches this host's daemon, starting it when needed.

## Requirements

### Requirement: Host paths
The state directory SHALL be `$XDG_STATE_HOME/worktree-term` when `XDG_STATE_HOME` is an absolute path, and `~/.local/state/worktree-term` otherwise. Under it, `run/<host>.sock` SHALL be the daemon socket, `run/<host>.lock` the start lock, `state.json` the persisted daemon state, and `daemon.log` the log of an auto-started daemon. `<host>` SHALL be the host name with every character outside `[A-Za-z0-9._-]` replaced by `_`. A socket path whose UTF-8 encoding exceeds 107 bytes SHALL be refused with an error naming the path.

#### Scenario: XDG_STATE_HOME honoured
- **WHEN** `XDG_STATE_HOME` is `/tmp/x` and the host name is `box`
- **THEN** the socket path is `/tmp/x/worktree-term/run/box.sock`

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
Dialing SHALL connect to this host's daemon socket. When the socket does not exist or refuses connections, dialing SHALL start the daemon command it was given, detached in its own session with stdin ignored and stdout and stderr appended to `daemon.log` (moved to `daemon.log.1` first when over 1 MiB), and SHALL retry connecting every 50 ms for up to 5 s. If no connection succeeds, dialing SHALL fail with `daemon did not start; see <log path>`.

#### Scenario: Running daemon reused
- **WHEN** a daemon serves the socket and a client dials
- **THEN** the client connects and no daemon is started

#### Scenario: Absent daemon started
- **WHEN** no daemon serves the socket and a client dials
- **THEN** a daemon is started detached, its output goes to `daemon.log`, and the client connects

#### Scenario: Concurrent dials start one daemon
- **WHEN** two clients dial at the same time with no daemon running
- **THEN** both connect to the same daemon instance

#### Scenario: Start failure reported
- **WHEN** the daemon command exits without serving the socket
- **THEN** dialing fails after 5 s with a message naming the log path

### Requirement: Hub and configuration paths
The configuration directory SHALL be `$XDG_CONFIG_HOME/worktree-term` when `XDG_CONFIG_HOME` is an absolute path, and `~/.config/worktree-term` otherwise, with `config.json` the hub configuration. Under the state directory, `hub-token` SHALL be the hub token, `hub.log` the log of a detached hub, and `run/hub.lock` and `run/hub.json` the hub start lock and hub record. Files and directories created for them SHALL be owner-only, as for the daemon's.

#### Scenario: XDG_CONFIG_HOME honoured
- **WHEN** `XDG_CONFIG_HOME` is `/tmp/c`
- **THEN** the configuration file is `/tmp/c/worktree-term/config.json`

#### Scenario: Relative XDG_CONFIG_HOME ignored
- **WHEN** `XDG_CONFIG_HOME` is `rel/dir`
- **THEN** the configuration file is `~/.config/worktree-term/config.json`
