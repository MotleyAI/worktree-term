## 1. Tests (Playwright e2e, next to the MAX_TABS tests in `test/e2e/splits.spec.ts`)

- [ ] 1.1 "New-tab control follows the last tab": with two tabs, `new-tab` is the next element sibling of the last `term-tab` and `split-right`/`split-down` come after the `.spacer`; after opening a third tab and after closing it again, `new-tab` is still right after the last `term-tab`. Verify it fails before 2.x.
- [ ] 1.2 "New-tab control without tabs": in a worktree without terminals, `new-tab` is the first child of the tab strip and precedes the `.spacer`; split controls follow the spacer. Verify it fails before 2.x.
- [ ] 1.3 "Overflowing tabs keep the controls visible": with `MAX_TABS - 1` stored tabs (so `+` stays enabled), assert the strip's `scrollWidth > clientWidth`, the `.term-tabs` height equals its height with one tab, and at scroll start and at scroll end `new-tab`, `split-right`, `split-down` boxes lie inside the `.term-tabs` box and `elementFromPoint` at each centre returns that control; clicking `new-tab` opens the preset picker. Verify it fails before 2.x.

## 2. Implementation

- [ ] 2.1 In `src/web/ui/app.tsx`, extract the `+` button from `TabControls` into `NewTabButton` (unchanged test id, title, disabled binding, `startCreate({ t: 'newTab' })`, plus class `new-tab`) and render the tabs and `NewTabButton` inside a `.term-tab-strip` div before the `.spacer`; verify by 1.1 and 1.2 passing.
- [ ] 2.2 In `src/web/main/styles.css`, add `.term-tab-strip` (flex row, `gap: 4px`, `flex: 0 1 auto`, `min-width: 0`, `overflow-x: auto`, `scrollbar-width: thin`), `.term-tab { flex-shrink: 0 }`, `.new-tab` (sticky, `right: 0`, `flex-shrink: 0`, `background: var(--panel)`), and extend the muted disabled selector to `.new-tab:disabled`; verify by 1.3 passing.
- [ ] 2.3 Run the full non-integration suite (`pnpm test`) and `la-arch-check`; verify both green, including the existing new-tab tests in picker, splits and keyboard specs.
