## Context

See proposal.md for the incident. Constraints found while planning:

- systemd-oomd killed the `vte-spawn-…` scope because the pressure of its monitored ancestor `user@1000.service` was 79.97% > 50% for > 20 s; the root slice also has `ManagedOOMSwap=auto`. Pressure and swap, not RSS alone, decide a kill.
- The daemon is spawned detached (own session) by whoever dials first, so it lives in that process's cgroup: on the dev box the hub and daemon sit in a GitKraken app scope with 141 processes. The cgroup is shared with unrelated apps.
- `TerminalProcess.close()` sends `SIGHUP`/`SIGKILL` to the shell's process group only. An interactive shell puts each job in its own process group, so jobs that survive the hangup (an older terminal's `claude`, `tsserver`, `codex` on the dev box) outlive the terminal; `setsid` children (a leaked test daemon) leave the session altogether and get reparented to `systemd --user`.
- The hub is a separate process and the parent of the daemon it starts; only it can report its own heap.
- Principles: system 1/3/5/6/8; daemon 1 and 3; platform 1, 3 and 4 (amended, D10).

## Goals / Non-Goals

**Goals:**
- Name the processes, terminals and escaped leftovers holding memory in the minutes before a kill, and the pressure/swap figures oomd acted on.
- Attribute leftovers to the terminal they came from, across daemon restarts and cgroups.

**Non-Goals:**
- Preventing the kill (e.g. a systemd scope per terminal) or killing escaped processes.
- Showing memory in the UI; any protocol change.
- Native macOS sources (`ps`, `task_info`): without `/proc` only `self` and `mirrors` are logged.

## Decisions

### D1 — Terminals are tagged; cgroup leftovers are a separate bucket (user)
Every terminal's environment gets `WTD_TERMINAL=<daemon pid>/<daemon instance>/<termId>`; samples scan all of the user's processes, so escapes from earlier daemons in other cgroups are found too. The rest of the daemon's cgroup is logged as `others`.
- Alternative: "cgroup members under no live terminal" as the issue words it — rejected by the user: on a shared app scope it lists GitKraken and editors and cannot tell which processes wtd leaked.

### D2 — Attribution rules (default; rule 3 and closed-terminal expiry from codex)
In order: (1) live member = session id equals the shell pid, or descends from the shell by ppid; (2) tag names this daemon (pid and instance) and a live terminal → that terminal's `detached`; (3) tag names another pid whose command line is a running `wtd … daemon` (last argument `daemon`, an argument whose basename starts with `wtd`) → that daemon's, not escaped, whatever its ancestry — that daemon logs its own escapes; (4) any other tagged process, or an untagged process in the session of one of the last 256 terminals this daemon closed → escaped, grouped by tag; (5) other cgroup members → `others`. The daemon itself is only in `self`. A remembered closed terminal is forgotten as soon as a sample finds none of its processes (tagged or in its session), which bounds session-id reuse to the life of the leftovers.
- Codex: rule 3 originally required the process to still descend from the foreign daemon, which misfiled double-forked children of its live terminals as escaped (folded). Remembered sessions are exposed to pid reuse; the dead shell's start time cannot be checked, so expiry on the first empty sample is used instead (folded, differently).

### D3 — Terminal ids taken before spawning (default)
The tag needs the id in the environment, so `createTerm` takes `nextTermId++` before calling `spawnTerminal`; a failed spawn leaves a gap. The spec only requires ids to count up and never be reused.

### D4 — Hub logs itself to `hub-memory.log` (user)
`self` from its own `process.memoryUsage()`; `children` are all ppid-descendants of the hub except the subtree rooted at a process whose command line equals the hub's daemon command (`[...wtd, 'daemon']`), which the daemon logs; its `cgroup` has `others` too, which covers a daemon in its own systemd unit cgroup.
- Alternatives: the daemon reading the hub's `/proc` entry (no heap breakdown; the hub record parser would have to leave `hub.server`) or one shared file (two writers racing on rotation) — rejected by the user.
- Codex: limiting children to the hub's session missed detached descendants (folded).

### D5 — Fields beyond the issue (user)
Own cgroup `memory.pressure`, `memory.swap.current`, `memory.max`, `memory.high`; `/proc/meminfo` `MemTotal`, `MemAvailable`, `SwapTotal`, `SwapFree`. They are what oomd's pressure and swap policies act on. `RssAnon` is logged next to `VmRSS` because sums of `VmRSS` count shared pages (the node binary) repeatedly (default).

### D6 — Cadence (default; 5 s check from codex)
Pressure (system and cgroup PSI) and meminfo are checked every 5 s (2–3 small reads); a full sample is taken when the base interval (60 s, `WTD_MEMORY_SAMPLE_MS` override) has passed or memory is tight (`some avg10` ≥ 10 or `MemAvailable` < 10% of `MemTotal`). The check period drops to the base interval when that is below 5 s, for tests. One loop, single-flight: the next check is scheduled after the previous check/sample (and its write) finished; the timer is `unref`ed; `stop()` cancels the timer and suppresses the write of a sample in flight.
- Codex: a pure 60 s timer would notice rising pressure up to a minute late, inside oomd's 20 s window (folded); overlapping samples could race rotation (folded).

### D7 — Bounded records (default; caps from codex)
Top 3 processes per terminal member/detached group, top 5 elsewhere, commands cut to 200 characters; at most 20 escaped groups (largest `rss`), the rest summed in `escapedOmitted`. Terminals are all listed (about 1 KB each). Estimated mirror bytes = (normal + alternate buffer lines) × cols × 12 (xterm stores 3 × 32-bit words per cell).
- Codex: the escaped list was unbounded, so one line could exceed the rotation size (folded).

### D8 — Rotating line log (default)
Before each append, if size + line > 16 MiB: rename `.2`→`.3`, `.1`→`.2`, log→`.1` (missing skipped, `.3` replaced), then append. One `appendFile` per line (O_APPEND, mode 0600). A failed rename is reported, the line is still appended, and rotation is retried on the next append. A line over 16 MiB is written after rotating, so a log never exceeds the limit by more than one line. At ~10 KB per daemon sample (10 terminals) that is ~14 MB/day, so 4–5 days of history; the hub's lines are a few hundred bytes.

### D9 — Placement (default)
- New `platform.memory` (allowlist `fs`): readers for the process table (`stat`, `status`, lazily `environ` and `cmdline`), the own cgroup and the system, all taking `/proc` and `/sys/fs/cgroup` roots so unit tests use fake trees; text is validated and parsed at this boundary into typed values or null (system principle 5); the sampling loop of D6; group summarising (totals + top N). It writes through `platform.files`.
- `platform.files`: the rotating appender of D8; `HostPaths.memoryLog` and `hubMemoryLog`.
- `daemon.terminals`: `TerminalProcess.pid` and `mirrorStats()`.
- `daemon.server`: tagging (D3), the closed-terminal list, and `Daemon.memoryView()` returning plain data in its own types (no platform import).
- `daemon.main`: a pure attribution module (D2) and the sampler wiring; `hub.main`: the hub sampler (D4). `cli` passes `WTD_MEMORY_SAMPLE_MS` through `DaemonRun`/`HubRun` env.
- Model arrows: `platform.memory -> platform.files`, `daemon.main -> platform.memory`, `hub.main -> platform.memory`.

### D10 — Architecture edits (user, approved wording)
- `architecture/model.c4`: inside `platform`, `memory = component 'Memory'`; arrows `platform.memory -> platform.files`, `daemon.main -> platform.memory`, `hub.main -> platform.memory`. Diagrams regenerated with `la-arch-diagrams`.
- `architecture/typescript.platform.arc42.md` Purpose (user, approved wording): "Node-only infrastructure shared by daemon, hub and CLI: XDG paths and file I/O (`files`); reaching a host's daemon over its socket, with auto-start, or over `ssh` (`dialer`); installing the bundle locally or over `ssh` (`install`); sampling process, cgroup and system memory into a rotating log (`memory`)."
- Platform principle 4 (user, approved wording): "4. File writes are atomic; log appends write whole lines. [enforced: test:src/platform/files/files.test.ts]"
- `test/architecture/dependencies.ts`: `'platform.memory': ['fs']`.
- rejected (codex): rewording principle 4 as "File replacements are atomic; logs are appended as one whole-line write" — the user had approved the wording above, whose second clause already scopes the exception, and "replacements" would weaken the existing guarantee.

### D11 — Failure handling (default)
`ENOENT`/`EACCES` on a source → that section null, silently (absence is the expected state on macOS or without cgroup v2). Malformed content or any other error → reported through the process's `report` (`daemon.log` / `hub.log`), section null, sample still written. A vanished process (`ENOENT`/`ESRCH` mid-read) is left out. A failed write is reported; the loop continues (system principle 6).

### D12 — Test coverage (default; rotation cases from codex)
Unit: parsers against fake trees including absent and malformed files; attribution rules 1–5 including a running foreign daemon, a double-forked foreign child and an env-scrubbed process in a closed session, closed-terminal expiry, the escaped cap; cadence with a fake clock (calm, tight, back to calm, slow sample, stop in flight); rotation (sequence, existing `.1`–`.3`, failure at each rename and recovery, oversized line, mode). Process: daemon terminal tree, `setsid` escape, `SIGHUP`-ignoring job escape, detached child of a live terminal, tag in the environment, hub sample with an SSH child and without the daemon, nothing written after shutdown; `test/process/rss.test.ts` still passes with sampling on.

## Risks / Trade-offs

- [Scanning every user process each minute] → `environ` is read only outside live sessions and `cmdline` only for top-list entries; at 5 s cadence under pressure the scan adds I/O when the host is already struggling — acceptable for ~1k small procfs reads.
- [A process that scrubs its environment and calls `setsid`] → not attributable; it shows only under `others` if it is in the daemon's cgroup.
- [Hub and daemon samples in two files] → lined up by `ts`.
- [Session-id reuse for remembered closed terminals] → bounded by forgetting a terminal on its first empty sample (D2).
- [Logs up to 64 MiB per file set] → owner-only, in the state directory.

## Migration Plan

None: the logs appear after the daemon and hub are restarted on the new version; no protocol change. Rollback is reverting; leftover log files are inert.
