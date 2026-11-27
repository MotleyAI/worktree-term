## MODIFIED Requirements

### Requirement: Pull request status
The daemon SHALL report for each watched repo the pull request of each worktree branch, fetched with the `gh` CLI found on its `PATH`. The repo's GitHub repository SHALL be the one `origin`'s URL names, in the form `https://<host>/<owner>/<name>`, `<user>@<host>:<owner>/<name>` or `ssh://[<user>@]<host>[:<port>]/<owner>/<name>`, each with or without a `.git` suffix, an SSH host being resolved to its real host name through the user's SSH configuration. A worktree's branch `<b>` SHALL have a branch on `origin` only when its push remote as git resolves it (`branch.<b>.pushRemote`, else `remote.pushDefault`, else `branch.<b>.remote`) is `origin` or none is set. That branch SHALL be `<x>` when the effective `push.default` is `upstream` or `tracking`, `branch.<b>.remote` is `origin` and `branch.<b>.merge` has exactly one value, `refs/heads/<x>`; otherwise it SHALL be `<b>`, whatever `<b>` tracks. A detached or bare worktree SHALL have none. A branch's candidates SHALL be the pull requests whose head is that branch of the `origin` repository, also after that branch was deleted on GitHub, and that belong to the `origin` repository or to the repository it is a fork of; repositories SHALL be compared ignoring case. A pull request of any other repository, or whose head repository no longer exists, SHALL never be a candidate. Of several candidates, the most recently updated open or draft one SHALL be chosen, else the most recently updated one. A status SHALL give the pull request's number and URL, its `state` (`draft` for an open draft), its `checks` from its head commit's combined check status (`failing` for failure or error, `pending` for pending or expected, `passing` for success, `none` without checks), `conflicts` true exactly when GitHub reports it conflicting with its base, and its `review` decision (`approved`, `changes-requested`, `review-required`, or null without one).

The daemon SHALL refresh a repo's statuses with one request, whatever the number of worktrees: when its watch starts, when its set of worktree paths with their branches changes, and every 60 s (or `WTD_PR_INTERVAL_MS` when that is a positive integer, capped at 2147483647 ms) while it is watched; a change of `head`, `locked` or `prunable` alone SHALL NOT refresh it, and a repo no connection watches SHALL NOT be refreshed. At most one refresh per repo SHALL run at a time: a refresh asked for while one runs SHALL run once after it, and a timed refresh due while one runs SHALL be skipped. At most 4 refreshes SHALL run at a time per daemon, the others waiting in the order asked; a waiting refresh of a repo no longer watched SHALL be dropped. Every process a refresh starts SHALL be bounded in time (20 s for `gh`, 5 s for any other) and killed when it overruns.

A refresh SHALL succeed with no pull requests when the repo has no `origin`, `origin`'s URL has none of the forms above, `gh` is missing, or `gh` reports no login for the host; a refresh that times out, fails otherwise, or returns a response that does not parse SHALL change nothing and SHALL send no `error`. The daemon SHALL keep each repo's last successful statuses in memory while it runs, also after the repo is no longer watched. When a refresh succeeds with statuses that differ from those kept, or none are kept yet, the daemon SHALL send every watcher of the repo `prStatus{repo, prs}` listing the status of every branch that has a pull request. On `watchRepo` of a repo whose statuses it keeps, the daemon SHALL send `prStatus` from them after `repoState` and before `done`. No reply or event other than `prStatus` SHALL wait for a refresh.

#### Scenario: Status of an open pull request
- **WHEN** a watched repo's worktree is on branch `feature/x`, pushed to a GitHub `origin`, with an open pull request #12 whose checks fail
- **THEN** watchers receive `prStatus` listing `feature/x` with `number` 12, `state` "open" and `checks` "failing"

#### Scenario: Open pull request preferred
- **WHEN** branch `feature/x` has a closed pull request updated today and an open one updated last week
- **THEN** the status lists the open one

#### Scenario: Pull request into the parent repository
- **WHEN** `origin` is a fork and branch `feature/x` of `origin` has a pull request into the repository it is a fork of
- **THEN** the status lists that pull request

#### Scenario: Merged pull request after its branch was deleted
- **WHEN** branch `feature/x`'s pull request was merged and the branch deleted on GitHub
- **THEN** the status lists it with `state` "merged"

#### Scenario: Same branch name in another fork
- **WHEN** a pull request from another fork has head branch `feature/x` and `origin`'s `feature/x` has none
- **THEN** the status lists no pull request for `feature/x`

#### Scenario: Pull request in another repository
- **WHEN** `origin`'s `main` is the head of a merged pull request into a fork of the `origin` repository, and of none into `origin` or its parent
- **THEN** the status lists no pull request for `main`

#### Scenario: Pull request found past others of the same head
- **WHEN** `origin`'s `feature/x` is the head of five pull requests into other repositories, all updated more recently than its one pull request into `origin`
- **THEN** the status lists the pull request into `origin`

#### Scenario: Upstream names another branch
- **WHEN** a worktree's branch `feature/y` was created from `origin/main` with tracking and never pushed, `push.default` is unset, and `origin`'s `main` has a merged pull request
- **THEN** the status lists no pull request for `feature/y`

#### Scenario: Pushed to the upstream's name
- **WHEN** `push.default` is `upstream`, a worktree's branch `wip` tracks `origin/feature/x`, and `feature/x` has pull request #12
- **THEN** the status lists `wip` with `number` 12

#### Scenario: Several upstream branches
- **WHEN** `push.default` is `upstream` and a worktree's branch `multi` has two `branch.multi.merge` values
- **THEN** the daemon asks GitHub for the pull requests of `multi`

#### Scenario: Pushed to origin while tracking another remote
- **WHEN** a worktree's branch `feature/x` tracks `upstream/main` and `branch.feature/x.pushRemote` or `remote.pushDefault` is `origin`, and `origin`'s `feature/x` has a pull request
- **THEN** the status lists that pull request for `feature/x`

#### Scenario: Branch tracking another remote
- **WHEN** a worktree's branch `feature/x` tracks `upstream/feature/x` and neither `branch.feature/x.pushRemote` nor `remote.pushDefault` is set
- **THEN** the status lists no pull request for `feature/x`

#### Scenario: Branch pushed to another remote
- **WHEN** a worktree's branch `feature/x` tracks `origin/feature/x` and `branch.feature/x.pushRemote` is `upstream`
- **THEN** the status lists no pull request for `feature/x`

#### Scenario: One request per refresh
- **WHEN** a repo with 58 worktrees on distinct branches is watched
- **THEN** `gh` runs once for the first refresh, and once per later refresh

#### Scenario: Second connection served from memory
- **WHEN** a second connection watches a repo whose statuses the daemon keeps
- **THEN** it receives `prStatus` after `repoState` and before `done`, and `gh` does not run

#### Scenario: Branch change refreshes
- **WHEN** `git worktree add` adds a worktree on a new branch to a watched repo
- **THEN** `gh` runs again without waiting for the interval

#### Scenario: Commit does not refresh
- **WHEN** a commit is made in a watched worktree
- **THEN** `gh` does not run before the interval elapses

#### Scenario: Status change sent within an interval
- **WHEN** a pull request's state changes on GitHub while its repo is watched
- **THEN** watchers receive the new `prStatus` within one interval

#### Scenario: No change, no event
- **WHEN** a refresh finds the same statuses as kept
- **THEN** no `prStatus` is sent

#### Scenario: Unwatched repo not refreshed
- **WHEN** the last connection unwatches a repo
- **THEN** `gh` no longer runs for it

#### Scenario: Missing gh or login
- **WHEN** `gh` is missing on the host, or reports no login for the repo's GitHub host
- **THEN** watchers receive `prStatus` with no pull requests, and never an `error`

#### Scenario: Origin removed
- **WHEN** a watched repo whose statuses list pull requests loses its `origin` remote and refreshes
- **THEN** watchers receive `prStatus` with no pull requests

#### Scenario: Failed refresh keeps the status
- **WHEN** `gh` exits with an error or times out after statuses were sent
- **THEN** no `prStatus` and no `error` is sent, and the kept statuses are sent to a later watcher

#### Scenario: Hanging gh delays nothing
- **WHEN** `gh` never returns
- **THEN** `watchRepo` still gets `repoState` and `done` at once, `worktreesChanged` still arrives within 250 ms of `git worktree add`, and `gh` is killed after 20 s

#### Scenario: Bounded concurrency
- **WHEN** a connection watches 10 repos at once and `gh` hangs
- **THEN** at most 4 `gh` processes run at a time
