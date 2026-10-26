# Web

## Purpose & context

Browser UI served by the hub: repo tabs, worktree sidebar, terminal tabs and splits.

## Building blocks

View `web`.

<!-- likec4:web -->
```mermaid
flowchart TD
  %% web: Web
  protocol["Protocol"]
  subgraph web["Web"]
    web__client["Client"]
    web__terminals["Terminals"]
    web__layout["Layout"]
    web__ui["UI"]
    web__main["Main"]
  end
  web__client --> protocol
  web__main --> web__ui
  web__main --> web__client
  web__main --> web__terminals
  web__ui --> web__client
  web__ui --> web__terminals
  web__ui --> web__layout
  web__terminals --> web__client
  classDef leaf fill:none;
  class protocol,web__client,web__terminals,web__layout,web__ui,web__main leaf;
```
<!-- /likec4:web -->

## Principles

1. Uses no Node APIs; `layout` is pure. [enforced: test:test/architecture/dependencies.test.ts]
2. Only `client` decodes or encodes wire data. [enforced: arch_check:model-truth]
3. `terminals` never depends on `ui`. [enforced: arch_check:model-truth]
4. A terminal, once created, is never re-created or unmounted while its PTY lives. [enforced: test:test/e2e/terminals.spec.ts] [enforced: test:test/e2e/restore.spec.ts]
5. Switching worktrees performs no network round trip. [enforced: test:test/e2e/terminals.spec.ts]
6. At most 8 WebGL contexts are live; other terminals render via DOM. [enforced: test:test/e2e/renderer.spec.ts] [enforced: test:src/web/terminals/webgl-lru.test.ts]
7. Talks only to the hub; all data travels over one authenticated WebSocket. [review]
