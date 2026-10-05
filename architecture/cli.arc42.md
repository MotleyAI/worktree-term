# CLI

## Purpose & context

The `wtd` entry point: parses argv and dispatches to daemon, hub, bridge and installer commands. Leaf node.

## Building blocks

Leaf; see view `system`.

## Principles

1. Holds no domain logic; each command delegates to one entry point. [review]
2. A user error prints one line to stderr and exits non-zero, without a stack trace. [review]
