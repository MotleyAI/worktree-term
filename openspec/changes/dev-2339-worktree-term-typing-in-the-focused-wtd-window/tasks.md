## 1. Tests first (pr-tests)

- [x] 1.1 `src/web/ui/focus.test.ts`: full truth table of `terminalTakesFocus` (trigger click / key / windowFocus × spot none / terminal / menu / textField / other-clicked / other-not-clicked × modal × open menu present × current terminal × page selection × Ctrl/Meta × composing incl. `Process`/`Dead`), including the no-current-terminal row standing for the preset choices (design D15); move the `focusSpot` / `choicesTakeFocus` cases from `picker.test.ts`; verify they fail for the missing module
- [x] 1.2 `focus.test.ts`: focus-origin tracker transitions (pointerdown → focusin → after the click task = clicked; Tab/script focus = not clicked; a later script focus after a click = not clicked) and the page-selection classifier (collapsed, terminal-only, page-only, mixed, disconnected endpoint); verify they fail
- [x] 1.3 `view` unit test for the claim (typed fake `TerminalManager`): claims `forwardKey`/`focus` on the focused pane only when the rule allows, never for a key whose default was prevented; repo-tab stepping in shown order, stopping at both ends; verify they fail
- [x] 1.4 Align `src/web/ui/keymap.test.ts` to design D14 (Alt+Left/Right → repo tab, Ctrl+Shift+Left/Right → terminal tab, both navigation/repeating); verify the new rows fail
- [x] 1.5 New `test/e2e/focus.spec.ts` covering every new `Pane focus` scenario of the delta; assert terminal screen contents (via `__wtdInspect` / `cat -v`) and `document.activeElement`; first-key scenario covers lower-case, upper-case, an arrow, Backspace, Enter, Ctrl+C with no duplicates; verify they fail
- [x] 1.6 Align `test/e2e/keyboard.spec.ts` and `test/e2e/splits.spec.ts` (Alt+Left/Right as terminal-tab keys) to Ctrl+Shift+Left/Right; add the `Repo navigation`, `Navigation keeps the keyboard in the terminal` and extended `Shortcut does not reach the program` scenarios; verify they fail
- [x] 1.7 Codex review of the tests against the spec delta and design

## 2. Focus rule and tracking (`src/web/ui/focus.ts`)

- [x] 2.1 Create `focus.ts`; move `focusSpot`, `FocusSpot`, `FocusedElement`, `choicesTakeFocus`, `ChoicesTrigger` from `picker.ts` and `activeSpot` from `app.tsx`; update imports; verify `pnpm test` unit tier for picker/focus passes
- [x] 2.2 Implement `terminalTakesFocus`, the page-selection classifier and the focus-origin tracker (design D2–D4, D6–D8); verify 1.1–1.2 pass

## 3. Terminal key delivery (`src/web/terminals/manager.ts`)

- [x] 3.1 Add public `forwardKey(host, termId, event)` per design D5 (replay keydown on xterm's textarea with `keyCode` defined, cancel the original only when xterm handled the replay); verify the first-key e2e scenario passes with no duplicate input

## 4. Wiring (`view.ts`, `main/index.ts`)

- [x] 4.1 `View`: claim method applying the rule for the three triggers; key trigger runs after `handleKey` and skips default-prevented keys; verify 1.3 passes
- [x] 4.2 `main/index.ts`: document `keydown` → claim; document `click` (pointer clicks only, `detail !== 0`) → claim a task later, re-reading the focus, cancelled by `dblclick`; `window` `focus` → claim; install the origin tracker (design D9)
- [x] 4.3 Find why `sync()`'s own focus call loses after clicking a new worktree row or repo tab and remove that cause (design D10); verify the `Clicking another worktree/repo tab` scenarios pass
  - Probe: with the click claim disabled, `sync()`'s focus call already wins for a new or previously viewed worktree row and repo tab, with fast and slow clicks; no losing cause reproduced, nothing removed. Both scenarios pass with and without the click claim.

## 5. Shortcuts

- [x] 5.1 `keymap.ts`: new `repo` action on Alt+Left/Right, `tab` on Ctrl+Shift+Left/Right (navigation); `View.stepRepo` over the shown repo tabs; verify 1.4 and 1.6 pass
- [x] 5.2 README shortcut table updated to the new bindings

## 6. Gates

- [ ] 6.1 Run the local test scope (`la-affected-tests --base main` plus the e2e specs above, `keyboard.spec.ts`, `splits.spec.ts`, `picker.spec.ts`, `sidebar.spec.ts`, `tab-names.spec.ts`, `terminals.spec.ts`); all green
- [x] 6.2 Enforcement bundle: `la-arch-check`, LikeC4 validation, `tsc -b`, `pnpm lint`; all green
