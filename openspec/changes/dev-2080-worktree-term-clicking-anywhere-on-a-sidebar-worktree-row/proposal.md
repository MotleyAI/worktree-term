## Why

A sidebar worktree switches only when the click lands on its branch-name text: the row is at least 29px tall, but only the text-tall label button inside it handles the click, so clicks above or below the text — between two names — do nothing.

## What Changes

- Web: a primary click anywhere in a worktree's row selects it; its checkbox still only toggles the star; a right-click still opens the worktree menu without selecting. The label stays the row's keyboard control (Enter or Space selects).
- The whole row shows the pointer cursor.

## Capabilities

### New Capabilities

### Modified Capabilities
- `web`: the worktree sidebar's click target is the whole row.

## Impact

- Code: `src/web/ui/app.tsx` (`WorktreeEntry`), `src/web/main/styles.css`.
- Architecture, wire, upgrade: no change.
- Tests: `test/e2e/sidebar.spec.ts`.
