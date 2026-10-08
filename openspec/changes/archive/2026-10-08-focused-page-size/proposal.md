## Why

With the UI open in several windows, a terminal's PTY takes the size from whichever window fitted it last, even one in the background, so the window being used shows lines wrapped for another window's width.

## What Changes

- Web: only the page that has the focus sends `resize`; a page in the background still fits its own terminals but leaves the PTYs alone.
- Web: a page that gains the focus, or reconnects, sends the sizes of the terminals it shows, taking them over from the page that set them last.

## Capabilities

### New Capabilities

### Modified Capabilities
- `web`: worktree switching sends `resize` only from the page in focus; terminal size with several pages.

## Impact

- Code: `src/web/terminals/manager.ts`.
- Architecture, wire and dependencies: no change; no restart beyond reloading the page.
- Tests: `test/e2e/terminals.spec.ts` (two pages with stubbed focus, PTY size read with `stty size`; fails without the change).
