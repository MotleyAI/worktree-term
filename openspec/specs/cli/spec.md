# cli Specification

## Purpose
The `wtd` command line surface: how a user discovers its commands and version, and how it reports misuse.

## Requirements

### Requirement: Version output
`wtd --version` SHALL print `wtd <package version> (protocol <PROTOCOL_VERSION>)` and a newline to stdout and exit 0.

#### Scenario: Version
- **WHEN** the user runs `wtd --version`
- **THEN** stdout is `wtd <package version> (protocol 2)` followed by a newline, stderr is empty, and the exit code is 0

### Requirement: Help output
`wtd --help` SHALL print usage to stdout and exit 0. Usage SHALL list the commands `ui`, `hub`, `daemon`, `connect`, `install-local` and `install-remote <alias>`, and the options `--help` and `--version`.

#### Scenario: Help
- **WHEN** the user runs `wtd --help`
- **THEN** stdout lists every command and option above, stderr is empty, and the exit code is 0

### Requirement: Usage errors
Running `wtd` with no arguments, an unknown command, an unknown option, or `install-remote` without an alias SHALL print a one-line error and the usage to stderr, print nothing to stdout, and exit 2.

#### Scenario: No arguments
- **WHEN** the user runs `wtd`
- **THEN** stderr contains the usage, stdout is empty, and the exit code is 2

#### Scenario: Unknown command
- **WHEN** the user runs `wtd frobnicate`
- **THEN** stderr names `frobnicate` as unknown and contains the usage, and the exit code is 2

#### Scenario: Unknown option
- **WHEN** the user runs `wtd --frob`
- **THEN** stderr names `--frob` as unknown and contains the usage, and the exit code is 2

#### Scenario: Missing alias
- **WHEN** the user runs `wtd install-remote`
- **THEN** stderr says an alias is required and contains the usage, and the exit code is 2

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
