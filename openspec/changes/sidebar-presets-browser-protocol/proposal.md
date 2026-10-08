## Why

Day-to-day use of worktree-term showed friction in the UI: the worktree list has a fixed width, the "checked only" filter applies to every repo at once, the active repo and terminal tabs barely stand out while a bar over every terminal repeats its tab, and the terminal presets can only be changed by hand-editing `config.json`. Adding preset edits to the page needs new browser-to-hub messages; with one protocol version shared by both links, that bump would mark every running daemon outdated and force a restart that kills its terminals, although daemons never see browser messages.

## What Changes

- **BREAKING** (wire): the single `PROTOCOL_VERSION` is split into `DAEMON_PROTOCOL_VERSION` (client ↔ daemon, stays 5) and `BROWSER_PROTOCOL_VERSION` (browser ↔ hub, 6). A wire change bumps the version of the link it touches, a shared-constant change both; the golden guard checks each link against its own version. Daemons of this release stay compatible with hubs of the previous one.
- Protocol: browser-to-hub `addPreset{req, preset}` and `removePreset{req, name}`.
- `hub.config`: the default presets are `shell` (login shell), `claude` and `codex`; the configuration editor edits the presets as well as a host's repos, with the same read–check–replace rules.
- `hub.router`: preset edits answer `done` and send `presets` to every open session.
- Web: "+ Add preset" (name and command) and a × per preset in the new-terminal picker and in a worktree's preset choices.
- Web: the "checked only" filter (shown as "Starred") is kept per repo; switching repos does not animate the switch.
- Web: the sidebar's right edge is draggable, and moves with the arrow keys, between 160 and 640 px; the width is kept per browser.
- Web: a single-pane tab shows no pane header — only panes of a split have one; the active repo tab and terminal tab are shown in the accent colour that marks the focused pane.
- CLI: `wtd --version` prints both protocol versions.
- Development: `pnpm dev` serves the page through Vite with hot reload, proxying `/ws` to the running hub; `/login` there signs in with a fresh one-time code, refusing other sites, and no response may be framed.
- Already in the branch, outside the specs: the restyled UI (palette, star toggles, sidebar header) and an e2e test that adding an already-listed repo selects its tab.

## Capabilities

### New Capabilities

### Modified Capabilities
- `protocol`: two link versions; `addPreset` and `removePreset` in the browser-link catalogue; shared constants.
- `daemon`: the handshake names `DAEMON_PROTOCOL_VERSION`.
- `hub`: the browser handshake names `BROWSER_PROTOCOL_VERSION`; default presets; preset edits and their propagation.
- `web`: handshake version; per-repo checked filter; sidebar width; preset editing; pane headers only in splits; accent-coloured active tabs.
- `cli`: version line with both protocol versions.

## Impact

- Code: `src/protocol/**`, `src/daemon/server/**`, `src/hub/config/**`, `src/hub/router/**`, `src/hub/server/listener.ts`, `src/cli/run.ts`, `src/web/**`, `vite.config.ts`, `package.json` (`dev` script), `README.md`.
- Architecture: no element or arrow changes; `protocol.arc42.md` purpose and principle 4 restated for two link versions (still enforced by `wire.golden.test.ts`).
- Wire: `wire.golden.json` re-blessed with `protocolVersions {daemon: 5, browser: 6}`; its daemon-link schemas and corpus verdicts are unchanged. `frozen.golden.json` unchanged.
- Upgrade: replacing a hub of the previous release needs no daemon restart; an open page of the previous release reloads once and then runs the new bundle.
- Tests: unit (protocol, golden guard, config, editor, sidebar, picker form), `test/process` (hub preset edits, defaults, version line), `test/e2e` (preset editing, per-repo filter, switch animation, sidebar width, pane headers, re-adding a repo).
- Dependencies: none added.
