# Hub

## Purpose & context

Local-only gateway. Serves the web bundle and one WebSocket per browser session; per session, holds one link per configured host (local socket or `ssh <host> wtd connect`). Owns `config.json`.

## Building blocks

View `hub`.

<!-- likec4:hub -->
```mermaid
flowchart TD
  %% hub: Hub
  protocol["Protocol"]
  subgraph platform["Platform"]
    platform__files["Files"]
    platform__dialer["Dialer"]
  end
  subgraph hub["Hub"]
    hub__server["Server"]
    hub__links["Links"]
    hub__config["Config"]
    hub__router["Router"]
    hub__main["Main"]
  end
  cli["CLI"]
  hub --> protocol
  hub__server --> platform__files
  hub__config --> platform__files
  hub__links --> platform__dialer
  hub__main --> hub__server
  hub__main --> hub__router
  hub__main --> hub__links
  hub__main --> hub__config
  hub__server --> hub__router
  hub__router --> hub__links
  hub__router --> hub__config
  cli --> hub__main
  classDef leaf fill:none;
  class protocol,platform__files,platform__dialer,hub__server,hub__links,hub__config,hub__router,hub__main,cli leaf;
```
<!-- /likec4:hub -->

## Principles

1. Reaches every daemon, local or remote, only through a link; never imports daemon code. [enforced: arch_check:model-truth]
2. Only `server` faces the browser; only `links` opens daemon connections or spawns processes. [enforced: arch_check:model-truth] [enforced: test:test/architecture/dependencies.test.ts]
3. Binds `127.0.0.1` only; rejects any WebSocket upgrade without the token and matching `Origin` and `Host`. [enforced: test:test/process/hub-server.test.ts]
4. Addresses daemon entities as (host, id) and never rewrites daemon ids. [enforced: test:test/process/hub-router.test.ts]
5. Relays terminal bytes without buffering beyond frames in flight; state other than config lives in daemons. [enforced: test:test/process/hub-router.test.ts]

## Rationale

Acks travel end to end, so bytes in flight through the hub are bounded by the daemon's flow window.
