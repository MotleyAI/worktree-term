## MODIFIED Requirements

### Requirement: Version output
`wtd --version` SHALL print `wtd <package version> (protocol <PROTOCOL_VERSION>)` and a newline to stdout and exit 0.

#### Scenario: Version
- **WHEN** the user runs `wtd --version`
- **THEN** stdout is `wtd <package version> (protocol 5)` followed by a newline, stderr is empty, and the exit code is 0

### Requirement: Help output
`wtd --help` SHALL print usage to stdout and exit 0. Usage SHALL list the commands `ui`, `hub`, `daemon`, `connect`, `install-local [--systemd]` and `install-remote <alias> [--node <path>]`, and the options `--help` and `--version`.

#### Scenario: Help
- **WHEN** the user runs `wtd --help`
- **THEN** stdout lists every command and option above, stderr is empty, and the exit code is 0

### Requirement: Usage errors
Running `wtd` with no arguments, an unknown command, an option the command does not take, `--node` without a value, or `install-remote` without an alias SHALL print a one-line error and the usage to stderr, print nothing to stdout, and exit 2.

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

### Requirement: Connect command
`wtd connect` SHALL connect to this host's daemon socket, starting the daemon first if no daemon is serving it, and then relay bytes unchanged from stdin to the socket and from the socket to stdout. When stdin ends it SHALL half-close the socket; when the socket closes it SHALL flush stdout and exit 0. If the daemon cannot be reached or started, or the socket fails, it SHALL print one line naming the cause to stderr and exit 1.

#### Scenario: Bridge over a pipe with auto-start
- **WHEN** no daemon is running and a process runs `wtd connect` with piped stdio
- **THEN** a daemon is started and the first frame on stdout is the daemon's `hello` with `protocol` 5

#### Scenario: Requests relayed
- **WHEN** the client writes `hello` and a `watchRepo` frame to `wtd connect`'s stdin
- **THEN** the daemon's `repoState` and `done` frames appear on stdout unchanged

#### Scenario: Socket close ends the bridge
- **WHEN** the client sends `shutdown` through `wtd connect`
- **THEN** the daemon exits, `wtd connect` exits 0, and the next `wtd connect` starts a daemon with a different `instance`

## ADDED Requirements

### Requirement: Install commands
`wtd install-local [--systemd]` SHALL perform a local installation, with the systemd option when `--systemd` is given. `wtd install-remote <alias> [--node <path>]` SHALL perform a remote installation to `<alias>`, with the given Node path when `--node` is given. On success each SHALL print one line to stdout naming the installed version and where it was installed and exit 0; on failure, one line naming the cause to stderr, without a stack trace, and exit 1.

#### Scenario: Local install into a home
- **WHEN** the user runs `wtd install-local` with `HOME` set to an empty directory
- **THEN** stdout names the version, the exit code is 0, and `$HOME/.local/bin/wtd --version` prints the same version

#### Scenario: Remote install through SSH
- **WHEN** the user runs `wtd install-remote box` and the SSH command reaches a Linux host with Node 20 or later
- **THEN** stdout names the version and `box`, and the exit code is 0

#### Scenario: Remote install failure
- **WHEN** the user runs `wtd install-remote box` and `box` cannot be reached
- **THEN** stderr is one line naming the cause and the exit code is 1
