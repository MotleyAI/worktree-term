## MODIFIED Requirements

### Requirement: Version output
`wtd --version` SHALL print `wtd <package version> (protocol <PROTOCOL_VERSION>)` and a newline to stdout and exit 0.

#### Scenario: Version
- **WHEN** the user runs `wtd --version`
- **THEN** stdout is `wtd <package version> (protocol 3)` followed by a newline, stderr is empty, and the exit code is 0

## ADDED Requirements

### Requirement: Hub command
`wtd hub` SHALL run the hub in the foreground until it receives `SIGTERM`, `SIGINT` or an authenticated shutdown request, then exit 0. A start failure — another hub running, the port in use, an invalid configuration, a missing web bundle, or an unusable token file — SHALL print one line naming the cause to stderr, without a stack trace, and exit 1.

#### Scenario: Foreground run and signal stop
- **WHEN** the user runs `wtd hub` and later sends it `SIGTERM`
- **THEN** the hub serves until the signal, removes its hub record, and exits 0

#### Scenario: Second hub refused
- **WHEN** the user runs `wtd hub` while another hub is running
- **THEN** stderr is `wtd hub: already running`, the running hub is unaffected, and the exit code is 1

#### Scenario: Port in use
- **WHEN** the configured port is held by another process and the user runs `wtd hub`
- **THEN** stderr is `wtd hub: port <port> is in use` and the exit code is 1

### Requirement: UI command
`wtd ui` SHALL make a hub of its own version serve and then open the UI. If a running hub reports the same version, it SHALL be reused; if it reports another version, it SHALL be asked to shut down and a new hub started once its port is free; otherwise a hub SHALL be started detached with its output appended to `hub.log`, and `wtd ui` SHALL wait up to 5 s for it to serve. It SHALL then obtain a one-time code from the hub and start the browser command — `$WTD_BROWSER` if set, else `google-chrome` — with the argument `--app=http://127.0.0.1:<port>/#code=<code>`, detached with its stdio ignored, and exit 0. The browser's arguments SHALL never contain the token. A hub that cannot be started or reached, or a browser command that cannot be started, SHALL print one line naming the cause to stderr and exit 1. A hub record whose hub does not answer an authenticated identity request SHALL be treated as stale, and its process SHALL NOT be signalled.

#### Scenario: Hub started and browser opened
- **WHEN** no hub is running and the user runs `wtd ui`
- **THEN** a hub serves on the configured port, the browser command receives a URL with a one-time code and without the token, and the exit code is 0

#### Scenario: Running hub reused
- **WHEN** a hub of the same version is running and the user runs `wtd ui`
- **THEN** the same hub process keeps serving and the browser command is started

#### Scenario: Hub of another version replaced
- **WHEN** a hub reporting another version is running and the user runs `wtd ui`
- **THEN** that hub exits and a hub of the current version serves on the port

#### Scenario: Stale record never signals a process
- **WHEN** the hub record names a live process that is not a hub and the user runs `wtd ui`
- **THEN** that process is not signalled and a new hub is started

#### Scenario: Browser missing
- **WHEN** the browser command does not exist
- **THEN** stderr names the browser command and the exit code is 1
