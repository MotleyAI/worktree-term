## Context

See proposal.md – Why. The issue proposed a separate Chrome `--app` window per remote hub and an `ssh -L` forward; the interview replaced both (decisions below). DEV-2106 is merged into this branch: its `tailscaleLoginUrl`, `LineScanner`, `StderrTail` and `needs-login` banner are reused.

Applicable principles:
- **system** 1 (no new model arrows: `main → server/links/router/config` and `router → links/config` already exist), 3 (`node:net` newly allowed in `hub.server`), 5 (the print-code line, both fragments and `hubOpened.url` are schemas parsed where they enter), 6, 7 (every listener on `127.0.0.1`), 8 (unit, process, e2e, opt-in integration).
- **hub** 1, 2 (the tunnel listener faces the browser, so it lives in `server`; every SSH spawn lives in `links`), 3 (edited, approved wording below), 4, 5 (the relay holds only stream buffers).
- **protocol** 2–4 (browser version 9 → 10; frozen shapes for the cross-version print-code line and fragments).
- **web** 1, 2 (fragments decoded only in `client`), 7 (a page talks only to the hub that served it).

Approved arc42 edits:
- hub.arc42.md principle 3: `3. Binds \`127.0.0.1\` only; rejects any WebSocket upgrade without the token, a \`Host\` of \`127.0.0.1:<port>\`, and an \`Origin\` of that same host. [enforced: test:test/process/hub-server.test.ts]`
- hub.arc42.md Purpose & context, appended: `Forwards a stable loopback port per remote host to that host's hub.`

## Goals / Non-Goals

**Goals:**
- See any configured remote host's own hub (repos, worktrees, terminals) in the current tab, with nothing configured beyond the `hosts` entry.
- Get back to the laptop's hub with one pick.
- Each host keeps a stable origin, so its `localStorage` preferences survive.
- Opening never kills remote terminals.

**Non-Goals:**
- Showing several hubs in one page (use tabs).
- Opening hubs from a remote page directly; it goes through home.
- Reconnecting a remote page after the local hub restarts (reopen from the menu).
- Multi-hop: a remote hub's own `hosts`.

## Decisions

- **D1 — Same tab, cross-origin navigation (user's change).** The page cannot embed another hub, because of CSP `connect-src 'self'` and the Origin rule, and proxying was rejected in the issue. So the tab navigates to `http://127.0.0.1:<host port>/`. Session storage is per (tab, origin), so the home token survives a round trip in the same tab.
- **D2 — Every opening goes through home.** Only the home page sends `openHub`. A remote page's menu links to `home/` or `home/#hub=<name>`. `wtd ui <host>` opens `home/#code=…&hub=<host>`. One code path; errors and the login link always render where DEV-2106's UI lives; the home token is always present.
- **D3 — Hub-owned listener plus `ssh -W` per connection** rather than `ssh -L`. The hub sees every connection, so the tunnel's lifetime equals the page's connections, and no `-L`-through-mux semantics are relied on. OpenSSH multiplexes stdio forwarding (`-W`) over the control master.
- **D4 — `port` in `config.json`** (user's choice: one file shared by people and the machine). Assignment is max(hub port, host ports) + 1, wrapping to the lowest free port from 1024, and is done inside the `ConfigEditor` queue, recomputed on every retry. A present `port` is never touched. max+1 avoids reusing a removed host's port, which would otherwise hand a surviving tab's stored token for one remote hub to another. The residual case (removing the highest-port host, then adding a host while an old tab lives) is accepted.
- **D5 — Remote Host/Origin rule: any loopback port, same-origin.** `Host` must be `127.0.0.1:<port>`; `Origin` must equal `http://` + Host. DNS rebinding still fails (IP literal), and other loopback origins still fail (Origin ≠ Host). Rejected: binding a code to a forwarded port (stateful, breaks reloads after the remote hub restarts).
- **D6 — Header status line** instead of state inside the dropdown: approval happens in another tab and must stay visible.
- **D7 — `installHub` installs only.** `reinstallDaemon` would replace a daemon of another version and kill terminals. `HostCoordinator` becomes a FIFO queue of runs with explicit sharing (Codex finding 5): install shares a running or queued install or reinstall; restart shares a running or queued restart or reinstall; reinstall shares a reinstall; everything else waits its turn.
- **D8 — Frozen cross-version shapes.** The print-code line and both fragments pass between `wtd` installations of any versions, so they go in `frozen.golden.json` rather than under a link version.
- **D9 — Browser-only hub error codes** (Codex finding 4). `errorCode` is shared with the daemon link, so `hub-outdated` and `hub-failed` go in a `hubErrorCode` used only by the hub-to-browser `error`; the daemon schema is unchanged.
- **D10 — Element placement (no new arrows).**
  - `links`: `HubOpener` runs print-code over SSH, with a live stderr scan, a 30 s budget suspended by a login URL, a 4 KiB stdout cap and kill on cancel. `forward(alias, remotePort, socket)` spawns `ssh -W` and pipes both ways.
  - `server`: `TunnelListeners`, one per port. Its mutations are serialised; it binds, repoints, retires and closes.
  - `router`: `openHub` / `installHub`. It declares a `HubTunnels` interface (`ensure(host, port, remotePort)`, `probe(port)`) which `main` implements from `server` and `links`.
  - `main`: owns the latest-config view the listeners use to authorise each accepted connection.
- **D11 — Fresh config per open** (Codex finding 3). `openHub` and `installHub` resolve the host by its snapshot name against a fresh read of `config.json`; the latest valid read also refreshes the listeners' authorisation map, so a connection to a removed or remapped host is closed without SSH.
- **D12 — One opening per session** (Codex finding 6). A new `openHub` cancels the previous one: its SSH process is killed, and a cancellation token is checked after every await, so an ended opening never binds or replies. This also keeps the 16-code `CodeStore` on the remote safe from piling up.
- **D13 — Probe before navigating.** `GET /` through the new listener must return 200 within 10 s. This catches a refused forward (`AllowTcpForwarding no`, Tailscale ACLs) on the home page, where its stderr line can be shown.
- **D14 — Outdated detection by exit status.** 2 (usage error: no `--print-code`) or 127 (no `wtd`), or exit 0 with output that does not decode, means outdated. ssh's own failures exit 255 and are reported as `hub-failed` with the last stderr line.

## Risks / Trade-offs

- [`ssh -W` per connection costs one mux client per HTTP or WS connection] → Chrome keeps a handful per page; each is cheap over the master.
- [The control master is gone and Tailscale's check blocks a later `-W`] → that connection stalls until approval; the page's normal reconnect state shows. Reopening from home surfaces the login link.
- [Fake SSH can't prove real OpenSSH mux behaviour] → the fake learns `-W` for the default tiers, and an opt-in `test/integration` real-SSH test covers an existing and an absent master, a refused forward, loss of the master and child cleanup (Codex finding 7).
- [A hand-edited `port` on a live listener] → the next open rebinds on the new port and retires the old listener and its forwards.
- [A remote hub of another version is replaced by `--print-code`, closing other viewers' sessions there] → the same as `wtd ui` today; accepted.

## Migration Plan

Browser protocol 9 → 10 only: an open page reloads once under the stale-bundle rule. The daemon is untouched. `config.json` gains `port` entries lazily. Older remote `wtd` installs are detected and offered "Reinstall on <host>".
