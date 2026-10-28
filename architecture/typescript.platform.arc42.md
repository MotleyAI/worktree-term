# Platform

## Purpose & context

Node-only infrastructure shared by daemon, hub and CLI: XDG paths and file I/O (`files`); reaching a host's daemon over its socket, with auto-start, or over `ssh` (`dialer`); installing the bundle locally or over `ssh` (`install`); sampling process, cgroup and system memory into a rotating log (`memory`).

## Building blocks

View `platform`.

<!-- likec4:platform -->
```mermaid
flowchart TD
  %% platform: Platform
  subgraph platform["Platform"]
    platform__files["Files"]
    platform__dialer["Dialer"]
    platform__install["Install"]
    platform__memory["Memory"]
  end
  subgraph daemon["Daemon"]
    daemon__main["Main"]
  end
  subgraph hub["Hub"]
    hub__server["Server"]
    hub__links["Links"]
    hub__config["Config"]
    hub__main["Main"]
  end
  cli["CLI"]
  platform__dialer --> platform__files
  platform__install --> platform__files
  platform__install --> platform__dialer
  platform__memory --> platform__files
  daemon --> platform__files
  daemon__main --> platform__memory
  hub__server --> platform__files
  hub__config --> platform__files
  hub__links --> platform__dialer
  hub__links --> platform__install
  hub__main --> platform__memory
  cli --> platform__files
  cli --> platform__dialer
  cli --> platform__install
  classDef leaf fill:none;
  class platform__files,platform__dialer,platform__install,platform__memory,daemon__main,hub__server,hub__links,hub__config,hub__main,cli leaf;
```
<!-- /likec4:platform -->

## Principles

1. Knows nothing of protocol, daemon, hub or web. [enforced: arch_check:model-truth]
2. Only `dialer` connects to or spawns a daemon. [enforced: test:test/architecture/dependencies.test.ts]
3. Files and directories it creates are owner-only. [enforced: test:src/platform/files/files.test.ts]
4. File writes are atomic; log appends write whole lines. [enforced: test:src/platform/files/files.test.ts]
