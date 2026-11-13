## 1. Tests (pr-tests)

- [x] 1.1 `src/web/ui/picker.test.ts`: align the existing `pickerKey` calls to the new `repeat` argument (design.md decision 13); add the held-key matrix (repeated digit or Enter → null; repeated ArrowUp/ArrowDown → move; first presses unchanged); verify they fail before 2.1.
- [x] 1.2 `src/web/ui/picker.test.ts`: unit tests for the focus-spot classifier (decision 5: each text input type, non-text inputs such as checkbox and button, textarea, editable ancestor, terminal-owned textarea → terminal, nothing → none) and for `choicesTakeFocus` (decisions 3, 8, 9: on show from none/terminal/other but not textField; after a modal closes only from none; never while a modal is open); verify they fail before 2.1.
- [x] 1.3 `test/e2e/terminals.spec.ts`: one test per new "Terminal tabs" scenario — the acceptance flow asserting focus and `aria-selected` at each step and exactly one `createTerm` (decision 14), Alt+Down from a terminal, repo-tab switch, each showing starts at the first preset, focus back after the picker's Escape, close dialog ending by itself, reconnect with the search focused (decision 15); keep the existing three choices-focus tests passing.
- [x] 1.4 `test/e2e/picker.spec.ts`: "Held Enter starts nothing" (hold via repeated `keyboard.down('Enter')` with repeat), "Alt+Down in the choices selects the next worktree" (exactly one step, no `movePreset`), "Add form keeps the focus while presets change", "Escape returns the focus to the list"; existing picker keyboard-reorder tests stay as they are.

## 2. Implementation (pr-implement)

- [x] 2.1 `src/web/ui/picker.ts`: `pickerKey` with `repeat`; the focus-spot classifier over a plain element description; `choicesTakeFocus`; verify 1.1 and 1.2 pass.
- [x] 2.2 `src/web/ui/app.tsx`: `PresetList` — reorder keys only when enabled (picker), Alt+Up/Down untouched otherwise (decision 12); refocus after an index/order change only when the list held the focus at render (decision 10); focus on mount when told to. `PresetAdder` reports closing; the parent's layout effect refocuses the highlighted option after the form left the DOM (decision 11). `PresetChoices` decides at mount and on the falling edge of `view.modal` via `choicesTakeFocus` (decisions 8, 9). `TerminalArea` keys `PresetChoices` per host/repo/worktree (decision 6) and drops `last`/`emptied`. Verify 1.3 and 1.4 pass.

## 3. Verification

- [x] 3.1 Run `pnpm test` (all default tiers), `pnpm lint`, `tsc -b`, `la-arch-check` and the LikeC4 validation; all green.
