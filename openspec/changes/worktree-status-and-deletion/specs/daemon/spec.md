## MODIFIED Requirements

### Requirement: Handshake and version mismatch
On every new connection the daemon SHALL send `hello` with `protocol` equal to `DAEMON_PROTOCOL_VERSION`, its package version, and an `instance` chosen at random once per process start. If the client's first message is not `hello`, the daemon SHALL send `error{req: null, code: bad-message}` and close. If the client's `hello` carries a different `protocol`, the connection SHALL accept only the frozen `shutdown` message; every other frame, including undecodable ones, SHALL get `error{req: null, code: version-mismatch}`.

#### Scenario: Daemon hello
- **WHEN** a client connects
- **THEN** the first frame it receives is the daemon's `hello` with `protocol` 6

#### Scenario: Message before hello
- **WHEN** a client's first message is a `watchRepo`
- **THEN** the daemon replies `error` with code `bad-message` and closes the connection

#### Scenario: Mismatched client can only shut down
- **WHEN** a client sends `hello` with `protocol` 1, then a `watchRepo`, then `shutdown`
- **THEN** the `watchRepo` gets `error{req: null, code: version-mismatch}` and the `shutdown` stops the daemon

## ADDED Requirements

### Requirement: Worktree removal
`removeWorktree{req, worktree, force}` SHALL fail with `unknown-worktree` unless the worktree is in the current list of a repo this connection watches, and with `busy` for the main worktree or a locked one. Without `force`, the daemon SHALL determine what removal would put at risk: `base`, the remote-tracking ref `origin/HEAD` names, else `origin/main`, else `origin/master`, shown without `refs/remotes/`, or null when none exists; `ahead`, the number of commits reachable from the worktree's head and not from `base` (0 without a head), counted after fetching `base`'s branch from its remote — from the local ref when that fails — or null without a base; `changes`, the number of uncommitted changes in its directory, untracked files included and ignored files not (0 when its directory is gone); `running`, the ids of its terminals that have not exited. When `ahead` is not 0, `changes` is not 0 or `running` is not empty, it SHALL answer `worktreeAtRisk` with those values and change nothing. Otherwise, and always with `force`, it SHALL remove the worktree — `git worktree remove` of that worktree alone, with `--force` when `force` is set, also when its directory is gone — keeping its branch, then close every terminal of the worktree, sending `termClosed` to the repo's watchers, and answer `done`. A failed removal SHALL answer `error` naming git's message and close no terminal. A removal SHALL first wait for terminals still starting in the worktree, which then count as running; while a removal of a worktree is in progress, `createTerm` and `removeWorktree` for it SHALL fail with `busy`.

#### Scenario: Nothing at risk
- **WHEN** a worktree whose branch is in `origin/main`, with no changes and only an exited terminal, is removed without `force`
- **THEN** its directory is gone, its branch remains, the exited terminal is closed, watchers receive `worktreesChanged` without it, and the requester receives `done`

#### Scenario: Every risk reported
- **WHEN** a worktree with one commit not in `origin/main`, one untracked file and a running terminal is removed without `force`
- **THEN** the requester receives `worktreeAtRisk` with `base` "origin/main", `ahead` 1, `changes` 1 and that terminal's id, and the worktree and terminal remain

#### Scenario: Merged since the last fetch
- **WHEN** a worktree's branch was merged into the remote's `main` after the repo last fetched, and the worktree is removed without `force`
- **THEN** the daemon fetches `origin/main` first, finds nothing ahead, and removes the worktree

#### Scenario: Remote unreachable
- **WHEN** the remote cannot be reached and the worktree has one commit not in the local `origin/main`
- **THEN** the requester receives `worktreeAtRisk` with `ahead` 1

#### Scenario: Terminal starting during a removal
- **WHEN** a terminal of the worktree is still starting when `removeWorktree` without `force` arrives
- **THEN** the removal waits for it and answers `worktreeAtRisk` listing it as running

#### Scenario: No terminal starts in a worktree being removed
- **WHEN** `createTerm` for a worktree arrives while its removal is in progress
- **THEN** it fails with `busy` and no terminal starts

#### Scenario: No base to compare with
- **WHEN** a worktree of a repo without an `origin` is removed without `force`
- **THEN** the requester receives `worktreeAtRisk` with `base` and `ahead` null, and the worktree remains

#### Scenario: Forced removal
- **WHEN** that worktree at risk is removed with `force`
- **THEN** its directory is gone, its branch remains, its running terminal is closed, and the requester receives `done`

#### Scenario: Main and locked worktrees refused
- **WHEN** the main worktree or a locked worktree is removed, even with `force`
- **THEN** the requester receives `error` with code `busy` and nothing changes
