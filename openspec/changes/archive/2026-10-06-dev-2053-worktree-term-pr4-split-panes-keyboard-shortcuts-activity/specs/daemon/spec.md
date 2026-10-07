## MODIFIED Requirements

### Requirement: Handshake and version mismatch
On every new connection the daemon SHALL send `hello` with `protocol` equal to `PROTOCOL_VERSION`, its package version, and an `instance` chosen at random once per process start. If the client's first message is not `hello`, the daemon SHALL send `error{req: null, code: bad-message}` and close. If the client's `hello` carries a different `protocol`, the connection SHALL accept only the frozen `shutdown` message; every other frame, including undecodable ones, SHALL get `error{req: null, code: version-mismatch}`.

#### Scenario: Daemon hello
- **WHEN** a client connects
- **THEN** the first frame it receives is the daemon's `hello` with `protocol` 4

#### Scenario: Message before hello
- **WHEN** a client's first message is a `watchRepo`
- **THEN** the daemon replies `error` with code `bad-message` and closes the connection

#### Scenario: Mismatched client can only shut down
- **WHEN** a client sends `hello` with `protocol` 1, then a `watchRepo`, then `shutdown`
- **THEN** the `watchRepo` gets `error{req: null, code: version-mismatch}` and the `shutdown` stops the daemon

### Requirement: Activity
A terminal SHALL be visible while at least one connection lists it in its latest `setVisible`; ids of unknown terminals or of repos the connection does not watch SHALL be ignored, and a connection's visibility SHALL be withdrawn when it unwatches the repo or disconnects. Output while not visible SHALL set `unseen`; the process exiting while not visible SHALL set `unseen`; becoming visible SHALL clear it.
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
- **WHEN** a terminal not listed by any `setVisible` exits without producing further output
- **THEN** watchers receive `activity` with `unseen` true

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
