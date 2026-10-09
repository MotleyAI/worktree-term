## Why

A repo with many worktrees makes the sidebar long; the "Starred" toggle narrows it only to worktrees starred beforehand, so finding one by its branch name means scrolling.

## What Changes

- Web: a text box in the sidebar header, between the title and the "Starred" toggle, listing only the worktrees whose label contains its text (trimmed, ignoring case), together with the "Starred" toggle; the selected worktree stays listed. A × beside it, shown while it holds text, empties it. Each repo keeps its own text, stored per browser across reloads (`wtd.searches`). A sidebar too narrow for one header row puts the box on its own row.
- Web: a setting of the page the browser refuses to store (storage full or blocked) still applies, and the page shows that saving failed, instead of the handler throwing.

## Capabilities

### New Capabilities

### Modified Capabilities
- `web`: worktree name search.

## Impact

- Code: `src/web/ui/{sidebar.ts,view.ts,app.tsx}`, `src/web/main/styles.css`.
- Architecture, wire, upgrade: no change.
- Tests: `src/web/ui/sidebar.test.ts`; `test/e2e/sidebar.spec.ts` (search per repo, persistence, ×, combined with "Starred").
