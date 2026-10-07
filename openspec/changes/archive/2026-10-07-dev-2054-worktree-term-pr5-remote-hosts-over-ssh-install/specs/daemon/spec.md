## MODIFIED Requirements

### Requirement: Handshake and version mismatch
On every new connection the daemon SHALL send `hello` with `protocol` equal to `PROTOCOL_VERSION`, its package version, and an `instance` chosen at random once per process start. If the client's first message is not `hello`, the daemon SHALL send `error{req: null, code: bad-message}` and close. If the client's `hello` carries a different `protocol`, the connection SHALL accept only the frozen `shutdown` message; every other frame, including undecodable ones, SHALL get `error{req: null, code: version-mismatch}`.

#### Scenario: Daemon hello
- **WHEN** a client connects
- **THEN** the first frame it receives is the daemon's `hello` with `protocol` 5

#### Scenario: Message before hello
- **WHEN** a client's first message is a `watchRepo`
- **THEN** the daemon replies `error` with code `bad-message` and closes the connection

#### Scenario: Mismatched client can only shut down
- **WHEN** a client sends `hello` with `protocol` 1, then a `watchRepo`, then `shutdown`
- **THEN** the `watchRepo` gets `error{req: null, code: version-mismatch}` and the `shutdown` stops the daemon

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
