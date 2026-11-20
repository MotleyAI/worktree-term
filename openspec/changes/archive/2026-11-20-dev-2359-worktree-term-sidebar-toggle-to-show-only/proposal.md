## Why

In a repo with many worktrees, the ones in use are scattered through the sidebar; the only ways to narrow the list are the "Starred" switch, which needs each worktree starred by hand, and the name search. Separately, a selection the user never made (the derived default) moves when terminals or starred state change, which contradicts "the selected worktree stays listed".

## What Changes

- A second sidebar header switch, **Open**, directly after "Starred": when on, the sidebar lists only worktrees that have at least one terminal (any state, exited-and-still-shown included; gone worktrees with terminals included) — the rows that show a mark or a ring.
- The two switches are independent and combine (starred AND has terminals); the name search narrows further; the selected worktree is always listed.
- The list follows terminal creation and closing without user action, also from other pages; Alt+Up/Down walk the filtered list.
- The Open setting is stored per repo, per browser, in its own storage entry; a stored "starred only" setting keeps working.
- A derived default selection no longer moves when terminals or starred state change: it is re-derived only when the repo is first shown, when the user toggles a filter switch, or when the worktree is no longer an entry.
- Both switches stay fully visible and usable at the 160 px minimum sidebar width; the header may wrap.

## Capabilities

### New Capabilities

### Modified Capabilities
- `web`: "Checked filter" becomes "Worktree filters" (both switches); "Worktree name search" and "Keyboard shortcuts" refer to the filters generally; "Selection" keeps a derived default stable across data changes.

## Impact

- `src/web/ui/sidebar.ts` (entries gain terminal presence; filter becomes two flags), `src/web/ui/view.ts` (second stored setting, stable default selection), `src/web/ui/app.tsx` (second switch), `src/web/main/styles.css`, `test/e2e/contract.ts`.
- No wire, protocol, daemon, hub or architecture model changes.
