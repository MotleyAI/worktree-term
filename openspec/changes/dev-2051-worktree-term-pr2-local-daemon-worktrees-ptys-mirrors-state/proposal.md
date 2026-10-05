## Why

PR 1 (DEV-1989) left every daemon and platform element as a placeholder. This change (DEV-2051, PR 2 of 5) makes the per-host daemon real: it watches worktrees, owns PTYs with headless screen mirrors, persists checkbox and layout state, and serves the protocol on an owner-only unix socket, reachable locally and through `wtd connect` — the foundation the hub and UI (DEV-2052) build on.

## What Changes

- `platform.files`: XDG state paths, owner-only directories, atomic file writes, the start lock and the daemon log.
- `platform.dialer`: connect to the daemon socket, auto-starting the daemon when absent.
- `daemon.worktrees`: `git worktree list --porcelain -z` parser, event-driven watching (no polling) with 100 ms debounce and full-list `worktreesChanged`, repo discovery.
- `daemon.terminals`: PTYs via `@homebridge/node-pty-prebuilt-multiarch`, `@xterm/headless` mirror with serialized snapshots (5000 lines), byte offsets, an atomic snapshot cut, per-connection flow control with lag eviction plus mirror backpressure, bounded input, activity (`unseen`, `bell`).
- `daemon.state`: `state.json` with checkboxes and layouts, durable writes, pruning; layout leaves are always live terminals.
- `daemon.server`: owner-only unix socket, single daemon instance per host, handshake and version-mismatch mode, request correlation, multiple clients.
- CLI verbs `wtd daemon` and `wtd connect` (previously `not implemented`).
- **BREAKING** (wire): `PROTOCOL_VERSION` 2 — `termCreated.req` may be null (broadcast to other watchers) and the error code `not-a-repo` is added.
- Socket moves from `$XDG_RUNTIME_DIR` to `$XDG_STATE_HOME/worktree-term/run/<host>.sock`, which survives the end of the last login session on remote hosts.
- Architecture: daemon and platform `[review]` principles upgraded to `[enforced: test:…]` as their tests land; `daemon` and `platform` specs attached to their nodes.

## Capabilities

### New Capabilities
- `daemon`: the per-host daemon's observable behaviour — instance and socket, handshake, repo watching and worktree events, discovery, terminal lifecycle, attach and snapshots, flow control, input, activity, checked and layout state, persistence and pruning, shutdown.
- `platform`: host paths, owner-only atomic file I/O, and daemon dialing with auto-start.

### Modified Capabilities
- `protocol`: version 2; `termCreated.req` nullable; error code `not-a-repo`.
- `cli`: version line shows protocol 2; `wtd daemon` and `wtd connect` are implemented.

## Impact

- Code: `src/platform/**`, `src/daemon/**`, `src/cli/**`, `src/protocol/**` (v2, extra type exports), `src/hub/**` placeholders rewired to real `platform` exports.
- Tests: unit tests beside the code; process tests `test/process/daemon-*.test.ts`, `test/process/connect.test.ts`; shared client `test/support/daemon-client.ts`.
- Dependencies (exact pins): `@homebridge/node-pty-prebuilt-multiarch@0.14.1` (added to pnpm `allowBuilds`), `@xterm/headless@6.0.0`, `@xterm/addon-serialize@0.14.0`.
- Architecture: `architecture/model/typescript.c4` (specs metadata), `architecture/daemon.arc42.md` (socket location, enforcement tags), `architecture/platform.arc42.md` (enforcement tags).
- Wire: `wire.golden.json` re-blessed for version 2; `frozen.golden.json` unchanged.
