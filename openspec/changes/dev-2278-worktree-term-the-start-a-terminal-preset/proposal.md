## Why

A worktree without terminals shows its preset choices ("Start a terminal"), but they take the keyboard focus only after the worktree's last terminal closed with the focus left on the page body. Selecting such a worktree by click, keyboard navigation or a repo-tab switch leaves ↑/↓/Enter dead until the user clicks into the choices.

## What Changes

- The choices take the keyboard focus, on their first preset, every time they are shown for a worktree, unless the focus is in a text field of the page other than a terminal; they take it again when a picker or dialog over them closes and leaves the focus on the page body.
- Each showing of a worktree's choices starts with its first preset highlighted.
- In either preset list, a change to the presets never moves the focus out of the add form; closing the add form returns the focus to the list's highlighted preset.
- In a worktree's choices, Alt+Up / Alt+Down act as the page's worktree shortcuts; keyboard reordering of presets stays in the picker. Dragging still reorders in both lists.
- In either preset list, the repeats of a held digit or Enter choose nothing.

## Capabilities

### New Capabilities

### Modified Capabilities
- `web`: "Terminal tabs" (when the choices take the focus), "Preset picker" (held keys), "Editing presets" (Alt+Up/Down only in the picker; focus around the add form).

## Impact

- `src/web/ui/picker.ts` (key and focus decisions), `src/web/ui/app.tsx` (`PresetList`, `PresetAdder`, `PresetChoices`, `TerminalArea`).
- Tests: `src/web/ui/picker.test.ts`, `test/e2e/terminals.spec.ts`, `test/e2e/picker.spec.ts`.
- No protocol, hub or daemon change; no new dependency; no architecture model or arc42 change.
