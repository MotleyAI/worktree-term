# Platform

## Purpose & context

Node-only infrastructure shared by daemon, hub and CLI: XDG paths and file I/O (`files`); daemon socket connect and auto-start (`dialer`).

## Building blocks

View `platform`.

<!-- likec4:platform -->
```mermaid
flowchart TD
  %% platform: Platform
  subgraph platform["Platform"]
    platform__files["Files"]
    platform__dialer["Dialer"]
  end
  daemon["Daemon"]
  subgraph hub["Hub"]
    hub__server["Server"]
    hub__links["Links"]
    hub__config["Config"]
  end
  cli["CLI"]
  platform__dialer --> platform__files
  daemon --> platform__files
  hub__server --> platform__files
  hub__config --> platform__files
  hub__links --> platform__dialer
  cli --> platform__files
  cli --> platform__dialer
  classDef leaf fill:none;
  class platform__files,platform__dialer,daemon,hub__server,hub__links,hub__config,cli leaf;
```
<!-- /likec4:platform -->

## Principles

1. Knows nothing of protocol, daemon, hub or web. [enforced: arch_check:model-truth]
2. Only `dialer` connects to or spawns a daemon. [enforced: test:test/architecture/dependencies.test.ts]
3. Files and directories it creates are owner-only. [review]
4. File writes are atomic. [review]
