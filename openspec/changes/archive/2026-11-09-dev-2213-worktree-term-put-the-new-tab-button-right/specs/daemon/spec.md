## MODIFIED Requirements

### Requirement: Checked state and layouts
`setChecked` and `setLayout` SHALL fail with `unknown-worktree` unless the worktree is in the current list of a repo this connection watches. Every leaf of a layout SHALL be a live terminal of that worktree; `setLayout` with any other leaf SHALL fail with `unknown-term` and change nothing. A successful change SHALL be persisted durably, then sent as `checkedChanged` or `layoutChanged` to every watcher of the repo including the requester, then answered with `done`. A failed write SHALL answer `internal`, keep the previous state and send no change. When a terminal is closed it SHALL be removed from its worktree's layout: a split SHALL be replaced by its remaining child, a tab left empty SHALL be removed, a remaining tab SHALL keep its id and name, and `active` SHALL keep the same tab if it remains, else the nearest preceding remaining tab, else 0; a changed layout SHALL be sent as `layoutChanged`.

#### Scenario: Checkbox broadcast
- **WHEN** client A checks a worktree that client B also watches
- **THEN** both receive `checkedChanged` and A then receives `done`

#### Scenario: Layout with a foreign terminal
- **WHEN** a client sets a layout containing a terminal of another worktree
- **THEN** the request fails with `unknown-term` and the stored layout is unchanged

#### Scenario: Closing a split pane
- **WHEN** a terminal in one half of a split is closed
- **THEN** watchers receive `layoutChanged` in which the split is replaced by the other half

#### Scenario: Closing a pane keeps the tab's name
- **WHEN** a terminal in one half of a split in a tab named "build" is closed
- **THEN** watchers receive `layoutChanged` in which that tab is still named "build"
