## 1. Web

- [x] 1.1 `searchOf`, `withSearch`, `matchesSearch` and the search in `visibleWorktrees` (not in `defaultWorktree`) with unit tests; `wtd.searches` and `setSearch` in the view; the text box and × in the sidebar header
- [x] 1.2 e2e: the search lists matching worktrees ignoring case, keeps the selected one, belongs to its repo, persists across a reload, × empties it; it applies together with "checked only"

## 2. Final gates

- [x] 2.1 `pnpm test` green (incl. Playwright); `pnpm lint` exits 0; `openspec validate worktree-name-search --strict` passes
