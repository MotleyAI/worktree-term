## MODIFIED Requirements

### Requirement: Performance budgets
Switch and drag budgets SHALL be counted in frames of the page's frame interval T, the time between consecutive frames the page's display paints. With a repo of 58 worktrees and 2 terminals in each, a switch between worktrees whose terminals are among the 8 WebGL terminals SHALL take at most 1 frame, and a switch to a worktree whose terminals must start WebGL again at most 3 frames, each measured from the input event to just after the first frame painted with the switch applied. A switch to a worktree whose active tab holds 8 panes that must start WebGL again SHALL take at most 6 frames, measured the same way. While a divider of a tab holding 8 panes is dragged, the time from a pointer move to the first frame painted with the new pane sizes SHALL be at most 1 frame. A worktree added or removed with git SHALL show in, or leave, the sidebar within 250 ms of the git command finishing.

Each budget SHALL be judged in rounds: a round of 20 switches or 60 pointer moves meets a budget of n frames when its median is at most (n + ½)·T, and a sidebar round of one add and one remove meets its budget when both are reflected within 250 ms. A budget SHALL hold when at least one of up to 3 rounds, measured in turn, meets it. Each budget SHALL hold unchanged while a pull request status request of the host runs, is slow or never returns.

#### Scenario: Recently viewed switch
- **WHEN** rounds of 20 switches between recently viewed worktrees are measured
- **THEN** the median of at least one of up to 3 rounds is at most 1.5 frames

#### Scenario: WebGL reattach switch
- **WHEN** rounds of 20 switches to worktrees whose terminals render with the DOM renderer are measured
- **THEN** the median of at least one of up to 3 rounds is at most 3.5 frames

#### Scenario: Eight-pane switch
- **WHEN** rounds of 20 switches to a worktree whose active tab holds 8 panes rendering with the DOM renderer are measured
- **THEN** the median of at least one of up to 3 rounds is at most 6.5 frames

#### Scenario: Divider drag
- **WHEN** a divider of an 8-pane tab is dragged across rounds of 60 pointer moves
- **THEN** the median from pointer move to painted frame of at least one of up to 3 rounds is at most 1.5 frames

#### Scenario: Sidebar follows git
- **WHEN** rounds of one `git worktree add` and one `git worktree remove` are measured
- **THEN** in at least one of up to 3 rounds the sidebar reflects both within 250 ms

#### Scenario: A sidebar round needs both commands within budget
- **WHEN** in a round the add is reflected within 250 ms and the remove after more than 250 ms
- **THEN** that round does not meet the sidebar budget

#### Scenario: A load burst in one round
- **WHEN** the first round of a budget misses it and a later round meets it
- **THEN** the budget holds

#### Scenario: A one-frame regression still fails
- **WHEN** every recently viewed switch is slowed by more than one frame inside its measured window
- **THEN** none of the 3 rounds meets the 1-frame budget and the budget fails

#### Scenario: Budgets with a hanging status request
- **WHEN** the host's `gh` never returns while the switch and drag budgets are measured and worktrees are added and removed with git
- **THEN** every budget holds
