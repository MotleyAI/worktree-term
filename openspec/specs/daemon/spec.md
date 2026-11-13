# daemon Specification

## Purpose
The per-host daemon: it watches the worktrees of the repos its clients ask for, owns PTYs and their screen mirrors independently of any client, persists checkbox and layout state, and serves the protocol to any number of clients over an owner-only unix socket.

## Requirements

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
On every new connection the daemon SHALL send `hello` with `protocol` equal to `DAEMON_PROTOCOL_VERSION`, its package version, and an `instance` chosen at random once per process start. If the client's first message is not `hello`, the daemon SHALL send `error{req: null, code: bad-message}` and close. If the client's `hello` carries a different `protocol`, the connection SHALL accept only the frozen `shutdown` message; every other frame, including undecodable ones, SHALL get `error{req: null, code: version-mismatch}`.

#### Scenario: Daemon hello
- **WHEN** a client connects
- **THEN** the first frame it receives is the daemon's `hello` with `protocol` 6

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
`discoverRepos{roots, depth}` SHALL return, sorted and without duplicates, the repositories found at most `depth` directory levels below each root, the root itself counting as level 0. A root `~` SHALL mean the daemon's home directory and a root `~/<rest>` the path `<rest>` below it. A repository SHALL be a directory containing a `.git` directory, or a bare repository. Directories containing a `.git` file SHALL NOT be reported. The search SHALL NOT descend into a found repository, a symbolic link, a hidden directory or `node_modules`, and SHALL skip missing roots and unreadable directories. Directories SHALL be visited in sorted order and the result SHALL hold at most the first 4096 repositories in that order. Each root SHALL be resolved to its real path before the search, so every reported repository is a real path.

#### Scenario: Depth respected
- **WHEN** repos exist at levels 1 and 3 below a root and `depth` is 2
- **THEN** only the level-1 repo is reported

#### Scenario: Home-relative roots expanded by the daemon
- **WHEN** the daemon's home holds `GitHub/app` as a repo and a client discovers with roots `~` and `~/GitHub` and `depth` 3
- **THEN** the daemon reports the repo once, by its real path below the daemon's home

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

### Requirement: Terminal access
A terminal request, `resize` or input frame for an unknown terminal id SHALL fail with `unknown-term` (`req` null for `resize` and input), and for a terminal of a repo this connection does not watch with `not-watched`.

#### Scenario: Unknown terminal
- **WHEN** a client attaches to a terminal id that does not exist
- **THEN** the request fails with `unknown-term`

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
A terminal SHALL be visible while at least one connection lists it in its latest `setVisible`; ids of unknown terminals or of repos the connection does not watch SHALL be ignored, and a connection's visibility SHALL be withdrawn when it unwatches the repo or disconnects. Output while not visible SHALL set `unseen`; a failed exit while not visible SHALL set `unseen`, and a clean exit SHALL NOT; becoming visible SHALL clear it.
Each terminal SHALL have an attention `state`, `idle` when created. Times below are when the daemon received the output or input concerned.
- An attention signal SHALL be: a bell character outside any escape sequence; an OSC 9 sequence whose payload does not start with a decimal number followed by `;`; an OSC 777 sequence whose payload starts with `notify;`; an OSC 99 sequence. A bell received within 1 s after an input frame that is not only focus reports SHALL NOT be a signal.
- A signal SHALL set `input`, whether or not the terminal is visible.
- In `working` or `idle`, output SHALL set `working`; `working` SHALL become `idle` once no output has been received for 3 s.
- In `input`, output received more than 1 s after both the last signal and the last input frame consisting only of focus reports SHALL set `working`; other output SHALL leave `input`.
- An input frame SHALL set `working` from `input`, unless the frame consists only of focus reports (`ESC [ I`, `ESC [ O`). Input SHALL be written to the PTY unchanged in every case.
- After the process exits, `state` SHALL no longer change.
Every change of `unseen` or `state` SHALL be sent as `activity{termId, unseen, state}` to the repo's watchers, and terminal entries SHALL carry both.

#### Scenario: Output while hidden
- **WHEN** a terminal not listed by any `setVisible` produces output
- **THEN** watchers receive `activity` with `unseen` true and `state` "working"

#### Scenario: Shown clears flags
- **WHEN** a client lists a terminal with `unseen` set in `setVisible`
- **THEN** watchers receive `activity` with `unseen` false

#### Scenario: Unseen only when no client shows the terminal
- **WHEN** one of two clients lists a terminal in `setVisible` and the terminal produces output
- **THEN** `unseen` stays false

#### Scenario: Disconnect withdraws visibility
- **WHEN** the only client showing a terminal disconnects and the terminal produces output
- **THEN** the terminal's `unseen` becomes true

#### Scenario: Exit while hidden
- **WHEN** a terminal not listed by any `setVisible` exits with code 1 without producing further output
- **THEN** watchers receive `activity` with `unseen` true

#### Scenario: Clean exit while hidden
- **WHEN** a terminal not listed by any `setVisible` exits with code 0 without producing further output
- **THEN** watchers receive `termClosed` and no `activity` with `unseen` true

#### Scenario: Quiet terminal becomes idle
- **WHEN** a terminal prints a line and then nothing for 3 s
- **THEN** watchers receive `activity` with `state` "working" and then, 3 s after the output, `state` "idle"

#### Scenario: Bell asks for input
- **WHEN** a terminal's program rings the bell without any input in the previous second
- **THEN** watchers receive `activity` with `state` "input"

#### Scenario: Desktop notifications ask for input
- **WHEN** a terminal's program writes `ESC ] 9 ; done BEL`, `ESC ] 777 ; notify ; t ; b BEL` or `ESC ] 99 ; ; hi ESC \`
- **THEN** each sets `state` "input"

#### Scenario: Progress report is not a signal
- **WHEN** a terminal's program writes `ESC ] 9 ; 4 ; 1 ; 50 BEL`
- **THEN** `state` does not become "input"

#### Scenario: Signal split across output chunks
- **WHEN** an OSC 777 notification arrives in two output chunks split inside its payload
- **THEN** `state` becomes "input" once

#### Scenario: Bell answering typing is ignored
- **WHEN** a client sends a tab character and the shell rings the bell within 1 s
- **THEN** `state` does not become "input"

#### Scenario: Typing clears input
- **WHEN** a terminal in `input` receives an input frame holding `y`
- **THEN** its `state` becomes "working"

#### Scenario: Focus reports do not clear input
- **WHEN** a terminal in `input` receives an input frame holding `ESC [ O ESC [ I`
- **THEN** its `state` stays "input" and the bytes reach the program

#### Scenario: Reply to a focus report keeps input
- **WHEN** a terminal in `input` receives `ESC [ I` 5 s after the signal and its program writes `ESC ( B SI` at once
- **THEN** its `state` stays "input"

#### Scenario: Output resuming clears input
- **WHEN** a terminal in `input` produces output 1.5 s after the signal
- **THEN** its `state` becomes "working"

#### Scenario: Output around the signal keeps input
- **WHEN** a terminal produces output 0.5 s after a signal
- **THEN** its `state` stays "input"

### Requirement: Checked state and layouts
`setChecked` and `setLayout` SHALL fail with `unknown-worktree` unless the worktree is in the current list of a repo this connection watches. Every leaf of a layout SHALL be a live terminal of that worktree; `setLayout` with any other leaf SHALL fail with `unknown-term` and change nothing. A successful change SHALL be persisted durably, then sent as `checkedChanged` or `layoutChanged` to every watcher of the repo including the requester, then answered with `done`. A failed write SHALL answer `internal`, keep the previous state and send no change. When a terminal is closed it SHALL be removed from its worktree's layout: a split SHALL be replaced by its remaining child, a tab left empty SHALL be removed, a remaining tab SHALL keep its id and name, and `active` SHALL keep the same tab if it remains, else the nearest preceding remaining tab, else 0; a changed layout SHALL be sent as `layoutChanged`.

#### Scenario: Checkbox broadcast
- **WHEN** client A checks a worktree that client B also watches
- **THEN** both receive `checkedChanged` and A then receives `done`

#### Scenario: Layout with a foreign terminal
- **WHEN** a client sets a layout containing a terminal of another worktree
- **THEN** the request fails with `unknown-term` and the stored layout is unchanged

#### Scenario: Closing a split pane
- **WHEN** a terminal in one half of a split is closed
- **THEN** watchers receive `layoutChanged` in which the split is replaced by the other half

#### Scenario: Closing a pane keeps the tab's name
- **WHEN** a terminal in one half of a split in a tab named "build" is closed
- **THEN** watchers receive `layoutChanged` in which that tab is still named "build"

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

#### Scenario: Removed worktree pruned after a clean exit
- **WHEN** a checked worktree with a live terminal is removed with `git worktree remove`, and the terminal's shell then exits with code 0
- **THEN** its entry is gone from `state.json`

#### Scenario: Corrupt state file
- **WHEN** `state.json` holds invalid JSON at start
- **THEN** it is renamed to a `state.json.corrupt-` file and the daemon starts with no checked worktrees

### Requirement: Shutdown
`shutdown`, `SIGTERM` or `SIGINT` SHALL close every terminal as `closeTerm` does, complete pending state writes, remove the socket and exit 0.

#### Scenario: Shutdown ends terminals
- **WHEN** a client sends `shutdown` while terminals run
- **THEN** their processes end, the socket file is removed, and the daemon exits 0

### Requirement: Worktree removal
`removeWorktree{req, worktree, force}` SHALL fail with `unknown-worktree` unless the worktree is in the current list of a repo this connection watches, and with `busy` for the main worktree or a locked one. Without `force`, the daemon SHALL determine what removal would put at risk.
The default branch SHALL be the first of: the branch `origin/HEAD` names, `main`, `master`, for which a local branch or an `origin` remote-tracking ref of that name exists.
For a worktree on a branch `<b>`, the base candidates SHALL be, in order: its upstream `<x>`, when `branch.<b>.remote` is `origin` or `.` and `branch.<b>.merge` has exactly one value, `refs/heads/<x>`; then the branch it was created from, when the oldest entry of `<b>`'s reflog reads `branch: Created from <ref>`, `<x>` being `<ref>` without a leading `refs/heads/`, `refs/remotes/origin/` or `origin/`. A candidate SHALL be skipped when it is `<b>` or `HEAD`, is not a valid branch name, is also the name of a tag, or when neither a local branch `<x>` nor the remote-tracking ref `origin/<x>` exists. The base SHALL be the first candidate not skipped; a detached worktree, or one without such a candidate, has no base. The base and the default branch SHALL be determined once per removal.
`bases` SHALL be, in this order and each only when it exists, the base's local branch, `origin/<base>`, the default branch's local branch and its `origin` remote-tracking ref, remote-tracking refs shown without `refs/remotes/` (e.g. `origin/main`), no ref listed twice. `ahead` SHALL be null when `bases` is empty, else 0 for a worktree without a head, else the number of commits reachable from the worktree's head and from none of `bases`.
Only when that number is not 0 and the repo has a remote named `origin` SHALL the daemon fetch from `origin`, concurrently, without prompting for credentials and each within 20 seconds: the default branch into its remote-tracking ref, when there is a default branch, and the base into `origin/<base>`, when there is a base and `origin/<base>` existed before the fetch. Each fetch SHALL update its remote-tracking ref whatever `origin`'s configured refspec. After the fetches, `bases` and `ahead` SHALL be determined again from the worktree's current head. `fetchFailed` SHALL list, the base's first, `{ref, reason}` for each fetch that failed or after which its remote-tracking ref does not exist, `ref` being that ref's name as in `bases` and `reason` git's first non-empty line of error output with control characters replaced by spaces, `timed out after 20 s`, or that the ref is missing after the fetch, at most 1024 characters; `fetchFailed` SHALL be empty in every other case.
`changes` SHALL be the number of uncommitted changes in its directory, untracked files included and ignored files not (0 when its directory is gone), counted after any fetch; `running` the ids of its terminals that have not exited. When `ahead` is not 0, `changes` is not 0 or `running` is not empty, it SHALL answer `worktreeAtRisk` with those values and change nothing. Otherwise, and always with `force`, it SHALL remove the worktree — `git worktree remove` of that worktree alone, with `--force` when `force` is set, also when its directory is gone — keeping its branch, then close every terminal of the worktree, sending `termClosed` to the repo's watchers, and answer `done`. With `force` it SHALL neither count commits nor fetch. A failed removal SHALL answer `error` naming git's message and close no terminal. A removal SHALL first wait for terminals still starting in the worktree, which then count as running; while a removal of a worktree is in progress, `createTerm` and `removeWorktree` for it SHALL fail with `busy`.

#### Scenario: Nothing at risk
- **WHEN** a worktree whose branch is in the local `main`, with no changes and only an exited terminal, is removed without `force`
- **THEN** its directory is gone, its branch remains, the exited terminal is closed, watchers receive `worktreesChanged` without it, and the requester receives `done`

#### Scenario: Merged into local main, remote unreachable
- **WHEN** a worktree's branch is in the local `main` but not in `origin/main`, the remote cannot be reached, and the worktree is removed without `force`
- **THEN** no fetch is attempted, and the worktree is removed and the requester receives `done`

#### Scenario: In origin/main as last fetched
- **WHEN** a worktree's branch is in `origin/main` as last fetched but not in the local `main`, and the worktree is removed without `force`
- **THEN** no fetch is attempted, and the worktree is removed and the requester receives `done`

#### Scenario: Commits split between main and origin/main
- **WHEN** a worktree's head merges two commits, one reachable only from the local `main` and the other only from `origin/main` as last fetched, the remote cannot be reached, and it is removed without `force`
- **THEN** the requester receives `worktreeAtRisk` with `ahead` 1, counting only the merge commit

#### Scenario: Merged since the last fetch
- **WHEN** a worktree's branch was merged into the remote's `main` after the repo last fetched, is not in the local `main`, and the worktree is removed without `force`
- **THEN** the daemon fetches `main` from `origin`, finds nothing ahead, and removes the worktree

#### Scenario: Every risk reported
- **WHEN** a worktree without a base, with one commit in neither `main` nor `origin/main`, one untracked file and a running terminal is removed without `force`
- **THEN** the requester receives `worktreeAtRisk` with `bases` ["main", "origin/main"], `ahead` 1, `fetchFailed` empty, `changes` 1 and that terminal's id, and the worktree and terminal remain

#### Scenario: Remote unreachable
- **WHEN** the remote cannot be reached and a worktree without a base has one commit in neither the local `main` nor `origin/main` as last fetched
- **THEN** the requester receives `worktreeAtRisk` with `bases` ["main", "origin/main"], `ahead` 1 and `fetchFailed` [`{ref: "origin/main", reason}`] with a non-empty `reason`

#### Scenario: Fetch reason is one clean line
- **WHEN** a failed fetch's error output starts with blank lines and contains control characters
- **THEN** its `reason` is its first non-empty line with each control character replaced by a space

#### Scenario: Fetch timed out
- **WHEN** the fetch does not finish within 20 seconds
- **THEN** it is stopped and its `reason` is "timed out after 20 s"

#### Scenario: Fetch updates the remote-tracking ref whatever the configured refspec
- **WHEN** the repo's `origin` has a fetch refspec that does not map `main`, its `origin/main` is stale, and a worktree merged on the remote since is removed without `force`
- **THEN** the fetch updates `origin/main`, nothing is ahead, and the worktree is removed

#### Scenario: Origin present but unusable
- **WHEN** the repo has a remote named `origin` whose URL is not a repository, and a worktree without a base with one commit not in the local `main` is removed without `force`
- **THEN** the requester receives `worktreeAtRisk` with `bases` ["main"], `ahead` 1 and `fetchFailed` [`{ref: "origin/main", reason}`]

#### Scenario: No origin, local main only
- **WHEN** a worktree without a base of a repo without an `origin` has one commit not in the local `main`, and is removed without `force`
- **THEN** the requester receives `worktreeAtRisk` with `bases` ["main"], `ahead` 1 and `fetchFailed` empty, and no fetch is attempted

#### Scenario: Default branch from origin/HEAD
- **WHEN** `origin/HEAD` names `origin/develop`, both `develop` and `main` exist, and a worktree without a base with one commit in `main` but not in `develop` nor `origin/develop` is removed without `force` while the remote cannot be reached
- **THEN** the requester receives `worktreeAtRisk` with `bases` ["develop", "origin/develop"] and `ahead` 1

#### Scenario: Default branch fallbacks
- **WHEN** `origin/HEAD` is absent or names a missing ref, and a worktree without a base is removed from a repo that has only a local `master`, or only `origin/main`, or both `main` and `master` and no `origin`
- **THEN** `bases` is respectively ["master"], ["origin/main"] and ["main"]

#### Scenario: Merged into its base
- **WHEN** a worktree whose branch was created from `feature-x` has every commit in the local `feature-x`, one of them in neither `main` nor `origin/main`, and is removed without `force`
- **THEN** no fetch is attempted, the worktree is removed and the requester receives `done`

#### Scenario: Unmerged commits name the base
- **WHEN** a worktree whose branch was created from `feature-x` has one commit in none of `feature-x`, `origin/feature-x`, `main` and `origin/main`, and is removed without `force` while the remote cannot be reached
- **THEN** the requester receives `worktreeAtRisk` with `bases` ["feature-x", "origin/feature-x", "main", "origin/main"], `ahead` 1 and `fetchFailed` with `ref` "origin/feature-x" and then "origin/main"

#### Scenario: Merged into the default branch past a stale base
- **WHEN** a worktree whose branch was created from `feature-x` has every commit in `main`, one of them not in `feature-x`, and is removed without `force`
- **THEN** the worktree is removed and the requester receives `done`

#### Scenario: Base merged on the remote since the last fetch
- **WHEN** a worktree's base is `feature-x`, `origin/feature-x` exists but is stale and not mapped by `origin`'s fetch refspec, and the worktree's commits were merged into the remote's `feature-x` since, and it is removed without `force`
- **THEN** the daemon fetches `feature-x` into `origin/feature-x`, finds nothing ahead, and removes the worktree

#### Scenario: Untracked base not fetched
- **WHEN** a worktree's base `feature-x` exists only as a local branch, the repo has an `origin`, and the worktree has one commit in none of `feature-x`, `main` and `origin/main`
- **THEN** only `main` is fetched, and the requester receives `worktreeAtRisk` with `bases` ["feature-x", "main", "origin/main"], `ahead` 1 and `fetchFailed` empty

#### Scenario: Base fetch fails while the default fetch succeeds
- **WHEN** a worktree's base is `feature-x`, `origin/feature-x` exists but `feature-x` is gone from the remote, and the worktree has one commit in none of the bases after `main` is fetched
- **THEN** the requester receives `worktreeAtRisk` with `bases` ["feature-x", "origin/feature-x", "main", "origin/main"], `ahead` 1 and `fetchFailed` [`{ref: "origin/feature-x", reason}`] only

#### Scenario: Fetches run concurrently
- **WHEN** both `origin/feature-x` and `origin/main` are fetched and the remote does not answer
- **THEN** the requester receives `worktreeAtRisk` after one fetch time limit, not two, with both fetches in `fetchFailed`, each with `reason` "timed out after 20 s"

#### Scenario: Base equal to the default branch
- **WHEN** a worktree whose branch was created from `origin/main` has one commit not in `main` nor `origin/main`
- **THEN** `bases` is ["main", "origin/main"] and `main` is fetched once

#### Scenario: Base from the upstream
- **WHEN** a worktree's branch was created from `main` and its upstream is `refs/heads/feature-x` on `.` or on `origin`, and all its commits are in `feature-x` only
- **THEN** its base is `feature-x` and it is removed without asking

#### Scenario: Upstream not taken as the base
- **WHEN** a worktree's branch `feat` has its upstream `refs/heads/feat` on `origin`, or an upstream on a remote other than `origin`, or two `merge` values, and was created from `feature-x`
- **THEN** its base is `feature-x`

#### Scenario: Creation source that is not a branch
- **WHEN** a worktree's branch was created from `HEAD`, `HEAD~1`, a commit id, a tag `v1` (also when a branch `v1` exists), or `upstream/main` of a remote other than `origin`, and it has no usable upstream
- **THEN** it has no base, and `bases` are the default branch's

#### Scenario: No creation record
- **WHEN** a worktree's branch has no reflog, or its oldest surviving reflog entry is not a creation, and it has no usable upstream
- **THEN** it has no base, and `bases` are the default branch's

#### Scenario: Vanished candidate falls through
- **WHEN** a worktree's upstream names `feature-y`, of which neither a local branch nor `origin/feature-y` exists, and its branch was created from `feature-x`, which exists
- **THEN** its base is `feature-x`; and when `feature-x` is gone as well, it has no base

#### Scenario: Base names with slashes and dots
- **WHEN** a worktree's branch `egor/feat.2` was created from `release/1.2`
- **THEN** its base is `release/1.2` and `bases` starts with "release/1.2"

#### Scenario: Detached worktree compared with the default branch
- **WHEN** a detached worktree with one commit not in `main` nor `origin/main` is removed without `force`
- **THEN** `bases` is ["main", "origin/main"]

#### Scenario: Terminal starting during a removal
- **WHEN** a terminal of the worktree is still starting when `removeWorktree` without `force` arrives
- **THEN** the removal waits for it and answers `worktreeAtRisk` listing it as running

#### Scenario: No terminal starts in a worktree being removed
- **WHEN** `createTerm` for a worktree arrives while its removal is in progress
- **THEN** it fails with `busy` and no terminal starts

#### Scenario: No base to compare with
- **WHEN** a worktree without a base, of a repo without an `origin` and without a `main` or `master` branch, is removed without `force`, whether or not it has a head
- **THEN** the requester receives `worktreeAtRisk` with `bases` empty, `ahead` null and `fetchFailed` empty, and the worktree remains

#### Scenario: Worktree without a head
- **WHEN** a worktree without a head, in a repo with a local `main`, is removed without `force`
- **THEN** `ahead` is 0 and no fetch is attempted

#### Scenario: Forced removal
- **WHEN** that worktree at risk is removed with `force`
- **THEN** no commits are counted and no fetch is attempted, its directory is gone, its branch remains, its running terminal is closed, and the requester receives `done`

#### Scenario: Main and locked worktrees refused
- **WHEN** the main worktree or a locked worktree is removed, even with `force`
- **THEN** the requester receives `error` with code `busy` and nothing changes

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

### Requirement: Daemon placement
Once it holds the start lock and before it serves its socket, the daemon SHALL find whether it has a lasting user manager (see `platform`) and, when it has one and its cgroup is not that of `worktree-term-daemon.service`, enter a daemon scope; however it was started — by dialing, by `wtd daemon` in the foreground, or by a script. A failure to enter SHALL be reported on its standard error and the daemon SHALL run on in its cgroup. In every case it SHALL then lower its own `oom_score_adj` to the lowest value the kernel permits it, so that a daemon started from a terminal does not keep the terminal's adjustment.

#### Scenario: Auto-started daemon in its own scope
- **WHEN** dialing starts the daemon from a process under the user manager
- **THEN** the serving daemon's cgroup is a `wtd-<h>-daemon-<r>.scope` under `app-wtd.slice`, not the dialing process's cgroup

#### Scenario: Foreground daemon in its own scope
- **WHEN** the user runs `wtd daemon` in a terminal of another daemon
- **THEN** the new daemon's cgroup is a daemon scope, not that terminal's scope

#### Scenario: Daemon started in a terminal gives up the terminal's adjustment
- **WHEN** the user runs `wtd daemon` in a terminal of another daemon
- **THEN** the new daemon's `oom_score_adj` is the lowest value the kernel permits it, below 500 where that floor is lower

#### Scenario: Daemon unit stays
- **WHEN** the daemon is started as `worktree-term-daemon.service`
- **THEN** its cgroup stays that unit's

#### Scenario: No lasting user manager
- **WHEN** the daemon starts without a lasting user manager
- **THEN** it serves from the cgroup it was started in

### Requirement: Terminal scopes
At start the daemon SHALL write one line to its standard error: `terminal scopes: on` when it has a lasting user manager, else `terminal scopes: off (<reason>)`. While terminal scopes are on, the daemon SHALL start each terminal's process in its terminal scope with the `memory` limits of its `createTerm`, so that every process the terminal starts, detached ones included, belongs to that scope and to no other terminal's; and at start it SHALL cap the terminal slice (see `platform`) at two thirds of physical memory, rounded down to a whole MiB, reporting a failure to cap it on its standard error, and reset every failed unit whose name begins `wtd-<h>-term-`. While terminal scopes are off, terminals SHALL start as without scopes and their limits SHALL be ignored, the first `createTerm` with a limit writing `memory limits ignored: terminal scopes are off` to standard error once per daemon. In either case, where `/proc` exists, the shell and every process it starts SHALL have an `oom_score_adj` of at least 500, set before the shell runs.

#### Scenario: Terminal processes in the terminal's scope
- **WHEN** terminal scopes are on and a terminal's shell runs `sleep 1000 &`, `sh -c 'sleep 1001' &` and `setsid sleep 1002 &`
- **THEN** the shell and the three `sleep` processes have that terminal's `wtd-<h>-term-<instance>-<termId>.scope` cgroup, which is neither the daemon's nor another terminal's

#### Scenario: Terminals capped together
- **WHEN** terminal scopes are on and a terminal is created
- **THEN** its scope's parent, `app-wtd-terminals.slice`, has a `memory.max` of two thirds of physical memory rounded down to a whole MiB, and the daemon's cgroup is outside that slice

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
