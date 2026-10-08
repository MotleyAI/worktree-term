## MODIFIED Requirements

### Requirement: Worktree switching
Selecting a worktree SHALL show every pane of its active tab and hide the previous ones without waiting for any reply, fit each shown terminal to its pane, send `setVisible` with the host's shown terminals, and, while the page has the focus, send `resize` for each shown terminal whose size differs from the last one the page sent. It SHALL send no request that has a `req`. Resizing the window SHALL fit the shown terminals and, while the page has the focus, resize them.

#### Scenario: Switch sends no request
- **WHEN** the user switches between two worktrees whose terminals were already viewed
- **THEN** the page sends only `setVisible` and `resize` messages

#### Scenario: Split tab shown whole
- **WHEN** the user switches to a worktree whose active tab holds three panes
- **THEN** all three terminals are shown, each fitted to its pane, and `setVisible` lists all three

## ADDED Requirements

### Requirement: Terminal size with several pages
Only a page that has the focus SHALL send `resize`. A page that gains the focus SHALL send `resize` with the size of every terminal it shows, and so SHALL a page for the shown terminals of a host whose link connects again; afterwards it SHALL send a terminal's size only when it differs from the last one it sent. A page without the focus SHALL fit its terminals to its own panes without sending `resize`.

#### Scenario: Background page leaves the size alone
- **WHEN** a second page opens in the background with a smaller window and shows a terminal of the focused page
- **THEN** the PTY keeps the focused page's size

#### Scenario: Focus takes the size over
- **WHEN** the second page gains the focus
- **THEN** the PTY takes the second page's size, and resizing the first page's window while it is in the background does not change it

#### Scenario: Refocus takes it back
- **WHEN** the first page gains the focus again
- **THEN** the PTY takes the first page's current size
