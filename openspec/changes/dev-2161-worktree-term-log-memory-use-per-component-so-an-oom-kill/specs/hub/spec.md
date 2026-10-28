## ADDED Requirements

### Requirement: Hub memory log
While it runs, the hub SHALL sample memory into `hub-memory.log` as a rotating line log, at the memory sampling cadence, stopping before its shutdown completes. Each line SHALL be a JSON object with:
- `ts` (ISO 8601), `source` `"hub"`, `pid`, `instance`, `version`, `intervalMs` (the base interval);
- `self`: the hub's `rss`, `heapTotal`, `heapUsed`, `external` and `arrayBuffers` in bytes;
- `children`: as a group, every process descending from the hub except a process running the hub's daemon command and its descendants;
- `cgroup`: the own cgroup's figures and, as a group, its `others` (members other than the hub and its `children`); null without cgroup v2;
- `system`: the system pressure and meminfo figures, each null when absent.
A group SHALL give `processes`, total `rss` and `anon`, and its 5 largest processes by `rss`, each with `pid`, `rss`, `anon` and `command`; without a process table the groups SHALL be null and `self` SHALL still be logged.

#### Scenario: Hub sample
- **WHEN** the hub has run long enough for one sample
- **THEN** `hub-memory.log` holds a line with `source` `"hub"`, the hub's `pid` and a `self.heapUsed` above zero

#### Scenario: SSH link counted as a child
- **WHEN** the hub holds an SSH link to a remote host and a sample is taken
- **THEN** the SSH process is among the hub's `children`

#### Scenario: Daemon not counted as a child
- **WHEN** the hub started the local daemon and a sample is taken
- **THEN** neither the daemon nor its terminals' processes are among the hub's `children`

#### Scenario: Sampling stops with the hub
- **WHEN** the hub shuts down
- **THEN** nothing is appended to `hub-memory.log` after it exits
