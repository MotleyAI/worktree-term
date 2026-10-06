## MODIFIED Requirements

### Requirement: Version output
`wtd --version` SHALL print `wtd <package version> (protocol <PROTOCOL_VERSION>)` and a newline to stdout and exit 0.

#### Scenario: Version
- **WHEN** the user runs `wtd --version`
- **THEN** stdout is `wtd <package version> (protocol 2)` followed by a newline, stderr is empty, and the exit code is 0

## ADDED Requirements

### Requirement: Daemon command
`wtd daemon` SHALL run this host's daemon in the foreground until it receives `shutdown`, `SIGTERM` or `SIGINT`, then exit 0. It SHALL ignore `SIGHUP`. If a daemon is already serving this host's socket, it SHALL print `wtd daemon: already running` to stderr and exit 1. Any other start failure SHALL print one line naming the cause to stderr, without a stack trace, and exit 1.

#### Scenario: Foreground run and signal stop
- **WHEN** the user runs `wtd daemon` and later sends it `SIGTERM`
- **THEN** the daemon serves the socket until the signal, removes its socket, and exits 0

#### Scenario: Second daemon refused
- **WHEN** the user runs `wtd daemon` while another daemon serves this host's socket
- **THEN** stderr is `wtd daemon: already running`, the running daemon is unaffected, and the exit code is 1

### Requirement: Connect command
`wtd connect` SHALL connect to this host's daemon socket, starting the daemon first if no daemon is serving it, and then relay bytes unchanged from stdin to the socket and from the socket to stdout. When stdin ends it SHALL half-close the socket; when the socket closes it SHALL flush stdout and exit 0. If the daemon cannot be reached or started, or the socket fails, it SHALL print one line naming the cause to stderr and exit 1.

#### Scenario: Bridge over a pipe with auto-start
- **WHEN** no daemon is running and a process runs `wtd connect` with piped stdio
- **THEN** a daemon is started and the first frame on stdout is the daemon's `hello` with `protocol` 2

#### Scenario: Requests relayed
- **WHEN** the client writes `hello` and a `watchRepo` frame to `wtd connect`'s stdin
- **THEN** the daemon's `repoState` and `done` frames appear on stdout unchanged

#### Scenario: Socket close ends the bridge
- **WHEN** the client sends `shutdown` through `wtd connect`
- **THEN** the daemon exits, `wtd connect` exits 0, and the next `wtd connect` starts a daemon with a different `instance`
