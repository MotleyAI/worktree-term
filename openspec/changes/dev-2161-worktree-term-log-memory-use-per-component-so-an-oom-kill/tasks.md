## 1. Architecture (approved wording, design D10)

- [ ] 1.1 Add `memory = component 'Memory'` inside `platform` in `architecture/model.c4` with arrows `platform.memory -> platform.files`, `daemon.main -> platform.memory`, `hub.main -> platform.memory`; regenerate diagrams with `la-arch-diagrams`; verify `la-arch-check` passes
- [ ] 1.2 Apply the approved Purpose and principle 4 wording to `architecture/typescript.platform.arc42.md` verbatim from design D10; add `'platform.memory': ['fs']` to `test/architecture/dependencies.ts`; verify `test/architecture` passes

## 2. Tests first (pr-tests)

- [ ] 2.1 `src/platform/files/files.test.ts`: `memoryLog` / `hubMemoryLog` paths; rotating appender — rotation at the limit, existing `.1`–`.3` shifted and `.3` replaced, failure at each rename reported with the line still appended and rotation retried, a line over 16 MiB written after rotating, mode 0600, one whole line per append; verify they fail before implementation
- [ ] 2.2 `src/platform/memory/*.test.ts`: process table, cgroup and system readers against fake `/proc` and `/sys/fs/cgroup` trees (present, absent → null, malformed → reported + null, process vanishing mid-read, `max` → null, command cut to 200 characters); group summarising (totals, top N by rss); sampler cadence with a fake clock (first sample at start, calm 60 s, tight by system PSI / cgroup PSI / MemAvailable → within 5 s then every 5 s, back to calm, check period = base interval below 5 s, slow sample single-flight, stop with a sample in flight writes nothing, write failure reported and sampling continues, `WTD_MEMORY_SAMPLE_MS` parsing); verify they fail before implementation
- [ ] 2.3 `src/daemon/main/*.test.ts` (attribution module): rules 1–5 of design D2 — session member, descendant outside the session, detached tagged child of a live terminal, running foreign daemon (including a child no longer descending from it), tag of a pid that is no running daemon, untagged process in a closed terminal's session, cgroup `others`, daemon excluded; closed terminal forgotten on its first empty sample and at most 256 kept; escaped capped at 20 with `escapedOmitted`; null groups without a process table; mirror byte estimate; verify they fail before implementation
- [ ] 2.4 `src/daemon/server/daemon.test.ts`: terminal env carries `WTD_TERMINAL=<pid>/<instance>/<termId>`; id taken before spawning (failed spawn leaves a gap); `memoryView()` lists live terminals (termId, repo, worktree, preset, pid, mirror) and closed ones; `src/daemon/terminals/terminal.test.ts`: `pid` and `mirrorStats()` (lines grow with output, alternate buffer counted); verify they fail before implementation
- [ ] 2.5 Hub children selection unit test (descendants by ppid minus the daemon-command subtree, detached descendants included); verify it fails before implementation
- [ ] 2.6 Process tests in `test/process/memory-log.test.ts` (with `WTD_MEMORY_SAMPLE_MS` short): daemon line shape; terminal running `sleep 1000` lists it; `setsid sleep 1000 &` then `closeTerm` → escaped with termId and worktree; a `SIGHUP`-ignoring job in its own process group survives `closeTerm` → escaped; live terminal's `setsid` child → detached, not escaped; `echo $WTD_TERMINAL` shows pid/instance/termId; nothing appended after daemon shutdown; hub writes `hub-memory.log` with `source` `"hub"`, an SSH link child (fake ssh) and without the daemon or its terminals; nothing appended after hub shutdown. Kill every escaped test process in teardown. Verify they fail before implementation
- [ ] 2.7 Keep `test/process/rss.test.ts` unchanged; it must pass with sampling on after implementation

## 3. Platform

- [ ] 3.1 `platform.files`: `HostPaths.memoryLog`, `hubMemoryLog`, and the rotating whole-line appender (design D8); verify 2.1 passes
- [ ] 3.2 New `src/platform/memory/` (index.ts exposing only its surface): readers with configurable roots and boundary parsing, group summarising, the single-flight adaptive sampler (design D6, D9, D11); verify 2.2 passes

## 4. Daemon

- [ ] 4.1 `TerminalProcess.pid` and `mirrorStats()`; `Daemon` tags terminal env, takes ids before spawning, keeps the closed-terminal list, exposes `memoryView()`; verify 2.4 and existing daemon tests pass
- [ ] 4.2 `daemon.main`: attribution module (design D2, D7) and sampler wiring into `memory.log`, stopped before `daemon.shutdown()` resolves; `cli` passes `WTD_MEMORY_SAMPLE_MS`; verify 2.3 and the daemon cases of 2.6 pass

## 5. Hub

- [ ] 5.1 `hub.main`: hub sampler into `hub-memory.log` with children selection (design D4), stopped before the hub exits; verify 2.5 and the hub cases of 2.6 pass

## 6. Gates

- [ ] 6.1 Run `pnpm lint`, `tsc -b`, `la-arch-check` and the full `pnpm test`; all green, including `test/process/rss.test.ts`
