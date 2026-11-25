## ADDED Requirements

### Requirement: Pull request icons
A worktree row whose branch has a pull request in the latest `prStatus` received for its repo since the repo's latest `repoState` SHALL show a pull request icon directly left of its attention mark or ring. The icon SHALL be GitHub's glyph for the `state` in GitHub's colour: open (green), draft (grey), merged (purple), closed (red). An open or draft pull request SHALL also carry a badge at the glyph's corner: a red ✕ when `checks` is `failing` or `conflicts` is true, else an amber dot when `checks` is `pending`, else none; a merged or closed one SHALL carry none. On hover the icon SHALL show one line: `#<number> <state>`, followed for an open or draft pull request by ` · checks failing` or ` · checks pending`, then ` · conflicts` when conflicting, then ` · changes requested`, ` · approved` or ` · review required` for its review. A primary click on the icon SHALL open the pull request's URL in a new window and SHALL NOT change the selected worktree. A row without a pull request, a detached row and a gone row SHALL show no icon and reserve no space for one, with marks and rings staying aligned at the row's right edge. Rows SHALL render without waiting for a status, and icons SHALL appear, change and disappear as `prStatus` messages arrive, without user action.

#### Scenario: Icons by state
- **WHEN** a repo's worktrees are on branches with an open pull request whose checks pass, an open one whose checks fail, a merged one, and none
- **THEN** the rows show the open glyph without a badge, the open glyph with a red ✕, the merged glyph, and no icon

#### Scenario: Pending and draft
- **WHEN** a branch has a draft pull request whose checks are pending
- **THEN** its row shows the draft glyph with an amber dot

#### Scenario: Hover line
- **WHEN** the user hovers the icon of open pull request #123 whose checks fail and whose review requests changes
- **THEN** it shows `#123 open · checks failing · changes requested`

#### Scenario: Merged hover line
- **WHEN** the user hovers the icon of merged pull request #7
- **THEN** it shows `#7 merged`

#### Scenario: Click opens the pull request
- **WHEN** the user clicks the icon of an unselected worktree's pull request
- **THEN** a new window opens the pull request's URL and the selected worktree does not change

#### Scenario: No pull request, no space
- **WHEN** a row has no pull request and another row in the same repo has one
- **THEN** the first row shows no icon, and both rows' marks and rings line up at the right edge

#### Scenario: Icon follows GitHub without reload
- **WHEN** a pull request shown as open is merged on GitHub
- **THEN** its row shows the merged glyph within one refresh interval, without a reload

#### Scenario: Second page shows icons
- **WHEN** a second page connects to the same hub while the first shows pull request icons
- **THEN** the second page shows the same icons without a new status request

#### Scenario: No gh, no icons, no error
- **WHEN** the host has no `gh`, or `gh` is not logged in
- **THEN** the page shows no pull request icons and no error

## MODIFIED Requirements

### Requirement: Performance budgets
With a repo of 58 worktrees and 2 terminals in each, the median of 20 measured switches SHALL be at most 16 ms between a worktree whose terminals are among the 8 WebGL terminals and at most 50 ms to a worktree whose terminals must start WebGL again, each measured from the input event to just after the first frame painted with the switch applied. The median of 20 switches to a worktree whose active tab holds 8 panes that must start WebGL again SHALL be at most 100 ms, measured the same way. While a divider of a tab holding 8 panes is dragged, the median time from a pointer move to the first frame painted with the new pane sizes SHALL be at most 16 ms. A worktree added or removed with git SHALL show in, or leave, the sidebar within 250 ms of the git command finishing. Each budget SHALL hold unchanged while a pull request status request of the host runs, is slow or never returns.

#### Scenario: Recently viewed switch
- **WHEN** 20 switches between recently viewed worktrees are measured
- **THEN** their median is at most 16 ms

#### Scenario: WebGL reattach switch
- **WHEN** 20 switches to worktrees whose terminals render with the DOM renderer are measured
- **THEN** their median is at most 50 ms

#### Scenario: Eight-pane switch
- **WHEN** 20 switches to a worktree whose active tab holds 8 panes rendering with the DOM renderer are measured
- **THEN** their median is at most 100 ms

#### Scenario: Divider drag
- **WHEN** a divider of an 8-pane tab is dragged across 60 pointer moves
- **THEN** the median from pointer move to painted frame is at most 16 ms

#### Scenario: Sidebar follows git
- **WHEN** `git worktree add` and `git worktree remove` finish
- **THEN** the sidebar reflects each within 250 ms

#### Scenario: Budgets with a hanging status request
- **WHEN** the host's `gh` never returns while the switch budgets are measured and a worktree is added and removed with git
- **THEN** every switch median stays within its budget and the sidebar reflects each git command within 250 ms
