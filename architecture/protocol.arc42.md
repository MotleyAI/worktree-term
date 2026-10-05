# Protocol

## Purpose & context

The wire contract between web, hub and daemons: message schemas, frame codecs, `PROTOCOL_VERSION`. Leaf node, used by all others.

## Building blocks

Leaf; see view `system`.

## Principles

1. Pure: no I/O, no Node or DOM APIs; imports only `zod`. [enforced: test:test/architecture/dependencies.test.ts]
2. Every wire type is a schema; static types are inferred from it, never written separately. [review]
3. Decoders reject malformed or unknown input; they never coerce or repair. [enforced: test:src/protocol/messages.test.ts]
4. Any wire change bumps `PROTOCOL_VERSION`; `hello`, `shutdown` and the frame header never change. [enforced: test:src/protocol/wire.golden.test.ts]

## Rationale

One contract shared by browser and Node code removes hand-kept agreement between ends. Frozen `hello` and `shutdown` let any hub detect, and restart, a daemon of any other version.
