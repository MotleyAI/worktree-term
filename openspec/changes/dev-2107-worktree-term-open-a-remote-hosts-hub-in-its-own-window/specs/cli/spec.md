## MODIFIED Requirements

### Requirement: Version output
`wtd --version` SHALL print `wtd <package version> (daemon protocol <DAEMON_PROTOCOL_VERSION>, browser protocol <BROWSER_PROTOCOL_VERSION>)` and a newline to stdout and exit 0.

#### Scenario: Version
- **WHEN** the user runs `wtd --version`
- **THEN** stdout is `wtd <package version> (daemon protocol 6, browser protocol 10)` followed by a newline, stderr is empty, and the exit code is 0

### Requirement: Help output
`wtd --help` SHALL print usage to stdout and exit 0. Usage SHALL list the commands `ui [<host>] [--print-code]`, `hub`, `daemon`, `connect`, `install-local [--systemd]` and `install-remote <alias> [--node <path>]`, and the options `--help` and `--version`.

#### Scenario: Help
- **WHEN** the user runs `wtd --help`
- **THEN** stdout lists every command and option above, stderr is empty, and the exit code is 0

### Requirement: Usage errors
Running `wtd` with no arguments, an unknown command, an option the command does not take, `--node` without a value, `install-remote` without an alias, a second argument to `ui`, or `ui` with both a host and `--print-code` SHALL print a one-line error and the usage to stderr, print nothing to stdout, and exit 2.

#### Scenario: No arguments
- **WHEN** the user runs `wtd`
- **THEN** stderr contains the usage, stdout is empty, and the exit code is 2

#### Scenario: Unknown command
- **WHEN** the user runs `wtd frobnicate`
- **THEN** stderr names `frobnicate` as unknown and contains the usage, and the exit code is 2

#### Scenario: Unknown option
- **WHEN** the user runs `wtd --frob`
- **THEN** stderr names `--frob` as unknown and contains the usage, and the exit code is 2

#### Scenario: Option of another command
- **WHEN** the user runs `wtd install-remote box --systemd`
- **THEN** stderr names `--systemd` as unknown for `install-remote` and contains the usage, and the exit code is 2

#### Scenario: Missing alias
- **WHEN** the user runs `wtd install-remote`
- **THEN** stderr says an alias is required and contains the usage, and the exit code is 2

#### Scenario: Missing option value
- **WHEN** the user runs `wtd install-remote box --node`
- **THEN** stderr says `--node` needs a value and contains the usage, and the exit code is 2

#### Scenario: Host and print-code together
- **WHEN** the user runs `wtd ui box --print-code`
- **THEN** stderr says a host and `--print-code` cannot be combined and contains the usage, stdout is empty, and the exit code is 2

#### Scenario: Two hosts
- **WHEN** the user runs `wtd ui a b`
- **THEN** stderr names `b` as unexpected and contains the usage, and the exit code is 2

### Requirement: UI command
`wtd ui [<host>] [--print-code]` SHALL make a hub of its own version serve. If a running hub reports the same version, it SHALL be reused; if it reports another version, it SHALL be asked to shut down and a new hub started once its port is free; otherwise a hub SHALL be started detached with its output appended to `hub.log`, and `wtd ui` SHALL wait up to 5 s for it to serve. It SHALL then obtain a one-time code from the hub. Without options it SHALL start the browser command — `$WTD_BROWSER` if set, else `google-chrome` — with the argument `--app=http://127.0.0.1:<port>/#code=<code>`, detached with its stdio ignored, and exit 0. With `<host>` it SHALL first fail, before touching any hub, with one line `wtd ui: no host named <host> in <config path>` on stderr and exit 1 unless the configuration has a remote host of that name, and SHALL otherwise start the browser command the same way with `--app=http://127.0.0.1:<port>/#code=<code>&hub=<host>`. With `--print-code` it SHALL start no browser, print exactly one print-code line holding the hub's port and the code to stdout, and exit 0. The browser's arguments and the printed line SHALL never contain the token. A hub that cannot be started or reached, or a browser command that cannot be started, SHALL print one line naming the cause to stderr and exit 1. A hub record whose hub does not answer an authenticated identity request SHALL be treated as stale, and its process SHALL NOT be signalled.

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

#### Scenario: Opening a host's hub
- **WHEN** the configuration lists remote host `box` and the user runs `wtd ui box`
- **THEN** the browser command receives `--app=http://127.0.0.1:<port>/#code=<code>&hub=box` and the exit code is 0

#### Scenario: Unknown host
- **WHEN** the configuration lists no host named `nope` and the user runs `wtd ui nope`
- **THEN** stderr is `wtd ui: no host named nope in <config path>`, no browser is started, and the exit code is 1

#### Scenario: Printing a code
- **WHEN** no hub is running and the user runs `wtd ui --print-code`
- **THEN** a hub serves, stdout is one print-code line with the hub's port and a code that the hub accepts once, no browser command is started, and the exit code is 0

#### Scenario: Printing a code replaces another version
- **WHEN** a hub reporting another version is running and the user runs `wtd ui --print-code`
- **THEN** that hub exits, a hub of the current version serves, and stdout is its print-code line
