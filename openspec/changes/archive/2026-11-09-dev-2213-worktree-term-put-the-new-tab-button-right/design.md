## Context

`.term-tabs` (`src/web/ui/app.tsx`) is a flex row: the `TermTab`s, a `.spacer` (`flex: 1`), then `TabControls` holding new-tab, split-right and split-down. The bar has no overflow handling, so many tabs push the controls out of view. A tab's label is `<preset> <termId>` of its first terminal; a layout tab is `{id, root}` (`src/protocol/layout.ts`), stored by the daemon in `state.json` and sent on both the daemon and browser links.

Architecture: elements `protocol`, `daemon` (`state`), `web` (`ui`, `layout`, `main`). No new imports or arrows, so no model change. Principles that apply: protocol 2 (the name is a schema field, the type is inferred), 3 (strict decoding: blank or overlong names rejected), 4 (a wire change bumps both link versions, since the layout is on both); web 1 (`layout` stays pure); system 5 (the name is parsed at the boundary), 8 (tests in each tier). No arc42 edit.

## Goals / Non-Goals

**Goals:**
- `+` directly after the last tab; split controls at the right end.
- On overflow the tabs scroll and all three controls stay visible and clickable.
- New-tab behaviour (test id `new-tab`, title `New tab (Ctrl+Shift+T)`, shortcut, disabled states and muted disabled style) unchanged.
- Name a tab by double-clicking it; the name is part of the layout, shown on every page.

**Non-Goals:**
- Scrolling the active tab into view, tab shrinking/ellipsis, or any other tab-bar redesign.
- A keyboard shortcut for renaming, naming split panes, or a name that survives a daemon restart (tabs lose their terminals then and are removed).

## Decisions

Target markup:

```
<div class="term-tabs" role="tablist">
  <div class="term-tab-strip">     flex row, gap 4px, flex 0 1 auto, min-width 0, overflow-x auto, thin scrollbar
    <TermTab/> … <TermTab/>        flex-shrink 0; label or rename <input>
    <NewTabButton/>                class "new-tab", position sticky, right 0, flex-shrink 0, background var(--panel)
  </div>
  <span class="spacer"/>
  <TabControls/>                   split-right, split-down only
</div>
```

### New-tab placement
- **Scrolling strip with a sticky `+` inside it.** Alternative: wrap the tabs in a scroll container and put `+` after it, outside the scroll area. Chosen: `+` stays the literal next sibling of the last `term-tab` (issue acceptance), sits right after the tabs when they fit, and sticks to the strip's right edge when they overflow. The strip has `min-width: 0` so it shrinks instead of pushing the spacer and split controls off. (default)
- **Split controls stay in `TabControls` at the right end; `+` extracted into its own `NewTabButton` component**, reusing the existing title, `canNewTab` disabled binding and `startCreate({ t: 'newTab' })`. The muted disabled style selector is extended to `.new-tab:disabled`. (default, per issue)
- **No interview for the placement**: the issue fully specifies it; user asked to keep it simple. (user)
- **`.term-tab-strip` gets `gap: 4px`** — tabs moved into a nested flex container no longer get `.term-tabs`' gap. (codex)
- **`.term-tab` is `flex-shrink: 0`** so the browser overflows the strip instead of compressing tabs, which the sticky design relies on. (codex)
- **Overflow test asserts real overflow and both scroll extremes**: `scrollWidth > clientWidth` on the strip, then at scroll start and end the three controls are inside the tab bar box and hit-testable (`elementFromPoint` at each control's centre returns that control) and `+` click opens the picker. (codex)
- **Scrollbar**: the strip uses `scrollbar-width: thin`, and the tab bar must keep its non-overflow height when the tabs overflow (asserted in the overflow test). (codex)

### Tab renaming
- **Scope extension: rename tabs by clicking their header** — added to the plan after the placement plan was approved. (user)
- **Name stored in the layout**, as an optional tab `name`, saved with `setLayout`. Options: layout (every page and browser shows it, survives reloads and hub restarts; costs a wire change bumping both protocol versions, so running daemons are reported outdated until restarted) vs browser localStorage (no protocol change; per browser only, stale on reused tab ids, contradicts the shared-layout model). Taken: layout. (user)
- **Gesture: double-click** a tab (outside its close button) edits the name in place; a single click still only chooses the tab. Options: double-click (convention, no accidental renames) vs single click on the active tab (discoverable, but re-clicking the active tab starts a rename). Taken: double-click. (user)
- **`name` is optional, not nullable**: absent means the default label. Existing `state.json` files, parsed with the layout schema, keep loading, and default values are not stored (daemon convention). Schema: 1–64 characters with a non-whitespace character, the preset-name rule. (default)
- **Commit rules**: Enter or blur commits the trimmed text; empty removes the name; Escape stores nothing; the input has `maxLength` 64. (default)
- **Version bumps**: `DAEMON_PROTOCOL_VERSION` 8 → 9 and `BROWSER_PROTOCOL_VERSION` 11 → 12, since a layout travels on both links (protocol principle 4); wire/frozen goldens regenerated. (default)
- **Name preserved through every layout transform**: daemon pruning on close, web `tree.ts` helpers (split, divider drag, select). A tab created by a split-off/new tab gets no name. (default)
- **Renaming a tab missing from the layout adds it as choosing it does**; it cannot be renamed while the layout holds 64 tabs (the double-click does nothing). A failed `setLayout` reverts as other layout writes do. (default)
- **Each edit ends exactly once**: an explicit ended guard so Enter followed by the blur from unmounting the input sends one `setLayout`, and Escape followed by blur sends none. Tests assert exactly one name-carrying `setLayout` on Enter and none changing the name on Escape. (codex)
- **Double-click's preceding clicks choose the tab** (existing click behaviour, so an orphan may be added to the layout before the edit even if it is then cancelled); the Escape scenario therefore asserts the name is unchanged rather than that no `setLayout` at all was sent. (codex)
- **Editable text excludes status UI**: the field starts with the label text without the `(exited)` note and marks, and committing text equal to the starting text stores nothing, so an unchanged default label never becomes a name. (codex)
- **Keys typed in the field stay in it**: the input's keydown stops propagation, so neither the tab's Enter/Space handler, the global keymap (e.g. Ctrl+Shift+T) nor the terminal sees them. (default)

## Risks / Trade-offs

- A thin horizontal scrollbar appears under the tabs on overflow; acceptable, and it must not grow the bar (tested).
- The sticky `+` covers the last visible part of the tab under it while scrolled; its opaque panel background keeps it legible.
- The protocol bump marks running daemons outdated; the user restarts them once (existing outdated-daemon flow).
