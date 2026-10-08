## Context

Follows the archived change `2026-10-07-dev-2054-…` (protocol 5, remote hosts, configuration edits). `architecture/` is normative; principles applied: system 1–8; protocol 2–4; hub 1, 5; web 1, 2, 7. No element or arrow of the model changes: preset edits travel the existing path `web.client → hub.server → hub.router → hub.config`.

Today: one `PROTOCOL_VERSION` (5) is sent in every `hello`; the hub marks a daemon `outdated` when its `hello.protocol` differs and the page reloads when the hub's differs. Presets come only from `config.json`; the web keeps one global filter and a fixed 240 px sidebar; every pane has a 20 px header.

## Goals / Non-Goals

**Goals:**
- A change confined to the browser link never marks a daemon outdated.
- Presets can be added and removed from the page, and every open page sees the result at once.
- Per-repo and per-browser view state survives reloads without touching daemon state.

**Non-Goals:**
- Editing or reordering an existing preset in place (remove and add instead).
- Sharing the sidebar width or filters across browsers (they are view preferences, like the selection).
- Changing the daemon link.

## Decisions

### D1 One version per link
`DAEMON_PROTOCOL_VERSION` = 5 is what daemons and their clients (hub links, one-shot links, `wtd connect`) exchange; `BROWSER_PROTOCOL_VERSION` = 6 is what the hub and the page exchange. The `hello` shape is unchanged and frozen, so both links still identify any peer. The golden snapshot records `protocolVersions {daemon, browser}`; a schema or corpus change of a direction needs its link's bump, a change to the shared constants (frames and flow control, used on both links) needs both. The browser link starts at 6 because it was at 5 and changes now.
Alternative — bumping the shared version to 6 — rejected: every running daemon would show as outdated and its restart would kill its terminals, for a change the daemon never sees; the hub always serves the page it talks to, so the two ends of the browser link cannot drift apart the way a long-lived daemon can.

### D2 Preset edits are configuration edits
`addPreset` appends; `removePreset` removes by exact name. When `config.json` has no `presets`, the edit starts from the defaults and writes them out with the change, so the result is what every page already showed. The editor's read → change → identity/content check → atomic replace loop, retried up to 3 times and serialized per hub, now runs for any array field; repos and presets share it, and a repo edit and a preset edit cannot lose each other. Refusals are `ConfigError`s answered as `error{code: internal}` naming the reason: a taken name, a 65th preset, removing the last preset, an invalid file. Removing an unknown name answers `done` and changes nothing.

### D3 Preset edits reach every session
Unlike the rest of a session's snapshot, presets change in open sessions: after a changed edit the hub answers `done` to the requester, then sends `presets` to every open session. Presets are global (not per host), so there is no host filter as for repos. An unchanged edit sends no `presets`.

### D4 Defaults `shell`, `claude`, `codex`
worktree-term exists to run coding agents; offering the two common agents by default saves every user the same edit. A missing command is the agent's own concern: the terminal shows the shell's error and exits.

### D5 View preferences per browser
The filter becomes a map from repo key to `checked` in `localStorage` (`wtd.filters`; a repo without an entry shows all; the old global `wtd.filter` is ignored). The sidebar width is `wtd.sidebarWidth`, an integer clamped to 160–640 px, default 260. Stored values are parsed and clamped when read (system principle 5). The filter switch is keyed by repo so that switching repos mounts it in its state instead of transitioning it; only a click animates it.

### D6 Pane headers only in splits
A single-pane tab's header repeats its tab: label, attention mark and close. Headers are shown only when the tab holds more than one pane; the terminal box then starts at the pane's top. The focused pane's header keeps the accent colour, and the active repo tab and terminal tab now use the same accent, so "where am I" reads the same at every level.

### D7 Vite for development only
`pnpm dev` runs Vite on `127.0.0.1:5173` (system principle 7) with the hub's port and token read from the running hub's record and token file. It proxies `/ws` with the hub's `Host`, rewriting `Origin` to the hub's own only when it is the dev page's, so another site's WebSocket is still refused by the hub. It serves `/login`, which asks the hub for a one-time code and redirects to `/#code=…`, refusing requests browsers mark as made by another site (`Sec-Fetch-Site: cross-site` or `same-site`); every response forbids framing, so no site can overlay the signed-in page. Nothing of it is in the shipped bundle; `vite build` ignores it.

## Risks / Trade-offs

- [A page of the previous release against a new hub] → its `hello.protocol` 5 differs from 6, so it reloads once and runs the new bundle, as for any hub upgrade.
- [A default preset whose program is not installed] → choosing it shows the shell's "command not found" and the terminal exits; removing it is one click.
- [Two people editing presets at once from different pages] → edits are serialized; a taken name is refused with its reason.
