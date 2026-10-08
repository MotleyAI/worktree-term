## Context

Builds on the unarchived changes `sidebar-presets-browser-protocol` (preset edits, two link versions) and `worktree-status-and-deletion` (versions 6 and 7); their MODIFIED and ADDED text is the base here. Principles applied: protocol 3, 4; hub 5; web 2, 7.

## Decisions

### D1 Move one preset by name
`movePreset{name, to}` names the preset and its new position rather than sending the whole order: an add or remove from another page at the same time is kept, and a stale page cannot reorder presets it never saw. `to` beyond the end means last; an unknown name or a move in place changes nothing and sends no `presets`. Edits stay serialized in the configuration editor.

### D2 Native drag and drop, plus keys
Rows use HTML drag and drop; the gap under the pointer (upper or lower half of a row) is the drop slot, shown as an accent line, and `dropPosition` turns slot and origin into the target position. Alt+Up/Down moves the highlighted preset and keeps it highlighted; the list refocuses it once the new order arrives, since rows are keyed by name and the focus would otherwise stay on whichever preset now holds the old position. Until that order arrives (or the move fails) further keyboard moves are ignored: the list still shows the old order, so a second move would pick the wrong preset.

### D3 Browser version only
Only the browser-link catalogue changes, so only `BROWSER_PROTOCOL_VERSION` rises (to 8): the reason for the version split.
