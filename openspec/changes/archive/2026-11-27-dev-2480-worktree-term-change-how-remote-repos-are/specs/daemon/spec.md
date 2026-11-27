## ADDED Requirements

### Requirement: Repo origin
A repo's origin SHALL be its normalized `origin` URL: the first `url` of `[remote "origin"]` in the repository's own configuration file (`.git/config`, or `config` of a bare repository), ignoring included files and URL rewrites; null when there is none, when it is empty, when it names a local path or a `file:` URL, or when it does not parse as below. A URL `<scheme>://[<user>@]<host>[:<port>]/<path>` with `<scheme>` one of `ssh`, `git+ssh`, `ssh+git`, `git`, `http`, `https` SHALL normalize to `<host>[:<port>]/<path>`, the port kept only when it differs from the scheme's default (22 for the SSH schemes, 9418 for `git`, 80 for `http`, 443 for `https`). A URL `[<user>@]<host>:<path>` without `://`, whose part before the first `:` holds no `/`, SHALL normalize to `<host>/<path>`. An IPv6 host SHALL keep its brackets. In both forms the user SHALL be dropped, the host lowercased, the path's case kept, leading `/` and `~/` removed from the path, then trailing `/` and one trailing `.git` removed. A URL with any other scheme, holding whitespace, a control character, `?` or `#`, with an empty host or path, or normalizing to more than 4096 characters, SHALL have a null origin.

#### Scenario: Equivalent GitHub URLs
- **WHEN** three repos have `origin` `git@github.com:Acme/App.git`, `ssh://git@GitHub.com/Acme/App` and `https://github.com/Acme/App.git/`
- **THEN** each has origin `github.com/Acme/App`

#### Scenario: Ports kept unless default
- **WHEN** repos have `origin` `ssh://git@host:22/x`, `ssh://git@host:2222/x` and `https://host:443/x`
- **THEN** their origins are `host/x`, `host:2222/x` and `host/x`

#### Scenario: Path case kept
- **WHEN** repos have `origin` `https://example.com/Org/Repo` and `https://example.com/org/repo`
- **THEN** their origins differ

#### Scenario: Credentials dropped
- **WHEN** a repo's `origin` is `https://user:secret@github.com/acme/app`
- **THEN** its origin is `github.com/acme/app`

#### Scenario: IPv6 host
- **WHEN** a repo's `origin` is `ssh://git@[FE80::1]:2222/srv/app.git`
- **THEN** its origin is `[fe80::1]:2222/srv/app`

#### Scenario: Local and unsupported origins are null
- **WHEN** repos have `origin` `/srv/app.git`, `../app`, `file:///srv/app`, `ftp://host/app`, `https://host/app?x=1`, or no `origin` remote
- **THEN** each has a null origin

#### Scenario: First URL counts
- **WHEN** a repo's `[remote "origin"]` lists `url` `https://a.example/x` and then `https://b.example/x`
- **THEN** its origin is `a.example/x`

## MODIFIED Requirements

### Requirement: Repo watching
`watchRepo{repo}` SHALL succeed iff `git worktree list` succeeds for `repo` and `repo` equals the main worktree path it lists, which is a real path; otherwise it SHALL fail with `not-a-repo`. A repo SHALL therefore have exactly one name, shared by every connection. On success the daemon SHALL send `repoState` then `done`; watching an already watched repo SHALL send both again. `repoState` SHALL hold the repo's origin, as the repo origin requirement states and read each time `repoState` is sent, the current worktree list, every live terminal of the repo (including terminals whose worktree has vanished), the repo's checked worktree paths and its layouts. A repo with more than 1024 worktrees SHALL fail with `internal`. `unwatchRepo` for a repo this connection does not watch SHALL fail with `not-watched`; otherwise it SHALL end the subscription and detach this connection from that repo's terminals.

#### Scenario: Watch a repo
- **WHEN** a client watches a repo with two worktrees
- **THEN** it receives `repoState` listing both, with the main worktree marked `main`, then `done`

#### Scenario: Not a repo
- **WHEN** a client watches a directory that is not a git repository
- **THEN** the request fails with `not-a-repo`

#### Scenario: Linked worktree path is not a repo
- **WHEN** a client watches the path of a linked worktree
- **THEN** the request fails with `not-a-repo`

#### Scenario: Alias of a repo is not a repo
- **WHEN** a client watches a repo through a symbolic link or a path with a `.` segment
- **THEN** the request fails with `not-a-repo`

#### Scenario: Unwatch without watch
- **WHEN** a client unwatches a repo it does not watch
- **THEN** the request fails with `not-watched`

#### Scenario: Repo state names the origin
- **WHEN** a client watches a repo whose `origin` URL is `git@github.com:Acme/App.git`
- **THEN** its `repoState` has `origin` "github.com/Acme/App"

#### Scenario: Changed origin seen at the next watch
- **WHEN** a watched repo's `origin` URL is changed with `git remote set-url` and the repo is watched again
- **THEN** the new `repoState` carries the new origin


### Requirement: Repo discovery
`discoverRepos{roots, depth}` SHALL return, sorted by path and without duplicates, `{path, origin}` for each repository found at most `depth` directory levels below each root, the root itself counting as level 0. A root `~` SHALL mean the daemon's home directory and a root `~/<rest>` the path `<rest>` below it. A repository SHALL be a directory containing a `.git` directory, or a bare repository. Directories containing a `.git` file SHALL NOT be reported. The search SHALL NOT descend into a found repository, a symbolic link, a hidden directory or `node_modules`, and SHALL skip missing roots and unreadable directories. Directories SHALL be visited in sorted order and the result SHALL hold at most the first 4096 repositories in that order. Each root SHALL be resolved to its real path before the search, so every reported repository is a real path. Each `origin` SHALL be the repository's origin as the repo origin requirement states, read from its configuration file without starting a process per repository.

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

#### Scenario: Discovered repos carry their origins
- **WHEN** a root holds a repo whose `origin` is `https://github.com/acme/app.git` and a repo without `origin`
- **THEN** the daemon reports them with `origin` "github.com/acme/app" and null

