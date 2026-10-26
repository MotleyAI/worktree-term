## MODIFIED Requirements

### Requirement: Terminal lifetime
A terminal SHALL end only by `closeTerm`, by its process exiting, or by `shutdown`; a client disconnecting or unwatching SHALL NOT end it. An exit with code 0 and no signal SHALL be a clean exit; any other exit SHALL be a failed exit. When the process exits, the daemon SHALL first offer every remaining output byte. After a failed exit it SHALL then send `termExited{code, signal}` to the repo's watchers, `signal` being the signal name or null, and the terminal SHALL remain, reporting `exit`, until closed. After a clean exit it SHALL close the terminal itself, without sending `termExited`: it SHALL remove the terminal from its layout and send `termClosed` to the repo's watchers, sending `termClosed` even when the changed layout cannot be saved. `closeTerm` SHALL send `SIGHUP` to the terminal's process group and `SIGKILL` 5 s later if it is still alive, never signalling a process after the terminal's process has been reaped; it SHALL remove the terminal from its layout, send `termClosed` to the repo's watchers, then reply `done`.

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
- **THEN** watchers receive `termExited` with `code` 3 and `signal` null

#### Scenario: Killed by a signal stays
- **WHEN** a terminal's shell is killed by `SIGTERM` sent from outside the daemon
- **THEN** watchers receive `termExited` with `signal` "SIGTERM", and a client watching the repo afterwards is told of the terminal with that `exit`

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
