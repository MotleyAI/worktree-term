# Protocol

## Purpose & context

The wire contract between web, hub and daemons: message schemas, frame codecs, and one version per link: `DAEMON_PROTOCOL_VERSION` (client ↔ daemon) and `BROWSER_PROTOCOL_VERSION` (browser ↔ hub). Leaf node, used by all others.

## Building blocks

Leaf; see view `system`.

## Principles

1. Pure: no I/O, no Node or DOM APIs; imports only `zod`. [enforced: test:test/architecture/dependencies.test.ts]
2. Every wire type is a schema; static types are inferred from it, never written separately. [review]
3. Decoders reject malformed or unknown input; they never coerce or repair. [enforced: test:src/protocol/messages.test.ts]
4. A wire change bumps the version of the link it touches, both for a shared constant; `hello`, `shutdown` and the frame header never change. [enforced: test:src/protocol/wire.golden.test.ts]

## Rationale

One contract shared by browser and Node code removes hand-kept agreement between ends. Frozen `hello` and `shutdown` let any hub detect, and restart, a daemon of any other version. The hub serves the page it talks to, so the browser link can change without a daemon restart; a separate version keeps such changes from marking daemons outdated.
