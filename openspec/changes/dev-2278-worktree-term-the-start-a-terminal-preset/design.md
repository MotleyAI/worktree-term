## Context

Two unrelated places decide the keyboard focus in the terminal area: `View`'s focus effect gives it to the focused pane, and `PresetChoices` decides once at mount from `emptied && activeElement === body`, with `TerminalArea` tracking `last`/`emptied` to know whether the worktree just lost its last terminal. `PresetChoices` is not keyed, so switching between two worktrees without terminals keeps its highlight and never decides again. `PresetList` refocuses its highlighted option after every index or order change once shown, which pulls the focus out of its own add form when another page reorders presets. The `PresetList` key handler consumes Alt+Up/Down for reordering, so in the choices they never reach the page's worktree shortcuts.

Architecture: element `typescript.web` (`ui`). Applicable principles: web 1 (no Node APIs), web 3 (`terminals` never depends on `ui`; `ui` may call `manager.owns`), web 4 (terminals never re-created), web 5 (switching makes no network round trip; focus is local), system 1–2 (imports via `index.ts`), system 4 (strict compiler/lint), system 8 (unit beside the code, e2e in `test/e2e`). No model, arc42 or `index.yaml` change; the delta stays in the `web` spec.

## Goals / Non-Goals

**Goals:**
- One focus policy for both preset lists, decided by pure functions in `picker.ts` and applied in `PresetList`; the `emptied` machinery is deleted.
- Every path that shows a worktree's choices behaves the same.

**Non-Goals:**
- A pane taking the focus from a text field (`View` focus effect, e.g. another page creating a terminal while the user types in the search) is unchanged.
- No component-level DOM test tier (jsdom); DOM focus behaviour is covered by Playwright.
- The picker's focus on open is unchanged: it takes the focus from anywhere, the search included.

## Decisions

1. **Structural fix over a patched condition.** The focus decision moves into `picker.ts` and `PresetList`, replacing the mount-time `emptied` check and the `last` ref in `TerminalArea`. Alternative: widen the `PresetChoices` condition — keeps two code paths that must agree by hand. (default)
2. **Alt+Up/Down in the choices act as worktree shortcuts; keyboard reordering only in the picker; dragging in both.** Options: (A) this; (B) keep reordering in the choices — navigation stalls at every empty worktree and silently reorders the hub's presets; (C) a new reorder key in both lists — changes an existing binding. A matches the "Keyboard shortcuts" requirement (shortcuts work everywhere except while a picker or dialog is open). (user: deferred to the recommendation, A)
3. **The choices take the focus when shown, and again when a picker or dialog over them closes; never from a text field.** Option: only on first showing — leaves Escape-out-of-the-picker with dead keys. (user)
4. **Repeats of a held digit or Enter choose nothing in either list; held arrows keep moving.** Guards "no terminal SHALL be created without the user choosing one" against a held Enter that selected the worktree, or one that ended the last terminal, landing in the newly focused list. Option: no guard. (user)
5. **Text field** = an `input` of type `text`, `search`, `email`, `url`, `tel`, `password` or `number`, a `textarea`, or an element inside an editable (contenteditable) ancestor; an element the terminal manager owns (`manager.owns`, checked first) is a terminal, never a text field. The classifier works on a plain description of the active element (tag, type, editable, owned by a terminal) so it is unit-testable without a DOM. (default; precision from codex)
6. **Choices keyed per worktree** on the `PresetChoices` vnode in `TerminalArea`, key `` `${host}\n${repo}\n${worktree}` ``: each showing is a fresh mount with the first preset highlighted; an open add form closes on a switch. A reconnect that briefly unmounts the choices (`canCreate` false or presets null) loses an open form, as today; on return they take the focus unless it is in a text field. (default; key placement from codex)
7. **Picker focus on open unchanged.** (default)
8. **Explicit focus triggers.** The pure decision (`choicesTakeFocus`) only judges whether the current focus may be taken; when it is consulted is fixed by `PresetList`/`PresetChoices`: on mount, and on the falling edge of `view.modal` (true → false). Ordinary re-renders and preset updates never consult it. (codex)
9. **After a modal closes, the choices take the focus only when it is on the page body.** Options: (A) only from the body; (B) from anything but a text field — would pull the focus from a control the user just clicked to dismiss a menu (e.g. the Starred switch). (user, A; raised by codex)
10. **Refocus after an index or order change only if the list held the focus**, read as `list.contains(document.activeElement)` during the render, before the DOM changes — not a sticky flag. A removed highlighted preset clamps the index and focuses the surviving option under the same condition. (default; precision from codex)
11. **Closing the add form returns the focus to the list's highlighted preset**, in both lists, for Escape, Cancel and a resolved submit; a refused or failed submit keeps the focus in the form. `PresetAdder` only reports the close; the parent's layout effect focuses after the form has left the DOM, avoiding a race with Preact's commit. (user approved the extension; scheduling from codex)
12. **Alt+Up/Down in the choices pass through untouched**: no `preventDefault`, no `stopPropagation`, not consumed by `pickerKey`, so the document listener in `src/web/main/index.ts` navigates once per press with the existing repeat semantics. (codex)
13. **`pickerKey` takes the key press's `repeat`**; the existing `pickerKey` unit-test calls are aligned to the new signature. (user approved with the spec)
14. **Acceptance e2e asserts every step**: first option focused and selected once shown, second after ArrowDown, exactly one `createTerm` for the second preset in that worktree after Enter. (codex)
15. **Race e2e scenarios added**: presets arriving after a reconnect while the search has the focus; a close dialog for the last terminal ending by itself when another page closes the terminal. (codex)
16. Rejected (codex): drop the held-key guard as out of scope and as contradicting "number keys keep working as before" — the user chose it, single presses are unchanged, and a creation guard in `View` would not stop the first, accidental creation.
17. Rejected (codex): add component-level DOM tests — the repo's tiers are pure unit tests plus Playwright, and every focus scenario is asserted on the real active element in e2e.
18. Rejected (codex): narrow the spec to the issue's wording — the user approved both widenings (decisions 3 and 4).

## Risks / Trade-offs

- [The xterm helper textarea of a hidden terminal is still the active element after Alt+Down] → `manager.owns` is checked before the text-field test, so it counts as a terminal and the focus is taken.
- [Preact renders signal updates in a microtask, so Enter on a worktree label moves the focus into the list before the key repeats] → decision 4.
- [A keyed reorder can blur the focused option before the effect runs] → decision 10 reads the containment during render, before the DOM changes.
- [The two lists now differ for Alt+Up/Down] → the picker is modal (global shortcuts are off there); dragging still reorders in the choices.
