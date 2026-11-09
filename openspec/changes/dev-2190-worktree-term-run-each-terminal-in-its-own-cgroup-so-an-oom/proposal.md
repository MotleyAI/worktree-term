## Why

worktree-term runs the hub, the daemon and every terminal (with all their children) in the launcher's single cgroup, so systemd-oomd — which kills whole leaf cgroups — sees one candidate: on 2026-11-02 one terminal at 38 GiB made oomd kill the hub, the daemon and all 11 terminals. An out-of-memory kill must take out at most the terminal responsible, and the page must say so.

## What Changes

- New platform component `scopes`: decides whether a lasting systemd user manager is reachable (one the process runs under, or lingering), builds `systemd-run --user --scope` commands, moves the running process into a scope of its own, reads a scope's outcome and resets failed scopes.
- The daemon and the hub each move themselves into a scope of their own as they start, whatever started them (`wtd ui`, auto-start by dialing, `wtd hub`/`wtd daemon` in the foreground, `wtd-dev-restart`); a daemon running as `worktree-term-daemon.service` stays there.
- Each terminal runs in a scope of its own (`OOMPolicy=kill`), under `app-wtd.slice`; without a lasting user manager terminals start as today and the daemon logs why once.
- A terminal killed for lack of memory (by systemd-oomd or the kernel) is reported with `oom: true` in `termExited` and its `exit`, logged in `memory.log`, and shown as `killed: out of memory` in its tab, pane header and sidebar status on every page.
- Terminal shells run with `oom_score_adj` raised to at least 500, so a global kernel OOM picks a terminal process before the daemon or hub.
- Optional memory limits for terminal scopes: top-level `terminalMemory` and per-preset `memory` (`high`, `max`, `swapMax`) in `config.json`, sent with each preset and with `createTerm`.
- The daemon memory log gains each terminal scope's cgroup figures.
- **BREAKING** (wire): `DAEMON_PROTOCOL_VERSION` 10 → 11 and `BROWSER_PROTOCOL_VERSION` 13 → 14.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `platform`: new process-scopes requirement; memory sources read a given process's cgroup.
- `daemon`: daemon placement and terminal scopes (new); terminal creation takes memory limits; terminal lifetime reports `oom`; memory log gains scope figures and an `oom-kill` event.
- `hub`: hub placement (new); configuration gains `terminalMemory` and preset `memory`; effective preset limits (new).
- `protocol`: versions raised; `createTerm.memory`, `termExited.oom`, `exit.oom`, preset `memory`; memory size values.
- `cli`: `wtd daemon` and `wtd hub` place themselves as daemon and hub placement state.
- `web`: out-of-memory exits shown in tabs, pane headers and sidebar status; `createTerm` carries the preset's limits.

## Impact

- Code: `src/platform/scopes` (new), `src/daemon/main`, `src/daemon/terminals`, `src/daemon/server`, `src/hub/main`, `src/hub/config`, `src/hub/router`, `src/protocol`, `src/platform/memory`, `src/web/client`, `src/web/ui`; README.
- Architecture: `model.c4` (component `platform.scopes`; arrows `daemon.main -> platform.scopes`, `hub.links -> platform.scopes`), platform Purpose, daemon principle 8, dependency allowlist.
- Runtime dependencies: `systemd-run`, `systemctl` and `busctl` of the host's systemd, used only when a lasting user manager is reachable.
- Wire goldens re-blessed; old pages and daemons get the existing version-mismatch handling.
- Tests needing a lasting user manager skip, with a visible reason, where none is reachable (CI).
