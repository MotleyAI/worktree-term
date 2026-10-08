## Context

Builds on the unarchived change `sidebar-presets-browser-protocol` (two link versions; its MODIFIED text is the base here). `architecture/` is normative; principles applied: system 5–8; protocol 3, 4; daemon 1, 3, 6, 7; web 2, 7. Git runs only in `daemon.worktrees` (already allowed `child_process`), composed by `daemon.server`; no new arrow.

## Goals / Non-Goals

**Goals:**
- One right-click deletes a worktree that holds nothing at risk; anything at risk is named before it is lost.
- The check and the removal are one daemon request, so the page never decides from a stale view.

**Non-Goals:**
- Deleting branches (always kept; a forced removal can lose only uncommitted changes).
- Recognising squash or rebase merges: such branches have commits not in `origin/main` and are asked about.

## Decisions

### D1 Check and remove in one request
`removeWorktree{force: false}` computes the risks and, when there are none, removes the worktree in the same request; otherwise it answers `worktreeAtRisk` and keeps it. The page then confirms and sends `force: true`. Alternative — a separate inspection request followed by a removal — rejected: two round trips and a window in which the page acts on an outdated answer. While a removal runs, terminals still starting in the worktree are awaited and count as running, and new ones are refused with `busy`, so no terminal outlives its worktree.

### D2 What is at risk
At risk: commits of the worktree's head not in the base ref (`git rev-list --count <base>..<head>`), or no base ref at all; uncommitted changes, untracked files included and ignored files not (`git status --porcelain`); live terminals. The base is the ref `origin/HEAD` names, else `origin/main`, else `origin/master`. Exited terminals are not at risk: their output is kept nowhere else either, but nothing runs.

### D2a Fetch the base first
Before counting, the daemon fetches the base ref's branch from its remote (`git fetch --quiet --no-tags <remote> <branch>`, no prompts, 20 s at most). A branch merged since the last fetch would otherwise count as unmerged and be asked about. When the fetch fails (offline, no access) the local ref is used; it can only be behind, so the result can only err towards asking.

### D3 Removal
`git worktree remove [--force] <path>`, which also removes a worktree whose directory is gone, leaving other worktrees' registrations alone. After removal every terminal of the worktree is closed, broadcasting `termClosed`; the worktree watch reports the new list and state for it is pruned. The main worktree and locked ones are refused with `busy`.

### D4 Versions
Both lists change, so both versions rise: the daemon link to 6 (new request and reply), the browser link to 7 (its envelopes embed the daemon messages). This is the one restart the earlier split could not avoid: the daemon must learn a new request.

### D5 Hover text and rows
A row's `title` becomes its path followed by `<preset> <id>: <status>` per terminal, derived from `exit`, `state` and `unseen` alone (no new wire data). Rows carry `data-path`, which the e2e contract now uses to find them, since `title` no longer equals the path.
