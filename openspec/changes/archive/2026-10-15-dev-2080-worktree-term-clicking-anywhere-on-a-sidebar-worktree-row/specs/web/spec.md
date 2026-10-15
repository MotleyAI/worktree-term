## MODIFIED Requirements

### Requirement: Worktree sidebar
The sidebar SHALL list the selected repo's worktrees in the daemon's order without bare entries, each labelled with its branch, or `<directory name> @ <first 7 digits of head>` when detached, or the directory name when it has no head. On hover a worktree SHALL show its path followed by one line `<preset> <id>: <status>` per terminal, or "no terminals", where the status is `waiting for input` (`state` `input`), `running` (`state` `working`), `done` (`state` `idle` and `unseen`), `idle` (`state` `idle`), `exited`, `exited with code <code>` or `killed by <signal>`, the exit taking precedence. A prunable worktree SHALL be shown greyed and SHALL offer no new terminal. A worktree no longer listed that still has live terminals SHALL be listed after the others, marked as gone, without a checkbox, until its last terminal closes. Each listed worktree SHALL have a checkbox reflecting the daemon's checked state, and toggling it SHALL send `setChecked`. A primary click anywhere in a worktree's row SHALL select it, except on its checkbox, which only toggles it; a right-click SHALL open the worktree menu without selecting. Enter or Space on a worktree's label SHALL select it. Worktree list changes SHALL show without user action.

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

#### Scenario: The whole row selects
- **WHEN** the user clicks an unselected worktree's row at its top edge, at its bottom edge, in the space right of its label, or just above its checkbox
- **THEN** that worktree is selected

#### Scenario: The checkbox only toggles
- **WHEN** the user clicks an unselected worktree's checkbox
- **THEN** the checkbox toggles and the selected worktree does not change

#### Scenario: Right-click does not select
- **WHEN** the user right-clicks an unselected worktree's row
- **THEN** the worktree menu opens and the selected worktree does not change

#### Scenario: Keyboard selects
- **WHEN** the user focuses an unselected worktree's label and presses Enter, or another's and presses Space
- **THEN** that worktree is selected

