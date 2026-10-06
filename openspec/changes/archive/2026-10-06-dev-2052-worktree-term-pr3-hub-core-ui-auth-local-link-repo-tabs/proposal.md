## Why

PR 2 (DEV-2051) made the per-host daemon real, but nothing serves a UI: `wtd ui` and `wtd hub` are placeholders and every `hub` and `web` element throws. This change (DEV-2052, PR 3 of 5 for DEV-1989) adds the local hub and the core browser UI, so worktrees and their terminals can be used from a Chrome app window — the first end-to-end usable slice.

## What Changes

- **BREAKING** (wire): `PROTOCOL_VERSION` 3 — host entries carry the connected daemon's `instance`; new hub-to-browser message `token`; new error code `host-unavailable`; new `codeResponse` schema for the CLI-to-hub code request.
- `hub.server`: HTTP + WebSocket server on `127.0.0.1` at a fixed configurable port; static bundle with `index.html` uncached; persistent owner-only token; one-time codes so the token never appears on a command line; exact `Host`/`Origin` checks; subprotocol authentication; security headers; hub record and identity/shutdown endpoints for `wtd ui`.
- `hub.router` + `hub.links`: one daemon link per browser session and host (local unix socket in this PR), host status machine with reconnect and backoff, envelopes and acks forwarded unchanged, back-pressure that pauses link reads instead of buffering, serialized `restartDaemon` for the local host.
- `hub.config`: `config.json` with `port` and local `repos` (strict schema; later PRs add keys).
- `platform`: hub and configuration paths; detached process spawning shared by daemon start, hub start and browser launch.
- CLI: `wtd hub` (foreground hub) and `wtd ui` (start, reuse or replace the hub, open `google-chrome --app` with a one-time code).
- Web: repo tabs, worktree sidebar (branch label, path on hover, prunable greyed, vanished worktrees with terminals kept), checkboxes and all/checked filter, terminal tabs, attach/restore from snapshots with exact ack accounting, xterm.js instances managed outside Preact and never re-created while their PTY lives, WebGL LRU (≤ 8) with DOM fallback and context-loss handling, fit/web-links/unicode11 addons, stale-bundle reload, reconnect with instance-aware restore, lag-eviction re-attach, outdated-daemon restart banner.
- Tests: Playwright e2e in the default suite (`--pass-with-no-tests` removed) including the perf budgets; hub process tests; RSS budget.
- Architecture: `hub` and `web` specs attached to their nodes; hub, web and system `[review]` principles upgraded to enforced as their tests land; the unused `@xterm/addon-search` allowance removed.
- Out of scope (later PRs): splits, keyboard shortcuts, activity UI, presets (DEV-2053); remote hosts, `addRepo`/`removeRepo`/hub-level `discoverRepos`/`reinstallDaemon` and their UI (DEV-2054). The search addon is dropped.

## Capabilities

### New Capabilities
- `hub`: the local gateway — listener and authentication, static serving, browser sessions, per-session daemon links and host status, routing and back-pressure, configuration, hub lifecycle and daemon restart.
- `web`: the browser UI — authentication and handshake, repo tabs, worktree sidebar and filter, terminal tabs, attach/restore and acks, renderer budget, reconnect and restore, performance budgets.

### Modified Capabilities
- `protocol`: version 3; host entry `instance`; `token` message; `host-unavailable` error code; `codeResponse`.
- `cli`: version line shows protocol 3; `wtd hub` and `wtd ui` are implemented.
- `platform`: hub and configuration paths; detached process spawning (the `platform` spec is created by DEV-2051, which lands first).

## Impact

- Code: `src/hub/**`, `src/web/**`, `src/cli/**`, `src/platform/**`, `src/protocol/**`; `vite.config.ts`, `playwright.config.ts`, `package.json` (`pnpm test` without `--pass-with-no-tests`).
- Tests: unit tests beside the code; `test/process/hub-*.test.ts`; `test/e2e/**`; shared fixtures in `test/support/`.
- Dependencies (exact pins): `ws` (+ `@types/ws`), `preact`, `@preact/signals`, `@xterm/xterm` 6.0.0 and the matching `@xterm/addon-webgl`, `@xterm/addon-fit`, `@xterm/addon-web-links`, `@xterm/addon-unicode11`.
- Architecture: `architecture/model/typescript.c4` (specs metadata), `architecture/hub.arc42.md`, `architecture/web.arc42.md`, `architecture/system.arc42.md` (enforcement tags); `test/architecture/dependencies.ts` (search addon removed).
- Wire: `wire.golden.json` re-blessed for version 3; `frozen.golden.json` unchanged.
