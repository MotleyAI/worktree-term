## Context

See proposal.md (Why). Today the daemon spawns each PTY directly (`src/daemon/terminals/terminal.ts`), the dialer and `wtd ui` start the daemon and hub with `spawn(..., {detached: true})` (`src/platform/dialer`, via `src/hub/links`), and `wtd-dev-restart` uses `setsid`; none of these changes the cgroup. Verified on the target host (Ubuntu 24.04, systemd 255):

- `systemd-run --user --scope` adds ~6 ms per spawn (22 ms cold) and keeps the caller's environment and pid (it execs in place).
- A scope with `MemoryMax=64M MemorySwapMax=0 OOMPolicy=kill` running a hog is SIGKILLed as a whole; the unit stays `failed` with `Result=oom-kill` until `reset-failed`, after which it is gone.
- `busctl --user call org.freedesktop.systemd1 /org/freedesktop/systemd1 org.freedesktop.systemd1.Manager StartTransientUnit 'ssa(sv)a(sa(sv))' <unit> fail 2 PIDs au 1 <pid> Slice s app-wtd.slice 0` moves a running process into a new scope.
- systemd-oomd only kills leaf cgroups (or ones with `memory.oom.group=1`), choosing by reclaim activity; it ignores `ManagedOOMPreference` on cgroups not owned by root, so user units cannot ask to be avoided. oomd kills are reported to the owning manager, which sets `Result=oom-kill`.
- The user manager delegates `cpu memory pids`; `Linger=no` locally; CI runners have no user session.

Applicable principles: system 1–3 (model arrows, `index.ts` surfaces, dependency allowlist), 5 (systemctl/busctl output parsed at the boundary), 6 (failures reported), 8 (tests per tier); platform 1–4; daemon 1 (the launcher is injected by `main`, no new imports among `worktrees`/`terminals`/`state`), 3 (an OOM kill is a process exit), 8 (new); hub 2 (only `links` spawns — `hub.main` enters its scope through `links`, which calls `platform.scopes`); web 1–2, 4.

**Symptom → structural cause.** The symptom (one terminal's memory takes everything down) is one instance of "every process worktree-term starts shares its starter's cgroup". The fix gives that one rule a single home, `platform.scopes`: the daemon and hub place themselves as they start (covering every way they are started, including the foreground commands), and the daemon starts every terminal in its own scope. No start site keeps its own placement logic.

## Goals / Non-Goals

**Goals:**
- One cgroup per terminal, one for the daemon, one for the hub, under `app-wtd.slice`, whenever a lasting user manager is reachable; otherwise today's behaviour.
- OOM kills (oomd or kernel) are attributed to the terminal and shown and logged as such.
- Optional per-preset/global memory limits.

**Non-Goals:**
- `ManagedOOMPreference` for the daemon or hub (ignored by oomd for user-owned cgroups on systemd 255).
- Protecting against kills inside a terminal by anything but whole-terminal semantics (`OOMPolicy=continue` rejected).
- Editing memory limits from the page (config.json only).
- A CI step providing a user manager; such tests skip in CI.
- Enabling lingering for the user.
- A terminal-creation latency budget (none exists; measured overhead ~6 ms).

## Decisions

1. **Terminal scope mechanism: `systemd-run --user --scope` wrapping the PTY command.** Alternatives: D-Bus `StartTransientUnit` moving the spawned pid (a window where early children stay in the daemon's cgroup; needs a D-Bus client), a delegated daemon writing `cgroup.procs` (needs delegation, reimplements systemd, no `Result`). Measured ~6 ms per spawn. (default)
2. **Scope of the change includes issue items 5 (per-terminal cgroup figures in the memory log, additive to the process grouping) and 6 (configurable limits).** (user)
3. **`OOMPolicy=kill` for terminal scopes.** Any kernel OOM in a terminal kills the whole terminal with `Result=oom-kill`, the same as an oomd kill; `memoryHigh` is the throttle-without-kill option. Rejected: `stop` (systemd sends SIGTERM, which interactive shells ignore, so the scope hangs up to 90 s), `continue` (no oom result; the test would not model oomd). (user)
4. **CI: no user-manager step; tests needing a lasting user manager skip where none is reachable.** (user) The skip prints a visible reason (`skipped: no lasting systemd user manager`), so a local run that lost the user bus is noticed. (default)
5. **Terminal shells get `oom_score_adj` ≥ 500**, so a global kernel OOM picks a terminal process before the daemon or hub (an unprivileged process can raise, not lower, the score). (user) It is set by a `/bin/sh` trampoline before the shell runs — `read a </proc/self/oom_score_adj && [ "$a" -lt 500 ] && echo 500 >/proc/self/oom_score_adj; exec "$@"` — in both modes, so no child can be forked before the write; without `/proc` it does nothing, and an unexpected failure prints in the terminal rather than being swallowed. (codex)
6. **Architecture edits (user, approved wording):**
   - `model.c4`: component `scopes = component 'Scopes'` in `platform`; arrows `daemon.main -> platform.scopes` and `hub.links -> platform.scopes` (the earlier `platform.dialer -> platform.scopes` dropped with decision 13; `hub.links` rather than `hub.main` so hub principle 2 — only `links` spawns processes — holds unchanged, `hub.main` entering its scope through `links` as it already starts the hub through `links`); ALLOWLIST `'platform.scopes': ['child_process', 'fs']`.
   - `typescript.platform.arc42.md` Purpose: append `; running a process in a systemd user scope of its own (`scopes`)` after the `memory` clause.
   - `typescript.daemon.arc42.md`: `8. Each terminal runs in a scope of its own when a lasting user manager (≡ one the daemon runs under, or lingering) is reachable. [enforced: test:test/process/daemon-terminals-scopes.test.ts]`
7. **Limits gain `swapMax` (MemorySwapMax)** beyond the issue's high/max: with swap present, `MemoryMax` alone swaps instead of killing, so the kill test would not be deterministic. (user)
8. **Limits configuration**: top-level `terminalMemory` and per-preset `memory`, overridden key by key; systemd size syntax or percent; effective limits sent in `presets` and copied by the page into `createTerm`; the preset form exposes no limits; config edits keep them; without scopes limits are ignored and logged once. (default) Effective limits whose `high` exceeds `max`, both absolute, are refused at config load naming the preset; percent and absolute values are not compared; `swapMax` is independent. (codex)
9. **Scopes only with a lasting user manager** (the process runs under `user@<uid>.service`, or the user lingers). Moving a process from an SSH session scope into the user manager without lingering would kill it at logout with `user@.service`; a process already under `user@` loses nothing. (default) Codex suggested requiring lingering even under `user@` — rejected (codex): such a process already dies at logout today, the predicate only guarantees placement never shortens a lifetime, and approved principle 8 defines "lasting" exactly so.
10. **OOM detection by the scope's `Result`**, read after the exit (no `--collect`; `reset-failed` after reading; a start-up sweep of this state directory's failed terminal units), queried only for exits by `SIGKILL`. Alternative: watching `memory.events` and oomd's xattrs needs the cgroup alive and an xattr API Node lacks. (default) Codex suggested querying every failed exit, as a kill might surface as code 137 — rejected (codex): `--scope` execs in place, so the PTY child is the shell, and both oomd and `OOMPolicy=kill` SIGKILL every process of the scope, so the shell always reports `SIGKILL`; querying every failed exit would delay an `exit 1` that leaves a background job by up to 2 s.
11. **Unit names keyed by an 8-hex hash of the state directory**, so test daemons and the real one never collide and the sweep touches only its own units; daemon and hub scopes carry a random suffix so an old scope kept alive by leftover processes never blocks a start. (default)
12. **Slice `app-wtd.slice` under `app.slice`**: oomd only considers leaf cgroups, so the slice is not itself a candidate. (default)
13. **The daemon and hub place themselves** as they start (after their start lock, before serving), through `busctl … StartTransientUnit` with their own pid; the daemon stays put under `worktree-term-daemon.service`. This covers `wtd ui`, dialing, the foreground `wtd hub`/`wtd daemon`, `wtd-dev-restart` and remote hubs in one code path; the dialer, links and `wtd-dev-restart` need no change. Alternative: wrapping at each start site plus a self-re-exec for foreground commands (two mechanisms, three sites; Node's `process.execve` is experimental). (codex, user) Replaces the earlier plan of wrapping at the dialer and links and starting the hub in `wtd-dev-restart` through `wtd ui --print-code`. (user)
14. **Memory log**: per-process grouping kept; each terminal record gains `scope` figures; an `oom-kill` event line on each OOM exit. (default)
15. **Protocol**: `oom` boolean on `termExited` and `exit`; required `memory` on `createTerm`, optional `memory` on presets; `DAEMON_PROTOCOL_VERSION` 11, `BROWSER_PROTOCOL_VERSION` 14 (daemon messages ride inside `host{m}`); the "another protocol version" hello scenario moves to 99. (default)
16. **No new terminal-creation latency budget**: none exists; the existing e2e perf budgets must still pass. (default)
17. **Spec deltas cover every capability touched** (platform, daemon, hub, protocol, cli, web), including that a page or client connecting after the kill still sees `oom`. (codex)
18. **Process tests assert the cgroups of the processes actually serving** — the daemon pid from `WTD_TERMINAL`, the hub pid from its hub record — against the launcher's and the terminals' cgroups, not a wrapper's. (codex)
19. **The scope probe is killed (`SIGKILL`) and reaped when it exceeds 2 s**, the reason naming the timeout; tested with a hanging fake program. (codex)
20. **The hub enters its scope through `hub.links`** (arrow `hub.links -> platform.scopes`), not from `hub.main` directly, so hub principle 2 holds as written; amending the principle with a `main` exception rejected. (user)

## Risks / Trade-offs

- [Real user scopes created by local test runs] → unit names carry the test state directory's hash; scopes are collected when empty and failed ones reset by the test or the sweep.
- [CI never runs the user-manager tests] → visible skip reason; the full suite runs locally in the `/la:pr` flow; fallback paths are tested everywhere with a failing `WTD_SYSTEMD_RUN`.
- [A `SIGKILL` exit whose scope keeps other processes waits 2 s before `termExited`] → only manual `kill -9` of the shell with surviving background jobs; reported correctly as `oom: false`.
- [A failed terminal unit left by a daemon crash] → reset by the next daemon start's sweep.
- [systemd-run failing after start-up (user manager gone)] → the terminal shows systemd-run's error and a failed exit, as a failing command does.
- [Terminal processes now preferred by the global OOM killer over desktop apps] → intended: terminals hold the large workloads.
- [`memory.oom.group=1` makes the whole terminal the kernel's unit of kill] → accepted with `OOMPolicy=kill` (decision 3).

## Migration Plan

Old daemons and pages meet the raised protocol versions through the existing version-mismatch handling (restart/reinstall daemon, reload the page). The first new daemon start moves itself and its new terminals into scopes; terminals started by an older daemon end with it, as on any daemon restart. Rollback: install the previous release; leftover `wtd-*` scopes end when their processes do.
