## 1. Corpus

- [x] 1.1 Archive the merged `worktree-name-search` change in its own commit; `openspec validate --specs --strict` passes

## 2. Tests (e2e, `test/e2e/sidebar.spec.ts`)

- [x] 2.1 The whole row selects: `click({ position })` on an unselected worktree's row at y=1, y=height−2, right of the label, and above the star each select it (assert `aria-selected`); fails before the fix
- [x] 2.2 The checkbox only toggles: clicking an unselected worktree's checkbox checks it and leaves the selection unchanged
- [x] 2.3 Right-click does not select: right-clicking an unselected row opens the worktree menu and leaves the selection unchanged
- [x] 2.4 Keyboard selects: extend `a worktree is selected from the keyboard` to press Enter on one label and Space on another's

## 3. Implementation

- [ ] 3.1 `WorktreeEntry` in `src/web/ui/app.tsx`: row `onClick` selects (with the `NOSONAR(S6848)` comment from design.md), the label button has no `onClick`, the star's `onClick` stops propagation; tests 2.1–2.4 pass
- [ ] 3.2 `src/web/main/styles.css`: `cursor: pointer` on `.worktree`, removed from `.worktree .label`

## 4. Final gates

- [ ] 4.1 `pnpm test` green (incl. Playwright); `pnpm lint` exits 0; `tsc -b` clean; `openspec validate dev-2080-worktree-term-clicking-anywhere-on-a-sidebar-worktree-row --strict` passes
