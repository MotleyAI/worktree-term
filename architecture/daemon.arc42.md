# Daemon

## Purpose & context

One per host. Owns PTYs, their headless screen mirrors, worktree watches and persisted layout and checkbox state; serves the protocol on an owner-only unix socket in `$XDG_STATE_HOME/worktree-term/run/`. Lives independently of any client.

## Building blocks

View `daemon`.

<!-- likec4:daemon -->
```mermaid
flowchart TD
  %% daemon: Daemon
  protocol["Protocol"]
  subgraph platform["Platform"]
    platform__files["Files"]
  end
  subgraph daemon["Daemon"]
    daemon__worktrees["Worktrees"]
    daemon__terminals["Terminals"]
    daemon__state["State"]
    daemon__server["Server"]
    daemon__main["Main"]
  end
  cli["CLI"]
  daemon --> protocol
  daemon --> platform__files
  daemon__main --> daemon__server
  daemon__main --> daemon__worktrees
  daemon__main --> daemon__terminals
  daemon__main --> daemon__state
  daemon__server --> daemon__worktrees
  daemon__server --> daemon__terminals
  daemon__server --> daemon__state
  cli --> daemon__main
  classDef leaf fill:none;
  class protocol,platform__files,daemon__worktrees,daemon__terminals,daemon__state,daemon__server,daemon__main,cli leaf;
```
<!-- /likec4:daemon -->

## Principles

1. `worktrees`, `terminals` and `state` never import each other; only `server` and `main` compose them. [enforced: arch_check:model-truth]
2. Its only listener is its owner-only unix socket. [enforced: test:test/process/daemon-server.test.ts]
3. A PTY ends only by `closeTerm`, `removeWorktree` of its worktree, process exit or `shutdown`, never by a client leaving. [enforced: test:test/process/daemon-terminals.test.ts] [enforced: test:test/process/daemon-worktrees.test.ts]
4. PTY output is never dropped; backpressure pauses the PTY. [enforced: test:src/daemon/terminals/flow.test.ts] [enforced: test:test/process/daemon-terminals.test.ts]
5. An attach yields a snapshot and then live output with no gap and no duplicate byte. [enforced: test:test/process/daemon-terminals.test.ts]
6. Worktree changes are observed by events, never by polling. [review]
7. Persisted state references no worktree that is gone and has no terminals. [enforced: test:src/daemon/state/store.test.ts]
