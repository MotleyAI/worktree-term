## 1. Tests first (pr-tests)

- [x] 1.1 `src/web/ui/sidebar.test.ts`: `sidebarEntries` sets `hasTerminals` true for a worktree whose terminal is `input`, `working`, idle+unseen, idle+seen, or failed-exited (seen and unseen), false without terminals, true for gone entries (design D12, D17); `visibleWorktrees` / `defaultWorktree` with `{ checked, open }` — each switch alone, both, with search, selected always listed; record helpers for the Open key (only `'open'` reads as on; malformed/unknown read off; off drops the entry); verify they fail
- [x] 1.2 Align the existing `sidebar.test.ts` cases pinning the `'all' | 'checked'` shape ("repo filters", `visibleWorktrees`, `defaultWorktree`) to the `{ checked, open }` model — ask the user's approval first, naming each case; verify they fail
- [x] 1.3 `src/web/ui/view.test.ts`: Open stored under `wtd.openFilters`, per repo, independent of `wtd.filters`; preloaded legacy `wtd.filters` alone gives Starred on and Open off; refused storage write still applies and shows saving failed; held default selection — derived on first show, kept across `termClosed`/`checkedChanged` that would move it, re-derived on either switch toggle, re-derived when the held worktree stops being an entry (gone worktree's last terminal closes), explicit selection unaffected (design D2, D9, D11); verify they fail
- [x] 1.4 `test/e2e/contract.ts`: `TID.filterOpen = 'filter-open'`
- [x] 1.5 `test/e2e/sidebar.spec.ts`: every new "Worktree filters" scenario — Open lists worktrees with terminals (incl. viewed failed exit and gone), both switches on, terminal created from a second page lists a hidden worktree, last terminal closed from a second page removes a non-selected worktree (two distinct tests, design D10), selected worktree keeps its place then leaves after another is selected, selected gone worktree leaves, Open persists per repo and keeps a preloaded Starred, Open's computed knob colour differs from `--star`, `--danger`, `#e5c07b`, `#23d18b`, `#3b8eea` (D16), 160 px: both inputs have non-zero boxes wholly inside the sidebar and each toggles on click (D15); extend the no-animation-on-repo-switch / click-animates / reduced-motion tests to the Open switch (D14); the "Selection" scenarios (default follows the switches, default stays when its last terminal closes, default stays when unchecked); verify they fail
- [x] 1.6 `test/e2e/keyboard.spec.ts`: Alt+Down with Open on skips worktrees without terminals; verify it fails
- [x] 1.7 Codex review of the tests against the spec delta and design

## 2. Sidebar model (`src/web/ui/sidebar.ts`)

- [x] 2.1 `SidebarEntry.hasTerminals` from one `Set` of terminal worktree paths in `sidebarEntries`; `WorktreeFilter = { checked: boolean; open: boolean }` with one shared predicate for `visibleWorktrees` and `defaultWorktree`; record helpers for both stored keys; verify 1.1–1.2 pass

## 3. View state (`src/web/ui/view.ts`)

- [x] 3.1 `openFilters` signal loaded from `wtd.openFilters`; `filter` computed as `{ checked, open }`; `setFilter(which, on)` stores the matching key and clears that repo's held default; verify the storage cases of 1.3 pass
- [x] 3.2 Held default selection per repo, a signal replaced immutably: `worktree` resolves stored → held → derived; a freshly derived non-null default is held; verify the held-default cases of 1.3 pass

## 4. Header UI (`src/web/ui/app.tsx`, `src/web/main/styles.css`)

- [x] 4.1 Shared switch component used by Starred and Open inside a `.sidebar-filters` wrapping group; each `<input>` keyed by repo itself; Open: label "Open", title/aria-label "Show only worktrees with open terminals", `data-testid="filter-open"`; verify the e2e animation and label checks pass
- [x] 4.2 `.filter-switch` shared styles with star and open modifiers; tokens `--open: #b392f0`, track `#4a3870`, border `#7d5bc4`; no shrinking of labels or switches; reduced-motion applies to both; verify the colour and 160 px e2e tests pass

## 5. Gates

- [x] 5.1 Run the local test scope (`la-affected-tests --base main` plus `test/e2e/sidebar.spec.ts`, `test/e2e/keyboard.spec.ts`, `test/e2e/attention.spec.ts`, `test/e2e/terminals.spec.ts`); all green
- [x] 5.2 Enforcement bundle: `la-arch-check`, LikeC4 validation, `la-typecheck`, `pnpm lint`; all green
