## Purpose

The per-host daemon: it watches the worktrees of the repos its clients ask for, owns PTYs and their screen mirrors independently of any client, persists checkbox and layout state, and serves the protocol to any number of clients over an owner-only unix socket.

## ADDED Requirements

### Requirement: Single instance on an owner-only socket
The daemon SHALL listen only on this host's socket (see `platform`), with mode 0600 inside the 0700 `run/` directory. Binding SHALL happen while holding the start lock: a socket that accepts a connection means a daemon is already running and the new one SHALL refuse to start; a socket that does not exist or refuses connections SHALL be removed and bound anew. On exit the daemon SHALL remove the socket only if the socket file is still the one it bound.

#### Scenario: Socket permissions
- **WHEN** the daemon has started
- **THEN** its socket has mode 0600 and `run/` has mode 0700

#### Scenario: Stale socket replaced
- **WHEN** a socket file exists from a daemon that was killed and a new daemon starts
- **THEN** the new daemon binds the path and serves clients

#### Scenario: Delayed starter not displaced
- **WHEN** a first daemon holding the start lock is suspended before binding and a second daemon starts
- **THEN** the second waits for the lock and does not remove or bind the socket while the first holds it

### Requirement: Handshake and version mismatch
On every new connection the daemon SHALL send `hello` with `protocol` equal to `PROTOCOL_VERSION`, its package version, and an `instance` chosen at random once per process start. If the client's first message is not `hello`, the daemon SHALL send `error{req: null, code: bad-message}` and close. If the client's `hello` carries a different `protocol`, the connection SHALL accept only the frozen `shutdown` message; every other frame, including undecodable ones, SHALL get `error{req: null, code: version-mismatch}`.

#### Scenario: Daemon hello
- **WHEN** a client connects
- **THEN** the first frame it receives is the daemon's `hello` with `protocol` 2

#### Scenario: Message before hello
- **WHEN** a client's first message is a `watchRepo`
- **THEN** the daemon replies `error` with code `bad-message` and closes the connection

#### Scenario: Mismatched client can only shut down
- **WHEN** a client sends `hello` with `protocol` 1, then a `watchRepo`, then `shutdown`
- **THEN** the `watchRepo` gets `error{req: null, code: version-mismatch}` and the `shutdown` stops the daemon

### Requirement: Malformed traffic closes the connection
After the handshake, a stream that fails to decode, a control message that fails to decode, a second `hello`, an output or snapshot frame from a client, or an `ack` beyond the bytes sent SHALL make the daemon send `error{req: null, code: bad-message}` and close that connection. An `ack` at or below the connection's current ack position SHALL be ignored. Closing a connection SHALL NOT affect other connections or any terminal.

#### Scenario: Undecodable message
- **WHEN** a client sends a control frame whose JSON has an extra field
- **THEN** the daemon replies `bad-message` and closes only that connection

#### Scenario: Ack beyond sent bytes
- **WHEN** a client acks an offset beyond the output sent to it for that terminal
- **THEN** the daemon replies `bad-message` and closes the connection

### Requirement: Bounded connection queue
Frames queued to one connection but not yet written to its socket SHALL be bounded at 64 MiB, including snapshots; a connection over the bound SHALL be closed. No snapshot SHALL be produced for a connection while more than `FLOW_HIGH` bytes are queued to it.

#### Scenario: Client that stops reading
- **WHEN** a client attaches to a terminal producing continuous output and stops reading its socket
- **THEN** the daemon's memory for that connection stays bounded and the PTY keeps running for other clients

### Requirement: Repo watching
`watchRepo{repo}` SHALL succeed iff `git worktree list` succeeds for `repo` and `repo` equals the main worktree path it lists, which is a real path; otherwise it SHALL fail with `not-a-repo`. A repo SHALL therefore have exactly one name, shared by every connection. On success the daemon SHALL send `repoState` then `done`; watching an already watched repo SHALL send both again. `repoState` SHALL hold the current worktree list, every live terminal of the repo (including terminals whose worktree has vanished), the repo's checked worktree paths and its layouts. A repo with more than 1024 worktrees SHALL fail with `internal`. `unwatchRepo` for a repo this connection does not watch SHALL fail with `not-watched`; otherwise it SHALL end the subscription and detach this connection from that repo's terminals.

#### Scenario: Watch a repo
- **WHEN** a client watches a repo with two worktrees
- **THEN** it receives `repoState` listing both, with the main worktree marked `main`, then `done`

#### Scenario: Not a repo
- **WHEN** a client watches a directory that is not a git repository
- **THEN** the request fails with `not-a-repo`

#### Scenario: Linked worktree path is not a repo
- **WHEN** a client watches the path of a linked worktree
- **THEN** the request fails with `not-a-repo`

#### Scenario: Alias of a repo is not a repo
- **WHEN** a client watches a repo through a symbolic link or a path with a `.` segment
- **THEN** the request fails with `not-a-repo`

#### Scenario: Unwatch without watch
- **WHEN** a client unwatches a repo it does not watch
- **THEN** the request fails with `not-watched`

### Requirement: Worktree listing
A worktree entry SHALL report the path, the commit `head` (null for a bare repo or an unborn branch), the `branch` with any `refs/heads/` prefix removed (null when detached or bare), and the `detached`, `locked`, `prunable` and `bare` flags as git reports them; the first entry SHALL be the main worktree. Paths containing spaces or newlines SHALL be reported exactly. Attributes git adds in later versions SHALL be ignored.

#### Scenario: Flags reported
- **WHEN** a repo has a detached worktree, a locked worktree, and a worktree whose directory was deleted
- **THEN** the list reports them with `detached`, `locked` and `prunable` set respectively

#### Scenario: Path with a newline
- **WHEN** a worktree's path contains a newline
- **THEN** the reported path equals it exactly

### Requirement: Worktree change events
While a repo is watched, the daemon SHALL send every watcher `worktreesChanged` with the full list whenever the list changes, observed through file-system events and never by polling, after a 100 ms debounce. Changes SHALL include adding and removing a worktree, switching a worktree's branch, a commit on a checked-out branch (including branches whose names contain `/` and refs that are packed), locking and unlocking, and deletion of a worktree's directory. No event SHALL be sent when the list is unchanged. If watching or re-listing fails, or a re-read list holds more than 1024 worktrees, the daemon SHALL send every watcher of that repo `error{req: null, code: internal}` and end all subscriptions of that repo.

#### Scenario: Watch failure ends subscriptions
- **WHEN** a watched repo's directory is deleted
- **THEN** every watcher receives `error` with code `internal` and a later `unwatchRepo` for it fails with `not-watched`

#### Scenario: Worktree added
- **WHEN** `git worktree add` runs in a watched repo
- **THEN** every watcher receives `worktreesChanged` including the new worktree within 250 ms

#### Scenario: Branch switch
- **WHEN** a watched worktree switches branch
- **THEN** watchers receive `worktreesChanged` with the new branch within 250 ms

#### Scenario: Commit moves head
- **WHEN** a commit is made on the branch checked out in a watched worktree
- **THEN** watchers receive `worktreesChanged` with the new `head` within 250 ms

#### Scenario: Worktree directory deleted
- **WHEN** a linked worktree's directory is deleted
- **THEN** watchers receive `worktreesChanged` with that worktree `prunable` within 250 ms

#### Scenario: No change, no event
- **WHEN** a file inside a worktree is edited
- **THEN** no `worktreesChanged` is sent

### Requirement: Repo discovery
`discoverRepos{roots, depth}` SHALL return, sorted and without duplicates, the repositories found at most `depth` directory levels below each root, the root itself counting as level 0. A repository SHALL be a directory containing a `.git` directory, or a bare repository. Directories containing a `.git` file SHALL NOT be reported. The search SHALL NOT descend into a found repository, a symbolic link, a hidden directory or `node_modules`, and SHALL skip missing roots and unreadable directories. Directories SHALL be visited in sorted order and the result SHALL hold at most the first 4096 repositories in that order. Each root SHALL be resolved to its real path before the search, so every reported repository is a real path.

#### Scenario: Depth respected
- **WHEN** repos exist at levels 1 and 3 below a root and `depth` is 2
- **THEN** only the level-1 repo is reported

#### Scenario: Linked worktrees and submodules excluded
- **WHEN** a directory below a root contains a `.git` file
- **THEN** it is not reported

#### Scenario: Deterministic cap
- **WHEN** more than 4096 repos exist below a root
- **THEN** two runs report the same 4096 repos

#### Scenario: Root through a symbolic link
- **WHEN** a root is a symbolic link to a directory containing a repo
- **THEN** the repo is reported by its real path, which `watchRepo` accepts

### Requirement: Terminal creation
`createTerm` SHALL fail with `unknown-worktree` unless the worktree is in the current list of a repo this connection watches, and with `busy` if that repo already has 1024 live terminals. Otherwise the daemon SHALL start `$SHELL -l -i` when `command` is null, or `$SHELL -l -i -c <command>` otherwise (`/bin/sh` when `SHELL` is unset or not absolute), in the worktree directory, with `TERM=xterm-256color` and `COLORTERM=truecolor`, at the requested size. A failure to start SHALL fail with `spawn-failed`. Terminal ids SHALL count up from 1 and never be reused within a daemon instance. `preset` SHALL be stored and reported as given. The requester SHALL receive `termCreated` with its `req`; every other watcher of the repo SHALL receive `termCreated` with `req` null. Creating a terminal SHALL NOT attach it.

#### Scenario: Shell in the worktree
- **WHEN** a client creates a terminal in a worktree, attaches, and types `pwd`
- **THEN** the output shows the worktree path

#### Scenario: Other watchers learn of the terminal
- **WHEN** client A creates a terminal in a repo that client B also watches
- **THEN** A receives `termCreated` with its `req` and B receives `termCreated` with `req` null

#### Scenario: Unwatched worktree
- **WHEN** a client creates a terminal in a worktree of a repo it does not watch
- **THEN** the request fails with `unknown-worktree`

### Requirement: Terminal access
A terminal request, `resize` or input frame for an unknown terminal id SHALL fail with `unknown-term` (`req` null for `resize` and input), and for a terminal of a repo this connection does not watch with `not-watched`.

#### Scenario: Unknown terminal
- **WHEN** a client attaches to a terminal id that does not exist
- **THEN** the request fails with `unknown-term`

### Requirement: Terminal lifetime
A terminal SHALL end only by `closeTerm`, by its process exiting, or by `shutdown`; a client disconnecting or unwatching SHALL NOT end it. When the process exits, the daemon SHALL first offer every remaining output byte, then send `termExited{code, signal}` to the repo's watchers, `signal` being the signal name or null; the terminal SHALL remain, reporting `exit`, until closed. `closeTerm` SHALL send `SIGHUP` to the terminal's process group and `SIGKILL` 5 s later if it is still alive, never signalling a process after the terminal's process has been reaped; it SHALL remove the terminal from its layout, send `termClosed` to the repo's watchers, then reply `done`.

#### Scenario: Client leaves, terminal stays
- **WHEN** the only attached client disconnects and a new client attaches later
- **THEN** the terminal is still running and its output produced meanwhile is in the snapshot

#### Scenario: Exit after a final burst
- **WHEN** a terminal's process writes 1 MiB and exits immediately
- **THEN** an attached client receives all of it before `termExited`

#### Scenario: Exit code reported
- **WHEN** a terminal's shell runs `exit 3`
- **THEN** watchers receive `termExited` with `code` 3 and `signal` null

#### Scenario: Close kills the process group
- **WHEN** a terminal whose shell started a background child is closed
- **THEN** both processes end and watchers receive `termClosed`

### Requirement: Attach and snapshot
`attach` at output position S SHALL send a snapshot frame tagged S that reproduces the terminal's screen, modes and up to 5000 lines of scrollback as of exactly S, then `done`, then output frames starting exactly at S, with no gap and no duplicate byte, however output and the attach interleave. A snapshot that would exceed `MAX_FRAME` SHALL carry less scrollback until it fits. Attaching while attached SHALL re-attach with a new snapshot; `detach` SHALL succeed whether or not attached. An exited terminal SHALL be attachable.

#### Scenario: Reattach restores the screen
- **WHEN** client A is attached from creation, the terminal produces output including an alternate-screen program, wide characters and more than 5000 lines, and client B attaches mid-output
- **THEN** after both apply what they received, A's and B's screens, cursors, modes and scrollback are equal

#### Scenario: No gap and no duplicate
- **WHEN** a client attaches while the terminal is producing continuous numbered output
- **THEN** the snapshot's offset equals the first output frame's offset and the numbers continue without gap or repetition

### Requirement: Output flow control
Output offsets SHALL count the terminal's output bytes. For each attached connection the daemon SHALL track output sent minus acked, and for the screen mirror the output not yet processed. The PTY SHALL pause while any connection or the mirror is above `FLOW_HIGH`, and resume when all are below `FLOW_LOW`. A connection that stays at or above `FLOW_LOW` while the PTY is paused for `LAG_EVICT_MS` SHALL be detached with `detached{reason: lagging}`. Snapshot bytes SHALL NOT count. With no attached connection only the mirror SHALL pause the PTY. Output SHALL never be dropped.

#### Scenario: Slow client evicted, others intact
- **WHEN** client A attaches and never acks while client B acks normally and the terminal floods output
- **THEN** A receives `detached` with reason `lagging` and B receives every output byte with contiguous offsets

#### Scenario: Flood with nobody attached
- **WHEN** a terminal with no attached client writes far more than `FLOW_HIGH` and exits
- **THEN** the process completes and a later attach shows its final screen

### Requirement: Input
Input frames SHALL be written to the terminal's PTY in order. Input to an exited terminal SHALL be discarded. When more than 1 MiB of a terminal's input has not been accepted by its PTY, a further input frame for it SHALL be discarded and answered with `error{req: null, code: busy}`; the connection SHALL keep being read.

#### Scenario: Echo round trip
- **WHEN** a client sends `echo hi` and a newline as input
- **THEN** its output contains `hi`

#### Scenario: Input overflow
- **WHEN** a client sends more than 1 MiB of input to a terminal whose program does not read it
- **THEN** the overflowing frames get `error` with code `busy` and the client's acks for other terminals are still processed

### Requirement: Resize
`resize` SHALL set the PTY and its mirror to the given size; the last resize received SHALL win.

#### Scenario: Size visible to the program
- **WHEN** a client resizes a terminal to 100×30 and runs `stty size`
- **THEN** the output is `30 100`

### Requirement: Activity
A terminal SHALL be visible while at least one connection lists it in its latest `setVisible`; ids of unknown terminals or of repos the connection does not watch SHALL be ignored, and a connection's visibility SHALL be withdrawn when it unwatches the repo or disconnects. Output while not visible SHALL set `unseen`; a bell while not visible SHALL set `bell`; becoming visible SHALL clear both. Every change of either flag SHALL be sent as `activity` to the repo's watchers.

#### Scenario: Output while hidden
- **WHEN** a terminal not listed by any `setVisible` produces output
- **THEN** watchers receive `activity` with `unseen` true

#### Scenario: Shown clears flags
- **WHEN** a client lists a terminal with `unseen` and `bell` set in `setVisible`
- **THEN** watchers receive `activity` with both false

#### Scenario: Disconnect withdraws visibility
- **WHEN** the only client showing a terminal disconnects and the terminal produces output
- **THEN** the terminal's `unseen` becomes true

### Requirement: Checked state and layouts
`setChecked` and `setLayout` SHALL fail with `unknown-worktree` unless the worktree is in the current list of a repo this connection watches. Every leaf of a layout SHALL be a live terminal of that worktree; `setLayout` with any other leaf SHALL fail with `unknown-term` and change nothing. A successful change SHALL be persisted durably, then sent as `checkedChanged` or `layoutChanged` to every watcher of the repo including the requester, then answered with `done`. A failed write SHALL answer `internal`, keep the previous state and send no change. When a terminal is closed it SHALL be removed from its worktree's layout: a split SHALL be replaced by its remaining child, a tab left empty SHALL be removed, and `active` SHALL keep the same tab if it remains, else the nearest preceding remaining tab, else 0; a changed layout SHALL be sent as `layoutChanged`.

#### Scenario: Checkbox broadcast
- **WHEN** client A checks a worktree that client B also watches
- **THEN** both receive `checkedChanged` and A then receives `done`

#### Scenario: Layout with a foreign terminal
- **WHEN** a client sets a layout containing a terminal of another worktree
- **THEN** the request fails with `unknown-term` and the stored layout is unchanged

#### Scenario: Closing a split pane
- **WHEN** a terminal in one half of a split is closed
- **THEN** watchers receive `layoutChanged` in which the split is replaced by the other half

### Requirement: Persistence and pruning
Checked state and layouts SHALL be stored in `state.json` and survive daemon restarts; entries with default values SHALL NOT be stored. On start, every layout SHALL lose its terminal leaves, because no terminal survives a restart. A state file that cannot be parsed SHALL be renamed to `state.json.corrupt-<timestamp>` and the daemon SHALL start with empty state. Whenever a repo's worktree list is read, and whenever a terminal closes, entries for worktrees of that repo that are no longer listed and have no live terminals SHALL be removed.

#### Scenario: Checked survives restart
- **WHEN** a worktree is checked, its terminal is placed in a layout, and the daemon restarts
- **THEN** the worktree is still checked and its layout has no tabs

#### Scenario: Removed worktree pruned
- **WHEN** a checked worktree without terminals is removed with `git worktree remove`
- **THEN** its entry is gone from `state.json`

#### Scenario: Removed worktree with a terminal kept until close
- **WHEN** a checked worktree with a live terminal is removed, and the terminal is later closed
- **THEN** the entry stays while the terminal lives and is removed when it closes

#### Scenario: Corrupt state file
- **WHEN** `state.json` holds invalid JSON at start
- **THEN** it is renamed to a `state.json.corrupt-` file and the daemon starts with no checked worktrees

### Requirement: Shutdown
`shutdown`, `SIGTERM` or `SIGINT` SHALL close every terminal as `closeTerm` does, complete pending state writes, remove the socket and exit 0.

#### Scenario: Shutdown ends terminals
- **WHEN** a client sends `shutdown` while terminals run
- **THEN** their processes end, the socket file is removed, and the daemon exits 0
