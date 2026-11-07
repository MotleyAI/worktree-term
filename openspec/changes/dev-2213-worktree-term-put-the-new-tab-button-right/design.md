## Context

`.term-tabs` (`src/web/ui/app.tsx`) is a flex row: the `TermTab`s, a `.spacer` (`flex: 1`), then `TabControls` holding new-tab, split-right and split-down. The bar has no overflow handling, so many tabs push the controls out of view. Change is confined to the `web` element (`ui` markup + `main` styles); no new imports, no arc42 principle of `typescript.web.arc42.md` is touched, no model change.

## Goals / Non-Goals

**Goals:**
- `+` directly after the last tab; split controls at the right end.
- On overflow the tabs scroll and all three controls stay visible and clickable.
- New-tab behaviour (test id `new-tab`, title `New tab (Ctrl+Shift+T)`, shortcut, disabled states and muted disabled style) unchanged.

**Non-Goals:**
- Scrolling the active tab into view, tab shrinking/ellipsis, or any other tab-bar redesign.

## Decisions

Target markup:

```
<div class="term-tabs" role="tablist">
  <div class="term-tab-strip">     flex row, gap 4px, flex 0 1 auto, min-width 0, overflow-x auto, thin scrollbar
    <TermTab/> … <TermTab/>        flex-shrink 0
    <NewTabButton/>                class "new-tab", position sticky, right 0, flex-shrink 0, background var(--panel)
  </div>
  <span class="spacer"/>
  <TabControls/>                   split-right, split-down only
</div>
```

- **Scrolling strip with a sticky `+` inside it.** Alternative: wrap the tabs in a scroll container and put `+` after it, outside the scroll area. Chosen: `+` stays the literal next sibling of the last `term-tab` (issue acceptance), sits right after the tabs when they fit, and sticks to the strip's right edge when they overflow. The strip has `min-width: 0` so it shrinks instead of pushing the spacer and split controls off. (default)
- **Split controls stay in `TabControls` at the right end; `+` extracted into its own `NewTabButton` component**, reusing the existing title, `canNewTab` disabled binding and `startCreate({ t: 'newTab' })`. The muted disabled style selector is extended to `.new-tab:disabled`. (default, per issue)
- **No interview**: the issue fully specifies the change; user asked to keep it simple. (user)
- **`.term-tab-strip` gets `gap: 4px`** — tabs moved into a nested flex container no longer get `.term-tabs`' gap. (codex)
- **`.term-tab` is `flex-shrink: 0`** so the browser overflows the strip instead of compressing tabs, which the sticky design relies on. (codex)
- **Overflow test asserts real overflow and both scroll extremes**: `scrollWidth > clientWidth` on the strip, then at scroll start and end the three controls are inside the tab bar box and hit-testable (`elementFromPoint` at each control's centre returns that control) and `+` click opens the picker. (codex)
- **Scrollbar**: the strip uses `scrollbar-width: thin`, and the tab bar must keep its non-overflow height when the tabs overflow (asserted in the overflow test). (codex)

## Risks / Trade-offs

- A thin horizontal scrollbar appears under the tabs on overflow; acceptable, and it must not grow the bar (tested).
- The sticky `+` covers the last visible part of the tab under it while scrolled; its opaque panel background keeps it legible.
