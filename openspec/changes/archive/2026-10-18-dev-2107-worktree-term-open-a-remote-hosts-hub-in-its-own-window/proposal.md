## Why

From the laptop, the page shows remote hosts' repos only as they are listed in the laptop's own `config.json`; there is no way to see a remote host as if sitting at it — its own hub, repos, worktrees and terminals — without copying its repo lists (DEV-2107). A manual `ssh -L` fails the hub's Host check and has no way to deliver a one-time code.

## What Changes

- New remote command `wtd ui --print-code`: makes a hub of this version serve and prints `{"port","code"}` instead of opening a browser. Its output shape is frozen.
- `wtd ui <host>` opens the home page in a new window and switches it to that host's hub.
- A "Hubs" menu in the page header lists "This machine" and every configured remote host; picking one navigates the **current tab** to that hub (agreed change from the issue's separate window). A remote page's menu routes back through the home page.
- The local hub opens a remote hub on request (`openHub`): runs `wtd ui --print-code` over the host's SSH control master, surfaces a Tailscale check login link while waiting, binds a stable loopback port for the host and forwards each connection to the remote hub with `ssh -W`, probes the forward, and returns the URL to navigate to.
- Each `hosts` entry gains an optional `port`, assigned once by the hub and written into `config.json`; it keeps the host's origin, and so its `localStorage` preferences, stable.
- A header status line shows opening progress, the login link, and errors; "Reinstall on <host>" installs a newer `wtd` without restarting the daemon (`installHub`), then reopens.
- The hub accepts `Host` `127.0.0.1:<any port>` with a same-origin `Origin`, so a forwarded port reaches it; token and code requirements are unchanged.
- **BREAKING** (browser link only): `BROWSER_PROTOCOL_VERSION` 9 → 10 for `openHub`, `installHub`, `hubLogin`, `hubOpened` and the hub error codes `hub-outdated` and `hub-failed`; the daemon link is unchanged.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `cli`: `wtd ui [<host>] [--print-code]`; usage text; version output names browser protocol 10.
- `hub`: Host/Origin rule; per-host `port` in config and its assignment; opening a remote hub; tunnel listener and forwards; install-only operation.
- `protocol`: browser protocol 10 messages and hub error codes; frozen `--print-code` output and page fragment shapes.
- `web`: Hubs menu, status line, fragment handling, remote page title.

## Impact

- Code: `src/protocol` (messages, values, frozen and wire goldens), `src/cli/run.ts`, `src/hub/main` (`openUi`, print-code, wiring), `src/hub/server` (Host/Origin rule, tunnel listener), `src/hub/links` (print-code runner, `ssh -W` forward), `src/hub/router` (openHub, installHub, coordinator queue), `src/hub/config` (`port` schema, assignment edit), `src/web/client` (fragment), `src/web/ui` (menu, status line, title).
- Architecture: hub.arc42 principle 3 and Purpose (approved wording); `node:net` allowed in `hub.server`; no new model arrows.
- Tests: unit, process (fake SSH learns `-W`), e2e, opt-in real-SSH integration test.
- Docs: README.
- Depends on DEV-2106 (merged into this branch).
