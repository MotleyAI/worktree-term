## Context

See proposal.md (Why). Current focus plumbing:

- `View.sync()` (`src/web/ui/view.ts`) calls `manager.focus(host, focused)` only when `focusKey` (host, shown panes, focused pane, modal) changes — edge-triggered, while the `Pane focus` requirement is level-triggered. This is the structural cause: every other way of losing the focus (a clicked button, the page body, a re-rendered element, a window switch) would need its own patch.
- `src/web/main/index.ts` has a document `keydown` listener routing keys outside terminals to `view.handleKey(event, false)`.
- `focusSpot` / `choicesTakeFocus` live in `src/web/ui/picker.ts`, the DOM reader `activeSpot(manager)` in `src/web/ui/app.tsx`.
- xterm 6 turns Enter, arrows, Backspace, Ctrl keys and most printable keys into input in its own `keydown` handler on its textarea (reading `keyCode`); upper-case A–Z and dead keys wait for `keypress`. A `keydown` dispatched on the page body never reaches that handler, so moving the focus during `keydown` alone loses the first key.

Architecture: touches `typescript.web.ui`, `typescript.web.terminals` (one public method) and `typescript.web.main` (wiring). The existing arrows `ui → terminals`, `main → ui`, `main → terminals` cover every call; no model or arc42 change. Principles that apply: web 1 (no Node APIs), web 3 (`terminals` never depends on `ui` — the policy stays in `ui`, `terminals` only delivers), web 4 (no terminal re-created); system 1–2 (imports only through each element's `index.ts`), system 4 (strict tsc/lint), system 6 (no swallowed errors), system 8 (unit tests beside the code, e2e in `test/e2e`).

## Goals / Non-Goals

**Goals:**
- One rule, applied by three triggers, decides whether the current terminal takes the keyboard focus (see the `Pane focus` delta).
- The first key typed while nothing holds the keyboard reaches the terminal exactly once.
- Repo-tab and terminal-tab keyboard navigation as in the `Keyboard shortcuts` delta.

**Non-Goals:**
- No change to how the preset choices (worktree without terminals) take or keep the focus: without a current terminal the rule never fires.
- Pickers, dialogs and the worktree menu keep their modal key handling unchanged.

## Decisions

**D1. One level-triggered rule at three triggers (default — structural fix).** A pure `terminalTakesFocus` in a new `src/web/ui/focus.ts` decides; the triggers are a pointer click, a key pressed outside the terminals, and the window `focus` event. Alternative — patch each focus-losing path (row click, tab click, refocus…) — rejected: N code paths that must agree by hand, and the next path is missed again. `View.sync()` keeps focusing on `focusKey` changes.

**D2. Which controls hold the keyboard: by how they got the focus (user).** Options: split by key (Enter/Space/Tab/Escape/arrows/Home/End/PgUp/PgDn stay with a focused control, others go to the terminal); split by focus origin; every key to the terminal. Taken: by focus origin — a control the user clicked does not hold the keyboard (treated like the page body), a control focused from the keyboard or by the page holds every key. Why: any first key after a click reaches the terminal (Enter, arrows, Escape included) while keyboard navigation of tabs, labels and the separator keeps working.

**D3. Selected page text (user).** Options: hold every key while text outside the terminals is selected; hold only Ctrl/Meta keys; no exception. Taken: a click or window refocus leaving such a selection does not move the focus, and a key pressed with Ctrl or Meta while it exists stays with the page; other keys go to the terminal. Why: Ctrl+C copies the selection instead of interrupting the terminal's program.

**D4. Focus origin is tracked explicitly (codex).** The DOM does not record how an element got the focus, and no `click` fires after some pointer interactions (drags ending elsewhere, context menus). A tracker in `ui` marks the element that gains the focus during a pointer interaction (from a capture-phase `pointerdown` until that interaction's click task has run) as clicked; a focus gained otherwise — Tab, script, Playwright's `locator.focus()` — is not. The rule therefore sees spot `other` together with a `clicked` flag, and a stale clicked control is repaired by the next key or window refocus even when no `click` fired. Alternative `:focus-visible` rejected: a browser heuristic, where a script focus after a click inherits pointer modality, which would break the existing scripted-focus tests (`keyboard.spec.ts` focuses the checked filter, `sidebar.spec.ts` the worktree label).

**D5. Key delivery is a designed forward, not a focus move (codex).** New public `TerminalManager.forwardKey(host, termId, event)`: focuses the terminal and replays the `keydown` on xterm's textarea (a copy carrying `key`, `code`, `keyCode`, modifiers, `repeat`, `location`), so xterm's own key handling and the installed key filter apply. If xterm handled the replay (it cancelled it), the original event is cancelled, so nothing is delivered twice; otherwise the original's default proceeds and the following `keypress` reaches the now-focused textarea (upper-case letters, dead keys). A key whose default the page already prevented (a control's own handler, e.g. Enter on a worktree label) is never forwarded.

**D6. Keys being composed are never claimed (codex).** `isComposing`, `key === 'Process'` and `key === 'Dead'` keys stay where they are.

**D7. Page selection classification (codex).** "Text outside the terminals is selected" = the document selection is non-collapsed and not wholly inside the terminal layer (page-owned or mixed counts); a range with an endpoint no longer in the document is ignored. A pure classifier over (collapsed, anchor in terminals, focus in terminals, endpoints connected) is unit-tested; selections inside inputs are covered by the text-field rule.

**D8. Any open menu blocks the claim (codex).** Not only when it holds the focus: any element with `aria-expanded="true"` or `role="menu"` present on the page blocks it, as do `view.modal` (pickers, dialogs, worktree menu, editor failure dialog) and a text field or terminal holding the focus.

**D9. Click claim timing (codex).** The click trigger runs after the click's own handlers and the render they cause (a task later), re-reads the focus when it runs, and is cancelled by a `dblclick`, so the rename field, menus and dialogs take their focus first. Clicks generated by the keyboard (`detail === 0`) are not pointer clicks.

**D10. Clicking a new worktree or repo tab focuses its terminal at once (user).** In scope. Covered by the click trigger; in addition pr-implement finds why `sync()`'s own focus call does not win today and removes that cause rather than relying on the second trigger alone.

**D11. Shortcuts first (default).** `view.handleKey` runs before the rule; a shortcut never moves the focus beyond what its action does.

**D12. Window refocus reclaims from nothing-holds only (default).** A control focused from the keyboard keeps the focus across a window switch (D2).

**D13. Module placement (default).** `focus.ts` in `ui` holds the rule, the moved `focusSpot` / `FocusSpot` / `FocusedElement` / `choicesTakeFocus` / `ChoicesTrigger` (from `picker.ts`), the moved `activeSpot` DOM reader (from `app.tsx`), the origin tracker and the selection classifier — one focus classifier for `View` and `app.tsx`. Their tests move from `picker.test.ts` to `focus.test.ts`.

**D14. Repo tabs on Alt+Left/Right; terminal tabs on Ctrl+Shift+Left/Right (user).** Options considered for repo tabs: Ctrl+arrows (rejected: word jumps in shells and editors), Shift+arrows (rejected: text selection in TUIs/editors), Ctrl+Shift+Left/Right with terminal tabs kept on Alt+Left/Right (recommended first), Alt+Left/Right. Taken: Alt+Left/Right for repo tabs, because switching repos is far more frequent than switching terminal tabs. Terminal tabs then: Ctrl+Shift+Left/Right (kitty's convention, fits the Ctrl+Shift family; costs word-selection in some editors) over Alt+PageUp/PageDown (Fn on laptops) — Ctrl+PageUp/PageDown is reserved by Chrome. Both are navigation shortcuts (repeat when held); repo navigation follows the shown repo-tab order and stops at either end. Worktrees stay on Alt+Up/Down, which already keeps the focus in the terminal. Aligning `src/web/ui/keymap.test.ts`, `test/e2e/keyboard.spec.ts` and `test/e2e/splits.spec.ts` (which pin Alt+Left/Right as terminal-tab keys) and the README shortcut table follows from this decision.

**D15. Codex finding rejected (codex, rejected).** "The global claim competes with the preset choices' own focus restoration (DEV-2278)": rejected — the choices appear only for a worktree without terminals, where there is no current terminal and the rule never fires; a unit row pins it.

## Risks / Trade-offs

- [Replayed `keydown` behaves differently from a trusted one in xterm (e.g. `keyCode` not settable from the event init)] → e2e first-key scenario with every key class against `cat -v` / a shell; define `keyCode` on the copy if the init ignores it.
- [Delayed click claim races focus set by effects] → the claim re-reads the focus at run time and a `dblclick` cancels it; double-click rename e2e.
- [Pointer-origin window too wide or narrow] → unit tests of the tracker's transitions (pointerdown → focusin → click task end; keyboard focus; script focus).
- [Ctrl+Shift+Left/Right no longer reach editors inside the terminal] → accepted (D14).
