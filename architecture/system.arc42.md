# worktree-term

## Purpose & context

Worktree-centric terminal manager for coding agents. A daemon per host owns PTYs and git watches; a local hub serves the browser UI and reaches every daemon over the protocol (unix socket locally, `ssh <host> wtd connect` remotely).

## Building blocks

View `system`.

<!-- likec4:system -->
```mermaid
flowchart TD
  %% system: worktree-term
  protocol["Protocol"]
  subgraph platform["Platform"]
    platform__files["Files"]
    platform__dialer["Dialer"]
  end
  subgraph daemon["Daemon"]
    daemon__worktrees["Worktrees"]
    daemon__terminals["Terminals"]
    daemon__state["State"]
    daemon__server["Server"]
    daemon__main["Main"]
  end
  subgraph hub["Hub"]
    hub__server["Server"]
    hub__links["Links"]
    hub__config["Config"]
    hub__router["Router"]
    hub__main["Main"]
  end
  cli["CLI"]
  subgraph web["Web"]
    web__client["Client"]
    web__terminals["Terminals"]
    web__layout["Layout"]
    web__ui["UI"]
    web__main["Main"]
  end
  platform__dialer --> platform__files
  daemon --> protocol
  daemon --> platform__files
  daemon__main --> daemon__server
  daemon__main --> daemon__worktrees
  daemon__main --> daemon__terminals
  daemon__main --> daemon__state
  daemon__server --> daemon__worktrees
  daemon__server --> daemon__terminals
  daemon__server --> daemon__state
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
  cli --> daemon__main
  cli --> hub__main
  cli --> platform__files
  cli --> platform__dialer
  cli --> protocol
  web__client --> protocol
  web__main --> web__ui
  web__main --> web__client
  web__main --> web__terminals
  web__ui --> web__client
  web__ui --> web__terminals
  web__ui --> web__layout
  web__terminals --> web__client
  classDef leaf fill:none;
  class protocol,platform__files,platform__dialer,daemon__worktrees,daemon__terminals,daemon__state,daemon__server,daemon__main,hub__server,hub__links,hub__config,hub__router,hub__main,cli,web__client,web__terminals,web__layout,web__ui,web__main leaf;
```
<!-- /likec4:system -->

## Principles

1. An import between elements, type-only included, exists only where the model declares the arrow; `protocol` types are importable everywhere. [enforced: arch_check:model-truth] [enforced: test:test/architecture/structure.test.ts]
2. A node with nested elements has no modules of its own; each element exposes only its `index.ts`, and imports of another element target only that file. [enforced: test:test/architecture/structure.test.ts]
3. Third-party packages and I/O-capable Node built-ins are imported only where the element allowlist permits. [enforced: test:test/architecture/dependencies.test.ts]
4. Code passes the strict compiler config and the strict lint config with zero findings; suppressions state a reason. [enforced: test:test/architecture/static.test.ts]
5. Input from outside the process is schema-parsed at the boundary; unparsed data never travels inward. [review]
6. Errors are never swallowed: a catch rethrows, reports, or returns a typed failure. [review]
7. Nothing listens beyond loopback or an owner-only unix socket. [review] [enforced: test:test/process/hub-server.test.ts]
8. Every production change ships with tests in its tier: unit beside the code, `test/process`, `test/e2e`; `test/integration` holds only opt-in real-SSH tests. Mocks are typed against the real module. [review]

## Rationale

The hub is a separate process from every daemon so terminals outlive the UI and local and remote hosts share one code path. The allowlist and `index.ts` rules keep each element's I/O surface and public surface explicit and reviewable.
