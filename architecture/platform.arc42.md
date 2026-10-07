# Platform

## Purpose & context

Node-only infrastructure shared by daemon, hub and CLI: XDG paths and file I/O (`files`); reaching a host's daemon over its socket, with auto-start, or over `ssh` (`dialer`); installing the bundle locally or over `ssh` (`install`).

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
  end
  daemon["Daemon"]
  subgraph hub["Hub"]
    hub__server["Server"]
    hub__links["Links"]
    hub__config["Config"]
  end
  cli["CLI"]
  platform__dialer --> platform__files
  platform__install --> platform__files
  platform__install --> platform__dialer
  daemon --> platform__files
  hub__server --> platform__files
  hub__config --> platform__files
  hub__links --> platform__dialer
  hub__links --> platform__install
  cli --> platform__files
  cli --> platform__dialer
  cli --> platform__install
  classDef leaf fill:none;
  class platform__files,platform__dialer,platform__install,daemon,hub__server,hub__links,hub__config,cli leaf;
```
<!-- /likec4:platform -->

## Principles

1. Knows nothing of protocol, daemon, hub or web. [enforced: arch_check:model-truth]
2. Only `dialer` connects to or spawns a daemon. [enforced: test:test/architecture/dependencies.test.ts]
3. Files and directories it creates are owner-only. [enforced: test:src/platform/files/files.test.ts]
4. File writes are atomic. [enforced: test:src/platform/files/files.test.ts]
