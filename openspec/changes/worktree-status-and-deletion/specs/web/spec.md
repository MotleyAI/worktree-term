## MODIFIED Requirements

### Requirement: Worktree sidebar
The sidebar SHALL list the selected repo's worktrees in the daemon's order without bare entries, each labelled with its branch, or `<directory name> @ <first 7 digits of head>` when detached, or the directory name when it has no head. On hover a worktree SHALL show its path followed by one line `<preset> <id>: <status>` per terminal, or "no terminals", where the status is `waiting for input` (`state` `input`), `running` (`state` `working`), `done` (`state` `idle` and `unseen`), `idle` (`state` `idle`), `exited`, `exited with code <code>` or `killed by <signal>`, the exit taking precedence. A prunable worktree SHALL be shown greyed and SHALL offer no new terminal. A worktree no longer listed that still has live terminals SHALL be listed after the others, marked as gone, without a checkbox, until its last terminal closes. Each listed worktree SHALL have a checkbox reflecting the daemon's checked state, and toggling it SHALL send `setChecked`. Worktree list changes SHALL show without user action.

#### Scenario: Labels
- **WHEN** worktrees are on branch `feature/x`, detached at `0123456789…` in directory `wt2`, and bare
- **THEN** the sidebar shows `feature/x` and `wt2 @ 0123456`, and no bare entry

#### Scenario: Status on hover
- **WHEN** a worktree has a terminal `probe` 3 printing continuously and a terminal `probe` 4 that exited with code 1
- **THEN** hovering it shows its path, `probe 3: running` and `probe 4: exited with code 1`

#### Scenario: Vanished worktree keeps its terminals
- **WHEN** a worktree with a running terminal is removed with `git worktree remove --force`
- **THEN** it stays listed as gone, its terminal remains usable, and it disappears after the terminal is closed

#### Scenario: Checkbox shared
- **WHEN** a worktree is checked in one page
- **THEN** it shows as checked in another page connected to the same hub

## ADDED Requirements

### Requirement: Deleting worktrees
Right-clicking a worktree SHALL open a menu offering "Delete worktree", disabled with the reason on hover for the main worktree, a locked or gone worktree, or while its host is not `connected`; Escape or a press outside SHALL close the menu. Choosing it SHALL send `removeWorktree` with `force` false. On `done` nothing more SHALL be asked. On `worktreeAtRisk` the page SHALL show an in-page confirmation naming the worktree, listing every reason that applies — the commits not in the base ref, or that there is no `origin/main` to check against; the uncommitted changes, untracked files included; the running terminals that will be closed, by preset and id — and saying that its branch is kept or, for a detached worktree, that its commits not in `origin/main` will be reachable only through the reflog; confirming SHALL send `removeWorktree` with `force` true, cancelling SHALL send nothing. A failure SHALL be shown on the page.

#### Scenario: Clean worktree deleted without asking
- **WHEN** the user deletes a worktree whose branch is in `origin/main`, without changes or running terminals
- **THEN** it disappears from the sidebar, its directory is gone and no confirmation was shown

#### Scenario: Every reason listed
- **WHEN** the user deletes a worktree with one commit not in `origin/main`, one untracked file and a running terminal `probe` 5
- **THEN** the confirmation lists "It has 1 commit not in origin/main.", "It has 1 uncommitted change, untracked files included." and "Running terminals will be closed: probe 5."

#### Scenario: Detached worktree
- **WHEN** the user deletes a detached worktree with one commit not in `origin/main`
- **THEN** the confirmation lists that commit and says its commits will be reachable only through the reflog

#### Scenario: Cancel keeps the worktree
- **WHEN** the user cancels that confirmation
- **THEN** nothing is sent and the worktree and its terminal remain

#### Scenario: Confirm deletes it
- **WHEN** the user confirms it
- **THEN** the worktree disappears, its terminal is closed and its branch remains

#### Scenario: Main worktree
- **WHEN** the user right-clicks the main worktree
- **THEN** "Delete worktree" is disabled and says the main worktree cannot be deleted
