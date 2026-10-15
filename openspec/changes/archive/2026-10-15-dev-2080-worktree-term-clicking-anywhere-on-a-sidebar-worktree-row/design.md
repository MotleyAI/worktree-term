## Context

`WorktreeEntry` (`src/web/ui/app.tsx`) puts the select handler on the nested `.label` button, so the hit target is whatever box that child occupies; the `.worktree` row around it (padding, flex gaps, the strips above and below the label and the star, the mark) does nothing on click. Repo tabs already handle the click on the whole tab, with inner controls stopping propagation.

## Goals / Non-Goals

**Goals:** the row is the click target, so no future child layout can shrink it again.

**Non-Goals:** the 5px list padding outside the rows; the context menu, prunable and gone behaviour.

## Decisions

- **The row owns the click.** `.worktree` gets `onClick` → `view.selectWorktree(path)`; the label button loses its own `onClick`. Alternative rejected: stretching the label (CSS or a `::after` overlay) — still leaves the star column and gaps as special cases.
- **The label stays the keyboard control.** Enter/Space on the button fire a click that bubbles to the row; the row gets no role or `tabIndex`, avoiding a second tab stop. The row's handler carries `// NOSONAR(S6848) — a pointer shortcut; the label button is the keyboard control`, as at the pane container.
- **The star stops propagation.** Its `onClick` calls `event.stopPropagation()`, so toggling never selects. Clicks above or below the 18px star (29px row) select — a stray select is harmless, a stray star toggle is persisted and shared.
- **Cursor.** `cursor: pointer` moves from `.worktree .label` to `.worktree`.

## Risks / Trade-offs

- [A future in-row control forgets to stop propagation and also selects] → the checkbox e2e scenario shows the pattern; the repo-tab close button does the same.
