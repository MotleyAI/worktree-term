## ADDED Requirements

### Requirement: Worktree name search
The sidebar header SHALL hold, between its title and the checked filter's toggle, a text box for the selected repo: while it holds text, the sidebar SHALL list only the worktrees whose label contains that text, trimmed and ignoring case, that the checked filter also lists, and the selected worktree. While it holds text, a control beside it SHALL empty it. Each repo SHALL keep its own text, stored per browser across reloads; a repo without one SHALL list every worktree the checked filter lists. The text SHALL play no part in which worktree is selected without a stored selection. When the browser refuses to store a setting of the page, the change SHALL still apply and the page SHALL show that saving failed.

#### Scenario: Search narrows the list
- **WHEN** a repo has worktrees on `feature/login`, `fix/Logout` and `docs`, `feature/login` is selected and the user types `LOG`
- **THEN** the sidebar lists `feature/login` and `fix/Logout` only

#### Scenario: Selected worktree stays listed
- **WHEN** the selected worktree's label does not contain the typed text
- **THEN** it stays listed and selected

#### Scenario: Search belongs to its repo and persists
- **WHEN** text is typed in one repo, another repo is selected and the page is reloaded
- **THEN** the other repo shows an empty box and every worktree its checked filter lists, and the first repo shows its text and lists only the matching worktrees and the selected one

#### Scenario: Clear control empties the search
- **WHEN** the user activates the clear control
- **THEN** the box is empty and focused, the clear control is gone, and every worktree the checked filter lists is listed, with the selected one, also after a reload

#### Scenario: Search with "checked only"
- **WHEN** the search is `feat` and the checked filter is "checked only"
- **THEN** only checked worktrees whose label contains `feat`, and the selected worktree, are listed

#### Scenario: Refused storage write
- **WHEN** the browser refuses to store the search and the user types text
- **THEN** the list is narrowed by the text and the page shows that saving its settings failed
