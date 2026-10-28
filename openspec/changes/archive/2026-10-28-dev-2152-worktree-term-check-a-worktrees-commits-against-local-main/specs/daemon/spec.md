## MODIFIED Requirements

### Requirement: Worktree removal
`removeWorktree{req, worktree, force}` SHALL fail with `unknown-worktree` unless the worktree is in the current list of a repo this connection watches, and with `busy` for the main worktree or a locked one. Without `force`, the daemon SHALL determine what removal would put at risk. The default branch SHALL be the first of: the branch `origin/HEAD` names, `main`, `master`, for which a local branch or an `origin` remote-tracking ref of that name exists; `local` SHALL be that local branch's name and `remote` that remote-tracking ref shown without `refs/remotes/` (e.g. `origin/main`), each null when it does not exist, both null without a default branch. `ahead` SHALL be null when `local` and `remote` are both null, else 0 for a worktree without a head, else the number of commits reachable from the worktree's head and from neither `local` nor `remote`. Only when that number is not 0 and the repo has a remote named `origin` SHALL the daemon fetch the default branch from `origin` into its remote-tracking ref, without prompting for credentials and within 20 seconds; when the fetch succeeds and the remote-tracking ref then exists, `remote` and `ahead` SHALL be determined again from it; otherwise `fetchFailed` SHALL be `{ref, reason}`, `ref` being the remote-tracking ref's name as for `remote` and `reason` git's first non-empty line of error output with control characters replaced by spaces, `timed out after 20 s`, or that the ref is missing after the fetch, at most 1024 characters, and `local`, `remote` and `ahead` SHALL keep the values from before the fetch. `fetchFailed` SHALL be null in every other case. `changes` SHALL be the number of uncommitted changes in its directory, untracked files included and ignored files not (0 when its directory is gone); `running` the ids of its terminals that have not exited. When `ahead` is not 0, `changes` is not 0 or `running` is not empty, it SHALL answer `worktreeAtRisk` with those values and change nothing. Otherwise, and always with `force`, it SHALL remove the worktree — `git worktree remove` of that worktree alone, with `--force` when `force` is set, also when its directory is gone — keeping its branch, then close every terminal of the worktree, sending `termClosed` to the repo's watchers, and answer `done`. With `force` it SHALL neither count commits nor fetch. A failed removal SHALL answer `error` naming git's message and close no terminal. A removal SHALL first wait for terminals still starting in the worktree, which then count as running; while a removal of a worktree is in progress, `createTerm` and `removeWorktree` for it SHALL fail with `busy`.

#### Scenario: Nothing at risk
- **WHEN** a worktree whose branch is in the local `main`, with no changes and only an exited terminal, is removed without `force`
- **THEN** its directory is gone, its branch remains, the exited terminal is closed, watchers receive `worktreesChanged` without it, and the requester receives `done`

#### Scenario: Merged into local main, remote unreachable
- **WHEN** a worktree's branch is in the local `main` but not in `origin/main`, the remote cannot be reached, and the worktree is removed without `force`
- **THEN** no fetch is attempted, and the worktree is removed and the requester receives `done`

#### Scenario: In origin/main as last fetched
- **WHEN** a worktree's branch is in `origin/main` as last fetched but not in the local `main`, and the worktree is removed without `force`
- **THEN** no fetch is attempted, and the worktree is removed and the requester receives `done`

#### Scenario: Commits split between main and origin/main
- **WHEN** a worktree's head merges two commits, one reachable only from the local `main` and the other only from `origin/main` as last fetched, the remote cannot be reached, and it is removed without `force`
- **THEN** the requester receives `worktreeAtRisk` with `ahead` 1, counting only the merge commit

#### Scenario: Merged since the last fetch
- **WHEN** a worktree's branch was merged into the remote's `main` after the repo last fetched, is not in the local `main`, and the worktree is removed without `force`
- **THEN** the daemon fetches `main` from `origin`, finds nothing ahead, and removes the worktree

#### Scenario: Every risk reported
- **WHEN** a worktree with one commit in neither `main` nor `origin/main`, one untracked file and a running terminal is removed without `force`
- **THEN** the requester receives `worktreeAtRisk` with `local` "main", `remote` "origin/main", `ahead` 1, `fetchFailed` null, `changes` 1 and that terminal's id, and the worktree and terminal remain

#### Scenario: Remote unreachable
- **WHEN** the remote cannot be reached and the worktree has one commit in neither the local `main` nor `origin/main` as last fetched
- **THEN** the requester receives `worktreeAtRisk` with `local` "main", `remote` "origin/main", `ahead` 1 and `fetchFailed` with `ref` "origin/main" and a non-empty `reason`

#### Scenario: Fetch reason is one clean line
- **WHEN** a failed fetch's error output starts with blank lines and contains control characters
- **THEN** `fetchFailed.reason` is its first non-empty line with each control character replaced by a space

#### Scenario: Fetch timed out
- **WHEN** the fetch does not finish within 20 seconds
- **THEN** it is stopped and `fetchFailed.reason` is "timed out after 20 s"

#### Scenario: Fetch updates the remote-tracking ref whatever the configured refspec
- **WHEN** the repo's `origin` has a fetch refspec that does not map `main`, its `origin/main` is stale, and a worktree merged on the remote since is removed without `force`
- **THEN** the fetch updates `origin/main`, nothing is ahead, and the worktree is removed

#### Scenario: Origin present but unusable
- **WHEN** the repo has a remote named `origin` whose URL is not a repository, and a worktree with one commit not in the local `main` is removed without `force`
- **THEN** the requester receives `worktreeAtRisk` with `remote` null, `ahead` 1 and `fetchFailed` with `ref` "origin/main"

#### Scenario: No origin, local main only
- **WHEN** a worktree of a repo without an `origin` has one commit not in the local `main`, and is removed without `force`
- **THEN** the requester receives `worktreeAtRisk` with `local` "main", `remote` null, `ahead` 1 and `fetchFailed` null, and no fetch is attempted

#### Scenario: Default branch from origin/HEAD
- **WHEN** `origin/HEAD` names `origin/develop`, both `develop` and `main` exist, and a worktree with one commit in `main` but not in `develop` nor `origin/develop` is removed without `force` while the remote cannot be reached
- **THEN** the requester receives `worktreeAtRisk` with `local` "develop", `remote` "origin/develop" and `ahead` 1

#### Scenario: Default branch fallbacks
- **WHEN** `origin/HEAD` is absent or names a missing ref, and the repo has only a local `master`, or only `origin/main`, or both `main` and `master`
- **THEN** the default branch is respectively `master` with `remote` null, `main` with `local` null, and `main`

#### Scenario: Terminal starting during a removal
- **WHEN** a terminal of the worktree is still starting when `removeWorktree` without `force` arrives
- **THEN** the removal waits for it and answers `worktreeAtRisk` listing it as running

#### Scenario: No terminal starts in a worktree being removed
- **WHEN** `createTerm` for a worktree arrives while its removal is in progress
- **THEN** it fails with `busy` and no terminal starts

#### Scenario: No base to compare with
- **WHEN** a worktree of a repo without an `origin` and without a `main` or `master` branch is removed without `force`, whether or not it has a head
- **THEN** the requester receives `worktreeAtRisk` with `local`, `remote` and `ahead` null and `fetchFailed` null, and the worktree remains

#### Scenario: Worktree without a head
- **WHEN** a worktree without a head, in a repo with a local `main`, is removed without `force`
- **THEN** `ahead` is 0 and no fetch is attempted

#### Scenario: Forced removal
- **WHEN** that worktree at risk is removed with `force`
- **THEN** no commits are counted and no fetch is attempted, its directory is gone, its branch remains, its running terminal is closed, and the requester receives `done`

#### Scenario: Main and locked worktrees refused
- **WHEN** the main worktree or a locked worktree is removed, even with `force`
- **THEN** the requester receives `error` with code `busy` and nothing changes
