## 1. Architecture

- [x] 1.1 Apply design.md decision 6 verbatim: `platform.scopes` component and its arrows in `architecture/model.c4`, the platform Purpose clause, daemon principle 8, and the `platform.scopes` allowlist entry in `test/architecture/dependencies.ts`; regenerate the LikeC4 mermaid blocks; verify `la-arch-check` and `pnpm exec vitest run --project architecture` pass.

## 2. Protocol

- [x] 2.1 Memory size and memory-limits schemas, `createTerm.memory`, `termExited.oom`, `exit.oom`, preset `memory`; raise `DAEMON_PROTOCOL_VERSION` to 11 and `BROWSER_PROTOCOL_VERSION` to 14; re-bless the wire golden (frozen golden unchanged); verify the protocol delta's scenarios in `src/protocol/*.test.ts`.

## 3. Platform

- [x] 3.1 `src/platform/scopes`: lasting-user-manager finding (probe with 2 s timeout, kill and reap on timeout; cgroup line; linger file), unit names, scope command, entering a scope via busctl, scope outcome (poll, `Result`, `reset-failed`), sweep by pattern; programs from `WTD_SYSTEMD_RUN`/`WTD_BUSCTL`/`WTD_SYSTEMCTL`; verify unit tests with fake programs and the platform "Process scopes" scenarios (real ones skip without a lasting user manager).
- [x] 3.2 Memory sources: a process's cgroup (`/proc/<pid>/cgroup`, memory files incl. `memory.swap.max`, `memory.events` `oom_kill`); verify the two new "Memory sources" scenarios in unit tests.

## 4. Daemon

- [x] 4.1 Daemon placement in `daemon.main` (after the start lock, before serving; skip under `worktree-term-daemon.service`); verify the "Daemon placement" scenarios.
- [x] 4.2 Terminal launcher injected from `daemon.main` into terminals: scope command with limits when on, plain spawn when off, `/bin/sh` oom_score_adj trampoline in both modes; start-up log line, limits-ignored line once, start-up sweep; verify the "Terminal scopes" scenarios in `test/process/daemon-terminals-scopes.test.ts`.
- [x] 4.3 Exit: await the scope outcome for `SIGKILL` exits when on; `termExited`/`exit` carry `oom`; verify the "Terminal lifetime" scenarios.
- [x] 4.4 Memory log: per-terminal `scope` figures and the `oom-kill` line; verify the "Memory log" scenarios in `src/daemon/main/memory.test.ts` and `test/process/memory-log.test.ts`.

## 5. Hub

- [x] 5.1 Hub placement in `hub.main` (after the hub start lock, before listening), entering the scope through a `hub.links` call that uses `platform.scopes`; verify the "Hub placement" scenarios, asserting the hub record's pid's cgroup.
- [x] 5.2 Config: `terminalMemory`, preset `memory`, effective limits and the high-above-max refusal; verify the "Configuration" scenarios in `src/hub/config/*.test.ts`.
- [x] 5.3 Effective limits in `presets`; config edits keep stored `memory`; `createTerm.memory` relayed; verify the "Preset memory limits" scenarios.

## 6. CLI

- [x] 6.1 Confirm `wtd daemon` and `wtd hub` place themselves (through 4.1/5.1, no CLI-specific code); verify the CLI delta's foreground scenarios in `test/process/cli.test.ts` / `hub-cli.test.ts`.

## 7. Web

- [x] 7.1 `createTerm` carries the chosen preset's `memory` (`{}` without); verify the "Preset limits on new terminals" scenarios.
- [x] 7.2 `killed: out of memory` in tab, pane header and sidebar status; verify the "Out-of-memory exits" and "Worktree sidebar" scenarios in unit tests and `test/e2e` (e2e skips without a lasting user manager).

## 8. Docs and verification

- [x] 8.1 README: cgroup layout (slice, unit names), fallback, `terminalMemory`/preset `memory`; verify by reading it against the specs.
- [x] 8.2 Run `pnpm test`, `pnpm lint` and `tsc -b`; all green, and the user-manager tests ran (not skipped) on this machine.
