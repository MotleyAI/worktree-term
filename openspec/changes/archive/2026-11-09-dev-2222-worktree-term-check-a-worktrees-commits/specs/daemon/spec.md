## MODIFIED Requirements

### Requirement: Worktree removal
`removeWorktree{req, worktree, force}` SHALL fail with `unknown-worktree` unless the worktree is in the current list of a repo this connection watches, and with `busy` for the main worktree or a locked one. Without `force`, the daemon SHALL determine what removal would put at risk.
The default branch SHALL be the first of: the branch `origin/HEAD` names, `main`, `master`, for which a local branch or an `origin` remote-tracking ref of that name exists.
For a worktree on a branch `<b>`, the base candidates SHALL be, in order: its upstream `<x>`, when `branch.<b>.remote` is `origin` or `.` and `branch.<b>.merge` has exactly one value, `refs/heads/<x>`; then the branch it was created from, when the oldest entry of `<b>`'s reflog reads `branch: Created from <ref>`, `<x>` being `<ref>` without a leading `refs/heads/`, `refs/remotes/origin/` or `origin/`. A candidate SHALL be skipped when it is `<b>` or `HEAD`, is not a valid branch name, is also the name of a tag, or when neither a local branch `<x>` nor the remote-tracking ref `origin/<x>` exists. The base SHALL be the first candidate not skipped; a detached worktree, or one without such a candidate, has no base. The base and the default branch SHALL be determined once per removal.
`bases` SHALL be, in this order and each only when it exists, the base's local branch, `origin/<base>`, the default branch's local branch and its `origin` remote-tracking ref, remote-tracking refs shown without `refs/remotes/` (e.g. `origin/main`), no ref listed twice. `ahead` SHALL be null when `bases` is empty, else 0 for a worktree without a head, else the number of commits reachable from the worktree's head and from none of `bases`.
Only when that number is not 0 and the repo has a remote named `origin` SHALL the daemon fetch from `origin`, concurrently, without prompting for credentials and each within 20 seconds: the default branch into its remote-tracking ref, when there is a default branch, and the base into `origin/<base>`, when there is a base and `origin/<base>` existed before the fetch. Each fetch SHALL update its remote-tracking ref whatever `origin`'s configured refspec. After the fetches, `bases` and `ahead` SHALL be determined again from the worktree's current head. `fetchFailed` SHALL list, the base's first, `{ref, reason}` for each fetch that failed or after which its remote-tracking ref does not exist, `ref` being that ref's name as in `bases` and `reason` git's first non-empty line of error output with control characters replaced by spaces, `timed out after 20 s`, or that the ref is missing after the fetch, at most 1024 characters; `fetchFailed` SHALL be empty in every other case.
`changes` SHALL be the number of uncommitted changes in its directory, untracked files included and ignored files not (0 when its directory is gone), counted after any fetch; `running` the ids of its terminals that have not exited. When `ahead` is not 0, `changes` is not 0 or `running` is not empty, it SHALL answer `worktreeAtRisk` with those values and change nothing. Otherwise, and always with `force`, it SHALL remove the worktree — `git worktree remove` of that worktree alone, with `--force` when `force` is set, also when its directory is gone — keeping its branch, then close every terminal of the worktree, sending `termClosed` to the repo's watchers, and answer `done`. With `force` it SHALL neither count commits nor fetch. A failed removal SHALL answer `error` naming git's message and close no terminal. A removal SHALL first wait for terminals still starting in the worktree, which then count as running; while a removal of a worktree is in progress, `createTerm` and `removeWorktree` for it SHALL fail with `busy`.

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
- **WHEN** a worktree without a base, with one commit in neither `main` nor `origin/main`, one untracked file and a running terminal is removed without `force`
- **THEN** the requester receives `worktreeAtRisk` with `bases` ["main", "origin/main"], `ahead` 1, `fetchFailed` empty, `changes` 1 and that terminal's id, and the worktree and terminal remain

#### Scenario: Remote unreachable
- **WHEN** the remote cannot be reached and a worktree without a base has one commit in neither the local `main` nor `origin/main` as last fetched
- **THEN** the requester receives `worktreeAtRisk` with `bases` ["main", "origin/main"], `ahead` 1 and `fetchFailed` [`{ref: "origin/main", reason}`] with a non-empty `reason`

#### Scenario: Fetch reason is one clean line
- **WHEN** a failed fetch's error output starts with blank lines and contains control characters
- **THEN** its `reason` is its first non-empty line with each control character replaced by a space

#### Scenario: Fetch timed out
- **WHEN** the fetch does not finish within 20 seconds
- **THEN** it is stopped and its `reason` is "timed out after 20 s"

#### Scenario: Fetch updates the remote-tracking ref whatever the configured refspec
- **WHEN** the repo's `origin` has a fetch refspec that does not map `main`, its `origin/main` is stale, and a worktree merged on the remote since is removed without `force`
- **THEN** the fetch updates `origin/main`, nothing is ahead, and the worktree is removed

#### Scenario: Origin present but unusable
- **WHEN** the repo has a remote named `origin` whose URL is not a repository, and a worktree without a base with one commit not in the local `main` is removed without `force`
- **THEN** the requester receives `worktreeAtRisk` with `bases` ["main"], `ahead` 1 and `fetchFailed` [`{ref: "origin/main", reason}`]

#### Scenario: No origin, local main only
- **WHEN** a worktree without a base of a repo without an `origin` has one commit not in the local `main`, and is removed without `force`
- **THEN** the requester receives `worktreeAtRisk` with `bases` ["main"], `ahead` 1 and `fetchFailed` empty, and no fetch is attempted

#### Scenario: Default branch from origin/HEAD
- **WHEN** `origin/HEAD` names `origin/develop`, both `develop` and `main` exist, and a worktree without a base with one commit in `main` but not in `develop` nor `origin/develop` is removed without `force` while the remote cannot be reached
- **THEN** the requester receives `worktreeAtRisk` with `bases` ["develop", "origin/develop"] and `ahead` 1

#### Scenario: Default branch fallbacks
- **WHEN** `origin/HEAD` is absent or names a missing ref, and a worktree without a base is removed from a repo that has only a local `master`, or only `origin/main`, or both `main` and `master` and no `origin`
- **THEN** `bases` is respectively ["master"], ["origin/main"] and ["main"]

#### Scenario: Merged into its base
- **WHEN** a worktree whose branch was created from `feature-x` has every commit in the local `feature-x`, one of them in neither `main` nor `origin/main`, and is removed without `force`
- **THEN** no fetch is attempted, the worktree is removed and the requester receives `done`

#### Scenario: Unmerged commits name the base
- **WHEN** a worktree whose branch was created from `feature-x` has one commit in none of `feature-x`, `origin/feature-x`, `main` and `origin/main`, and is removed without `force` while the remote cannot be reached
- **THEN** the requester receives `worktreeAtRisk` with `bases` ["feature-x", "origin/feature-x", "main", "origin/main"], `ahead` 1 and `fetchFailed` with `ref` "origin/feature-x" and then "origin/main"

#### Scenario: Merged into the default branch past a stale base
- **WHEN** a worktree whose branch was created from `feature-x` has every commit in `main`, one of them not in `feature-x`, and is removed without `force`
- **THEN** the worktree is removed and the requester receives `done`

#### Scenario: Base merged on the remote since the last fetch
- **WHEN** a worktree's base is `feature-x`, `origin/feature-x` exists but is stale and not mapped by `origin`'s fetch refspec, and the worktree's commits were merged into the remote's `feature-x` since, and it is removed without `force`
- **THEN** the daemon fetches `feature-x` into `origin/feature-x`, finds nothing ahead, and removes the worktree

#### Scenario: Untracked base not fetched
- **WHEN** a worktree's base `feature-x` exists only as a local branch, the repo has an `origin`, and the worktree has one commit in none of `feature-x`, `main` and `origin/main`
- **THEN** only `main` is fetched, and the requester receives `worktreeAtRisk` with `bases` ["feature-x", "main", "origin/main"], `ahead` 1 and `fetchFailed` empty

#### Scenario: Base fetch fails while the default fetch succeeds
- **WHEN** a worktree's base is `feature-x`, `origin/feature-x` exists but `feature-x` is gone from the remote, and the worktree has one commit in none of the bases after `main` is fetched
- **THEN** the requester receives `worktreeAtRisk` with `bases` ["feature-x", "origin/feature-x", "main", "origin/main"], `ahead` 1 and `fetchFailed` [`{ref: "origin/feature-x", reason}`] only

#### Scenario: Fetches run concurrently
- **WHEN** both `origin/feature-x` and `origin/main` are fetched and the remote does not answer
- **THEN** the requester receives `worktreeAtRisk` after one fetch time limit, not two, with both fetches in `fetchFailed`, each with `reason` "timed out after 20 s"

#### Scenario: Base equal to the default branch
- **WHEN** a worktree whose branch was created from `origin/main` has one commit not in `main` nor `origin/main`
- **THEN** `bases` is ["main", "origin/main"] and `main` is fetched once

#### Scenario: Base from the upstream
- **WHEN** a worktree's branch was created from `main` and its upstream is `refs/heads/feature-x` on `.` or on `origin`, and all its commits are in `feature-x` only
- **THEN** its base is `feature-x` and it is removed without asking

#### Scenario: Upstream not taken as the base
- **WHEN** a worktree's branch `feat` has its upstream `refs/heads/feat` on `origin`, or an upstream on a remote other than `origin`, or two `merge` values, and was created from `feature-x`
- **THEN** its base is `feature-x`

#### Scenario: Creation source that is not a branch
- **WHEN** a worktree's branch was created from `HEAD`, `HEAD~1`, a commit id, a tag `v1` (also when a branch `v1` exists), or `upstream/main` of a remote other than `origin`, and it has no usable upstream
- **THEN** it has no base, and `bases` are the default branch's

#### Scenario: No creation record
- **WHEN** a worktree's branch has no reflog, or its oldest surviving reflog entry is not a creation, and it has no usable upstream
- **THEN** it has no base, and `bases` are the default branch's

#### Scenario: Vanished candidate falls through
- **WHEN** a worktree's upstream names `feature-y`, of which neither a local branch nor `origin/feature-y` exists, and its branch was created from `feature-x`, which exists
- **THEN** its base is `feature-x`; and when `feature-x` is gone as well, it has no base

#### Scenario: Base names with slashes and dots
- **WHEN** a worktree's branch `egor/feat.2` was created from `release/1.2`
- **THEN** its base is `release/1.2` and `bases` starts with "release/1.2"

#### Scenario: Detached worktree compared with the default branch
- **WHEN** a detached worktree with one commit not in `main` nor `origin/main` is removed without `force`
- **THEN** `bases` is ["main", "origin/main"]

#### Scenario: Terminal starting during a removal
- **WHEN** a terminal of the worktree is still starting when `removeWorktree` without `force` arrives
- **THEN** the removal waits for it and answers `worktreeAtRisk` listing it as running

#### Scenario: No terminal starts in a worktree being removed
- **WHEN** `createTerm` for a worktree arrives while its removal is in progress
- **THEN** it fails with `busy` and no terminal starts

#### Scenario: No base to compare with
- **WHEN** a worktree without a base, of a repo without an `origin` and without a `main` or `master` branch, is removed without `force`, whether or not it has a head
- **THEN** the requester receives `worktreeAtRisk` with `bases` empty, `ahead` null and `fetchFailed` empty, and the worktree remains

#### Scenario: Worktree without a head
- **WHEN** a worktree without a head, in a repo with a local `main`, is removed without `force`
- **THEN** `ahead` is 0 and no fetch is attempted

#### Scenario: Forced removal
- **WHEN** that worktree at risk is removed with `force`
- **THEN** no commits are counted and no fetch is attempted, its directory is gone, its branch remains, its running terminal is closed, and the requester receives `done`

#### Scenario: Main and locked worktrees refused
- **WHEN** the main worktree or a locked worktree is removed, even with `force`
- **THEN** the requester receives `error` with code `busy` and nothing changes
