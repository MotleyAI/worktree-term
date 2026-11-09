## MODIFIED Requirements

### Requirement: Deleting worktrees
Right-clicking a worktree other than the main one SHALL open a menu offering "Delete worktree", disabled with the reason on hover for a locked or gone worktree, or while its host is not `connected`; right-clicking the main worktree SHALL open no menu and close an open one; Escape or a press outside SHALL close the menu. Choosing it SHALL send `removeWorktree` with `force` false. On `done` nothing more SHALL be asked. On `worktreeAtRisk` the page SHALL show an in-page confirmation naming the worktree, listing every reason that applies — the commits not in the bases, or that there is no base branch to check against; the uncommitted changes, untracked files included; the running terminals that will be closed, by preset and id — and saying that its branch is kept or, for a detached worktree, that its commits not in the bases become unreachable, naming its head commit; confirming SHALL send `removeWorktree` with `force` true, cancelling SHALL send nothing. The bases SHALL be named as the entries of `bases` in order, each one that is the `ref` of a `fetchFailed` entry followed by " as last fetched", the last two joined by " or " and every other by ", "; the commits sentence SHALL then go on, for each `fetchFailed` entry in order, "; couldn't compare with a fresh <ref> because the fetch failed: <reason>" with that entry's `ref` and `reason`, and end with ".". Without bases the sentence SHALL be "There is no base branch to check that its commits are merged.". Both the commits sentence and the detached note SHALL use the same naming of the bases. A failure SHALL be shown on the page.

#### Scenario: Clean worktree deleted without asking
- **WHEN** the user deletes a worktree whose branch is in the local `main`, without changes or running terminals
- **THEN** it disappears from the sidebar, its directory is gone and no confirmation was shown

#### Scenario: Every reason listed
- **WHEN** the user deletes a worktree with one commit in neither `main` nor `origin/main`, one untracked file and a running terminal `probe` 5
- **THEN** the confirmation lists "It has 1 commit not in main or origin/main.", "It has 1 uncommitted change, untracked files included." and "Running terminals will be closed: probe 5."

#### Scenario: Only one base exists
- **WHEN** the daemon reports 2 commits ahead with `bases` ["main"], or with `bases` ["origin/master"]
- **THEN** the confirmation lists "It has 2 commits not in main." or "It has 2 commits not in origin/master." respectively

#### Scenario: The base is named
- **WHEN** the daemon reports 3 commits ahead with `bases` ["feature-x", "origin/feature-x", "main", "origin/main"] and no failed fetch
- **THEN** the confirmation lists "It has 3 commits not in feature-x, origin/feature-x, main or origin/main."

#### Scenario: Stacked worktree with unmerged commits
- **WHEN** the user deletes a worktree whose branch was created from `feature-x`, with one commit in none of `feature-x`, `origin/feature-x`, `main` and `origin/main`
- **THEN** the confirmation lists "It has 1 commit not in feature-x, origin/feature-x, main or origin/main."

#### Scenario: Fetch failed
- **WHEN** the user deletes a worktree with one commit in neither `main` nor `origin/main` as last fetched, and the remote cannot be reached
- **THEN** the confirmation lists "It has 1 commit not in main or origin/main as last fetched; couldn't compare with a fresh origin/main because the fetch failed: " followed by git's reason and "."

#### Scenario: Two fetches failed
- **WHEN** the daemon reports 1 commit ahead with `bases` ["feature-x", "origin/feature-x", "main", "origin/main"] and `fetchFailed` [`{ref: "origin/feature-x", reason: "r1"}`, `{ref: "origin/main", reason: "r2"}`]
- **THEN** the confirmation lists "It has 1 commit not in feature-x, origin/feature-x as last fetched, main or origin/main as last fetched; couldn't compare with a fresh origin/feature-x because the fetch failed: r1; couldn't compare with a fresh origin/main because the fetch failed: r2."

#### Scenario: Failed ref not among the bases
- **WHEN** the daemon reports 1 commit ahead with `bases` ["main"] and `fetchFailed` [`{ref: "origin/main", reason: "r"}`]
- **THEN** the confirmation lists "It has 1 commit not in main; couldn't compare with a fresh origin/main because the fetch failed: r."

#### Scenario: No base to compare with
- **WHEN** the daemon reports `bases` empty and `ahead` null
- **THEN** the confirmation lists "There is no base branch to check that its commits are merged."

#### Scenario: Detached worktree
- **WHEN** the user deletes a detached worktree with one commit in neither `main` nor `origin/main`
- **THEN** the confirmation lists that commit, says "It has no branch: once it is deleted, its commits not in main or origin/main become unreachable" and names its head

#### Scenario: Detached worktree after a failed fetch
- **WHEN** the daemon reports a detached worktree's commits with `bases` ["main", "origin/main"] and a `fetchFailed` entry for "origin/main"
- **THEN** the detached note says its commits not in main or origin/main as last fetched become unreachable

#### Scenario: Detached worktree without a base
- **WHEN** the daemon reports a detached worktree with `bases` empty
- **THEN** the detached note says "It has no branch: once it is deleted, its commits become unreachable" and names its head

#### Scenario: Fetch reason cannot reshape the dialog
- **WHEN** a `fetchFailed` entry's `reason` contains markup such as `<b>`
- **THEN** it is shown as literal text in the commits sentence

#### Scenario: Cancel keeps the worktree
- **WHEN** the user cancels that confirmation
- **THEN** nothing is sent and the worktree and its terminal remain

#### Scenario: Confirm deletes it
- **WHEN** the user confirms it
- **THEN** the worktree disappears, its terminal is closed and its branch remains

#### Scenario: Main worktree
- **WHEN** the user right-clicks the main worktree
- **THEN** no menu opens, and an open worktree menu closes
