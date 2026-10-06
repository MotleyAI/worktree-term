## Context

PR 3 of 5 for DEV-1989 (see proposal.md). Binding: PR 1's design (archived change `2026-10-05-dev-1989-…`) D2 (separate hub process), D5, D6 (peer semantics, hub relay, stale-bundle reload), D7 (allowlist); PR 2's design (change `dev-2051-…`) D2–D4 (state paths, start lock, dialer) and its canonical repo names (`watchRepo` accepts only the main worktree's real path). `architecture/` is normative; principles applied here: system 1–3, 5–7; hub 1–5; web 1–7; cli 1–2; protocol 2–4; platform 1–4. No model arrow or allowlist entry is added; `hub.links` (`net`, `child_process`) keeps its allowance for PR 5's ssh link.

## Goals / Non-Goals

**Goals:**
- One authenticated, loopback-only path from the browser to every daemon, with the token never on a command line.
- Hub memory bounded per session independent of the number of terminals.
- Browser terminals that are never re-created while their PTY lives and are restored exactly after any reconnect.

**Non-Goals:**
- Splits, keyboard shortcuts, activity UI, presets (DEV-2053); remote hosts, repo add/remove/discovery and their UI, `reinstallDaemon` (DEV-2054); the search addon (dropped).
- Resolving symbolic links in configured repo paths: the daemon defines a repo's one name, and resolving locally would not carry over to remote hosts.

## Decisions

### D1 Protocol v3
`hosts[].instance` lets the browser distinguish a re-established link to the same daemon (keep terminal objects, re-attach) from a new daemon instance (terminal ids restarted: dispose). `token{token}` delivers the token to a code-authenticated session over the authenticated WebSocket, so web principle 7 (only one authenticated WebSocket to the hub) holds without an HTTP redemption endpoint. `host-unavailable` names requests to a host that is not connected. `codeResponse` puts the CLI↔hub HTTP body under the same schema discipline (system principle 5). `wire.golden.json` re-blessed; `frozen.golden.json` untouched. Alternative — treat every reconnect as a new instance — rejected: it re-creates live terminals (web principle 4) on every hub restart.

### D2 One-time codes instead of the token in the URL
`google-chrome --app=<url>` keeps the URL in its argv for the life of the browser process, readable by every local user via `/proc`. `wtd ui` therefore reads the owner-only token and asks the hub for a single-use code (30 s, ≤ 16 outstanding, consumed by the accepted upgrade in one synchronous step); only the code reaches argv. Alternative — token in the fragment as the issue sketched — rejected: a persistent credential exposed for the browser's lifetime.

### D3 WebSocket credential in `Sec-WebSocket-Protocol`
Browsers cannot set headers on a WebSocket; the subprotocol list is the only header the page controls. The hub parses it as exact comma-separated tokens: `wtd` plus exactly one of `wtd.token.<64 hex>` / `wtd.code.<64 hex>`, shape-checked before a constant-time compare, and selects `wtd`. The header is never logged. Alternative — query string — rejected: credentials in URLs travel into more places (history, logs) than a header.

### D4 Request checks
Exactly one `Host: 127.0.0.1:<port>` on every request (DNS rebinding), exactly one matching `Origin` on upgrades and on token-authenticated HTTP calls that carry one (cross-site and local web pages). CSP with `frame-ancestors 'none'` blocks clickjacking of destructive actions (close terminal, restart daemon); `style-src 'unsafe-inline'` is required by xterm.js's DOM renderer. Static files come from a list made at start, so no path is ever joined from request input.

### D5 Hub record, identity and replacement
`run/hub.json` = `{pid, port, instance}` written under `run/hub.lock` after the bind. `wtd ui` trusts a record only after `GET /api/identity` with the token answers with the record's `instance`; it replaces an older hub with `POST /api/shutdown` and waits for the port to close. No process is ever signalled from a record, so a reused pid cannot be hit (Codex review). The bind itself is the final single-instance guard: a hub that loses the race gets `EADDRINUSE`.

### D6 Placement
`hub.main/index.ts` exports two entries, `runHub` (`wtd hub`) and `openUi` (`wtd ui`); the CLI imports only `hub.main` (cli principle 1). `hub.server` owns the listener, token, codes, record, static files and the HTTP client calls to a running hub's endpoints (its own listener protocol). `hub.router` owns sessions, host status and forwarding; `hub.links` owns daemon links and every process the hub starts (hub principle 2), through `platform.dialer`'s detached spawn, which `dial` also uses — one spawning primitive. `hub.config` owns the schema and the session snapshot, reading through `platform.files`. Every hub element reaches the wire only through `protocol`.

### D7 Host status and session links
A pure state machine per (session, host): `connecting → connected | outdated`; failure or loss → `reconnecting` with backoff 250 ms ×2 to 5 s; `down` after 3 consecutive failures, retrying at the cap. It emits `hosts` on every entry change. One link per session and host (PR 1 D6) keeps request ids in the browser's namespace with no rewriting (hub principle 4).

### D8 Back-pressure by pausing link reads
The hub never buffers per terminal: acks travel end to end, so the daemon's flow window bounds each terminal (hub principle 5). Across terminals, the session's WebSocket send buffer is the only hub buffer: at ≥ 1 MiB unsent the hub pauses reading that session's daemon sockets, below 256 KiB it resumes. Writes towards the daemon (acks, input) are never paused, so a paused read cannot deadlock flow control. A browser that stops reading leaves the backlog in the daemon, whose 64 MiB connection bound (PR 2 D7) closes the link; the hub then reconnects. Alternative — close the session above 64 MiB buffered — rejected (Codex review): the hub would hold up to the sum of all terminal windows per session.

### D9 Serialized daemon restart
One restart operation per host for the whole hub: capture the old instance, send frozen `shutdown`, wait until the socket refuses connections, dial (auto-start runs the hub's own `wtd`) until a `hello` with a different instance and the hub's protocol, then complete every waiting `restartDaemon` with `done`; 10 s timeout → `internal`. Concurrent requests join the running operation, so a second restart can never kill the daemon the first one started.

### D10 Browser restore protocol
The client tracks, per host, the last instance seen `connected`. On `connected`: a different instance disposes that host's terminals and state; then, per repo, `watchRepo` → wait for its `done` → attach the previously attached terminals still in `repoState`. Pending requests to a host fail locally when it leaves `connected` or the WebSocket closes. A single WebSocket delivers in order, and a new WebSocket is a new session, so replies of an earlier link never arrive after a later one's.

### D11 Terminal manager, attach generations and acks
`web.terminals` owns one xterm `Terminal` and container per (host, termId), mounted once into a manager-owned layer outside Preact's tree and shown/hidden by style; only renderer addons are created and disposed. Each attach increments the terminal's generation and sets `{expected = S, consumed = S, lastAcked = S}`; snapshot writes are not counted. Output frames are written in order; each write callback carries its generation and, if current, advances `consumed` to the frame's end offset; an ack is sent when `consumed − lastAcked ≥ ACK_EVERY` or the terminal's write queue is empty, and only if it is above `lastAcked`. Callbacks of older generations are ignored, so a re-attach can never produce a stale or regressing ack.

### D12 WebGL LRU
A pure `WebglLru` (capacity 8) keyed by terminal, with each entry in state `dom` or `webgl` holding the exact addon instance. Showing a terminal moves it to the front; entering it evicts the least recent `webgl` entry (dispose its addon) before creating the new addon; creation failure leaves it `dom`. Context loss removes that exact instance (ignoring a loss reported for an already disposed one) and disposes it; the terminal re-enters on its next show. The ≤ 8 invariant is asserted after every transition in unit tests.

### D13 Switch measurement
`performance.mark('wtd:switch-start')` at the start of the input handler; after the switch is applied, the first `requestAnimationFrame` posts a `MessageChannel` message whose handler marks `wtd:switch-end`, which runs just after that frame's paint. A double `requestAnimationFrame` was rejected (Codex review proposal): it ends a full frame later and would make the 16 ms budget unreachable by construction. E2E runs Chrome headless with `--enable-gpu --use-angle=vulkan`, logs the WebGL renderer and fails if it is a software renderer; it asserts the median per the issue and logs p95 and max. Sidebar latency is measured from the git command's exit (Node wall clock) to the `MutationObserver` callback (page wall clock) on the same machine.

### D14 Build and version
Vite builds `src/web` with esbuild JSX (`automatic`, `preact`) and `define`s the package version for the browser `hello`. The hub serves `dist/web` relative to `dist/wtd.mjs`. Playwright runs without `--pass-with-no-tests`. Web unit tests get a typechecked tsconfig project.

## Risks / Trade-offs

- [GPU-dependent e2e budgets] → GPU flags plus a renderer assertion make a software fallback fail loudly instead of passing or failing for the wrong reason.
- [116 PTYs and xterms in the perf fixture] → fixture terminals run an idle shell; the fixture is built once per e2e worker.
- [Subprotocol token visible in DevTools] → same-user only; DevTools is not a cross-user channel.
- [Paused link reads also delay control events of that session] → only for a session that is not reading; other sessions have their own links.
- [Config snapshot per session means open pages keep old repos] → reload picks up edits; documented in the spec.
- [Claude Code rendering is not machine-checkable] → checked by hand in a headed Chrome app window during implementation with screenshots at several sizes; outcome recorded on DEV-2052; a defect stops the work.

## Migration Plan

Protocol 3: a protocol-2 daemon from PR 2 shows as `outdated`; the page offers the restart (D9). No state migration: `state.json` is unchanged.
