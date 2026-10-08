## Why

Presets can be added and removed from the page, but their order — which decides the digit that picks each one — can only be changed by editing `config.json`.

## What Changes

- **BREAKING** (browser wire only): `BROWSER_PROTOCOL_VERSION` 8 — browser-to-hub `movePreset{req, name, to}`. `DAEMON_PROTOCOL_VERSION` stays 6: replacing the hub needs no daemon restart.
- `hub.config` / `hub.router`: a preset edit that moves the named preset to position `to` (the last position when beyond it), answered and propagated like the other preset edits.
- Web: preset rows in the picker and in a worktree's choices can be dragged to a new position, with a drop marker; Alt+Up/Down moves the highlighted preset, which stays highlighted.
- CLI: the version line shows browser protocol 8.

## Capabilities

### New Capabilities

### Modified Capabilities
- `protocol`: browser version 8; `movePreset` in the browser-link catalogue; constants.
- `hub`: moving presets.
- `web`: reordering presets.
- `cli`: version line.

## Impact

- Code: `src/protocol/**`, `src/hub/config/editor.ts`, `src/hub/router/{index,session}.ts`, `src/web/client/connection.ts`, `src/web/ui/{app.tsx,picker.ts,view.ts}`, `src/web/main/styles.css`.
- Architecture: no change.
- Wire: `wire.golden.json` re-blessed for `{daemon: 6, browser: 8}`; daemon-link schemas unchanged (checked by the guard).
- Upgrade: restart the hub only.
- Tests: protocol, editor and `dropPosition` unit tests; `test/process/hub-router.test.ts`; `test/e2e/picker.spec.ts` (drag in the choices, Alt+Up in the picker).
- Builds on the changes `sidebar-presets-browser-protocol` and `worktree-status-and-deletion`; archive them first.
