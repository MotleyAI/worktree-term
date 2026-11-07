## MODIFIED Requirements

### Requirement: Daemon command
`wtd daemon` SHALL run this host's daemon in the foreground until it receives `shutdown`, `SIGTERM` or `SIGINT`, then exit 0. It SHALL ignore `SIGHUP`, and SHALL place itself in a scope of its own as daemon placement states (see `daemon`). If a daemon is already serving this host's socket, it SHALL print `wtd daemon: already running` to stderr and exit 1. Any other start failure SHALL print one line naming the cause to stderr, without a stack trace, and exit 1.

#### Scenario: Foreground run and signal stop
- **WHEN** the user runs `wtd daemon` and later sends it `SIGTERM`
- **THEN** the daemon serves the socket until the signal, removes its socket, and exits 0

#### Scenario: Second daemon refused
- **WHEN** the user runs `wtd daemon` while another daemon serves this host's socket
- **THEN** stderr is `wtd daemon: already running`, the running daemon is unaffected, and the exit code is 1

#### Scenario: Foreground daemon leaves the caller's cgroup
- **WHEN** the user runs `wtd daemon` from a process under the user manager
- **THEN** the daemon runs in a daemon scope, not the caller's cgroup, and still exits 0 on `SIGTERM`

### Requirement: Hub command
`wtd hub` SHALL run the hub in the foreground until it receives `SIGTERM`, `SIGINT` or an authenticated shutdown request, then exit 0, placing itself in a scope of its own as hub placement states (see `hub`). A start failure — another hub running, the port in use, an invalid configuration, a missing web bundle, or an unusable token file — SHALL print one line naming the cause to stderr, without a stack trace, and exit 1.

#### Scenario: Foreground run and signal stop
- **WHEN** the user runs `wtd hub` and later sends it `SIGTERM`
- **THEN** the hub serves until the signal, removes its hub record, and exits 0

#### Scenario: Second hub refused
- **WHEN** the user runs `wtd hub` while another hub is running
- **THEN** stderr is `wtd hub: already running`, the running hub is unaffected, and the exit code is 1

#### Scenario: Port in use
- **WHEN** the configured port is held by another process and the user runs `wtd hub`
- **THEN** stderr is `wtd hub: port <port> is in use` and the exit code is 1

#### Scenario: Foreground hub leaves the caller's cgroup
- **WHEN** the user runs `wtd hub` from a process under the user manager
- **THEN** the hub runs in a hub scope, not the caller's cgroup, and still exits 0 on `SIGTERM`
