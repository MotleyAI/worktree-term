## Why

On 2026-10-28 systemd-oomd killed the GNOME Terminal scope holding the hub, the daemon and every wtd terminal (79.7 GB at the kill, 91.8 GB peak, about 50 GB held for days), because the pressure on `user@1000.service` stayed above 50% for 20 s. Nothing recorded which process held the memory. Processes that outlive a closed terminal (jobs in their own process groups, `setsid` children, leaked test daemons) are the prime suspects but unproven; the next kill must be explainable from a log.

## What Changes

- The daemon appends one JSON line per sample to `memory.log` in the state directory: its own `process.memoryUsage()`, the size of its headless terminal mirrors, per live terminal the memory of its process tree with its largest processes, processes that escaped closed terminals, the rest of its cgroup, its cgroup's memory counters and pressure, and system memory pressure and headroom.
- Every terminal's environment carries `WTD_TERMINAL=<daemon pid>/<daemon instance>/<termId>`, so its processes stay attributable after they leave its session or outlive it; terminal ids are allocated before the process is spawned.
- The hub appends its own samples to `hub-memory.log`: its `process.memoryUsage()`, its child processes other than the daemon, its cgroup and system memory.
- Samples are taken every 60 s, and every 5 s while memory pressure is high or available memory is low; pressure is checked every 5 s. Linux-only sources are null where absent.
- Both logs rotate at 16 MiB, keeping three old files, written owner-only and one whole line per append.
- `WTD_MEMORY_SAMPLE_MS` overrides the 60 s base interval.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `platform`: host paths gain `memory.log` and `hub-memory.log`; new memory sampling (process table, cgroup, system) and rotating line log requirements.
- `daemon`: terminals are tagged in their environment and ids are allocated before spawning; new daemon memory log requirement.
- `hub`: new hub memory log requirement.

## Impact

- `src/platform/files` (rotating appender, new paths), new `src/platform/memory` component, `src/daemon/terminals` (pid, mirror stats), `src/daemon/server` (tagging, closed-terminal list, memory view), `src/daemon/main` (attribution, sampler wiring), `src/hub/main` (hub sampler), `src/cli` (passes `WTD_MEMORY_SAMPLE_MS`).
- `architecture/model.c4`: new `platform.memory` component and its arrows; `architecture/typescript.platform.arc42.md` purpose and principle 4; regenerated diagrams; `test/architecture/dependencies.ts` allowlist.
- No protocol, wire version or UI change. Up to 64 MiB of logs per process kind in the state directory.
