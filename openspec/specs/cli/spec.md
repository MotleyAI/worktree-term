# cli Specification

## Purpose
The `wtd` command line surface: how a user discovers its commands and version, and how it reports misuse.

## Requirements

### Requirement: Version output
`wtd --version` SHALL print `wtd <package version> (protocol <PROTOCOL_VERSION>)` and a newline to stdout and exit 0.

#### Scenario: Version
- **WHEN** the user runs `wtd --version`
- **THEN** stdout is `wtd <package version> (protocol 1)` followed by a newline, stderr is empty, and the exit code is 0

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
