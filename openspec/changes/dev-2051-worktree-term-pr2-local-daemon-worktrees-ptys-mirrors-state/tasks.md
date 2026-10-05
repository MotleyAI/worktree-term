## 1. Dependencies and feasibility gate (STOP and flag on any failure)

- [x] 1.1 Add exact pins `@homebridge/node-pty-prebuilt-multiarch@0.14.1`, `@xterm/headless@6.0.0`, `@xterm/addon-serialize@0.14.0`; add the PTY package to `pnpm-workspace.yaml` `allowBuilds`; verify `pnpm install` from clean succeeds and `pnpm ls` shows them
- [x] 1.2 Probe and record the outcome in a handoff comment on DEV-2051: serialize addon loads with headless 6 and serializes modes + scrollback; headless `write` accepts `Uint8Array`; in the pinned `WriteBuffer` source a chunk's callback runs synchronously after parsing it and before the next chunk, and `serialize()` inside that callback is safe; PTY prebuild loads on Node 22 and from the esbuild bundle (`dist/wtd.mjs`, package external); `encoding: null` yields `Buffer` output; output after the exit event is delivered until the stream ends; the child is a session leader (pgid = pid); the PTY write path exposes write completion or a measurable unaccepted-byte count (design D9)

## 2. Tests (pr-tests stage; all fail before implementation)

- [x] 2.1 Protocol v2 unit tests: `PROTOCOL_VERSION` 2, `termCreated` with `req` null, `not-a-repo` code; `wire.golden.json` expectations for version 2; CLI `--version` shows `(protocol 2)`; verify they fail on the current tree
- [x] 2.2 `src/platform/files/files.test.ts`: every `platform` spec scenario for paths, owner-only modes, atomic writes (typed `fs` mock for mid-write failure), start lock (stale pid, live holder); verify they fail
- [x] 2.3 `src/daemon/state/layout.test.ts` (prune: split collapse, empty tab removal, `active` rules) and `src/daemon/state/store.test.ts` (load missing/corrupt, defaults not stored, start-time leaf discard, pruning rules, generation-based durability with delayed and failed overlapping writes, rollback); verify they fail
- [x] 2.4 `src/daemon/worktrees/porcelain.test.ts` (detached, locked with reason, prunable, bare, unborn, paths with spaces and newlines, unknown attributes, branch prefix) and `src/daemon/worktrees/discover.test.ts` (depth, `.git` file excluded, bare included, symlink/hidden/`node_modules` skipped, missing root, deterministic cap with shuffled creation); verify they fail
- [x] 2.5 `src/daemon/terminals/flow.test.ts`: watermarks, hysteresis, mirror backpressure, no client pause with zero consumers, eviction after `LAG_EVICT_MS` with an injected clock, mirror never evicted, snapshot bytes uncounted; verify they fail
- [x] 2.6 `src/daemon/server/connection.test.ts`: handshake state machine (message before hello, mismatched mode accepts only frozen `shutdown`, second hello, client output frame), ack rules; verify they fail
- [x] 2.7 `test/support/daemon-client.ts`: framed test client over a socket or a child's stdio, with a headless terminal per attached terminal for screen comparison; process tests run `dist/wtd.mjs` with a temporary `XDG_STATE_HOME` and real temporary git repos
- [x] 2.8 `test/process/daemon-server.test.ts`: socket 0600 / `run/` 0700, daemon hello, bad first message, mismatched client, malformed traffic closes only that connection, multiple clients, second `wtd daemon` refused, delayed starter (SIGSTOP) not displaced, stale socket replaced, client that stops reading stays bounded, `shutdown`/`SIGTERM` remove the socket and exit 0; verify they fail
- [x] 2.9 `test/process/daemon-worktrees.test.ts`: watch/unwatch, `not-a-repo` (plain dir, linked worktree path), events within 250 ms with measured latency logged for add, remove, branch switch, commit (incl. branch `feature/x` and packed refs), lock/unlock, deleted worktree dir; no event on file edit; watch failure ends subscriptions; >1024 worktrees fails `internal`; `discoverRepos`; verify they fail
- [x] 2.10 `test/process/daemon-terminals.test.ts`: every `daemon` scenario for terminal creation, access, lifetime (incl. final burst before `termExited`, grandchild killed on close), attach and snapshot (screen equality incl. alt screen, wide chars, >5000 lines; numbered output without gap or duplicate under forced interleaving), flow control (slow client evicted, acking client complete; flood with nobody attached), input (echo, overflow `busy` while acks still processed), resize, activity, checked and layouts, persistence across restart and pruning; verify they fail
- [x] 2.11 `test/process/connect.test.ts`: auto-start over a pipe, relayed frames, socket close ends the bridge, next connect gets a new `instance`, concurrent connects share one daemon, start failure message; update `src/cli/run.test.ts` and `test/process/cli.test.ts` for implemented `daemon`/`connect`; verify they fail

## 3. Protocol v2

- [ ] 3.1 `PROTOCOL_VERSION` 2, nullable `termCreated.req`, `not-a-repo` error code, exports of the layout schema and `Layout`/`Worktree`/`Terminal` types; re-bless `wire.golden.json` (`frozen.golden.json` unchanged); verify 2.1 and the existing protocol tests pass

## 4. Platform

- [ ] 4.1 `platform.files`: paths, private dirs, atomic write, read, owner-only log append-open, start lock (design D3); verify 2.2 passes
- [ ] 4.2 `platform.dialer`: connect, detached spawn with log, retry window (design D4); verify the dialer parts of 2.11 pass

## 5. Daemon elements

- [ ] 5.1 `daemon.state`: `pruneLayout`, store with generations, coalesced durable writes, rollback, pruning (design D11); verify 2.3 passes
- [ ] 5.2 `daemon.worktrees`: porcelain parser, listing, repo identity, watcher with reconcile-before-relist and failure reporting, discovery (design D10); verify 2.4 passes
- [ ] 5.3 `daemon.terminals`: `FlowControl`; verify 2.5 passes
- [ ] 5.4 `daemon.terminals`: PTY spawn, output sequencer, mirror, snapshot cut, lifecycle states, input bound, activity flags (design D5, D8, D9)
- [ ] 5.5 `daemon.server`: bind under the start lock, handshake state machine, outbound queue bound, dispatch, repo registry, visibility, broadcasts (design D3, D7, D12); verify 2.6 and 2.8 pass
- [ ] 5.6 `daemon.main` and CLI verbs `daemon`/`connect`; rewire `hub.*` placeholders to real `platform.files` exports; verify 2.9–2.11 pass and `la-arch-check` exits 0

## 6. Architecture (edits approved during planning)

- [ ] 6.1 `architecture/daemon.arc42.md` Purpose: replace "serves the protocol on `$XDG_RUNTIME_DIR/wtd.sock`" with "serves the protocol on an owner-only unix socket in `$XDG_STATE_HOME/worktree-term/run/`"; verify `la-arch-diagrams` leaves the file otherwise unchanged
- [ ] 6.2 Once their tests are green, tag `daemon.arc42.md` principles 2 `[enforced: test:test/process/daemon-server.test.ts]`, 3 and 5 `[enforced: test:test/process/daemon-terminals.test.ts]`, 4 `[enforced: test:src/daemon/terminals/flow.test.ts] [enforced: test:test/process/daemon-terminals.test.ts]`, 7 `[enforced: test:src/daemon/state/store.test.ts]` (6 stays `[review]`), and `platform.arc42.md` principles 3 and 4 `[enforced: test:src/platform/files/files.test.ts]`; verify `la-arch-check` exits 0
- [ ] 6.3 `architecture/model/typescript.c4`: `specs ['daemon']` on `daemon`, `specs ['platform']` on `platform`; verify `la-arch-check` and `likec4 validate architecture` exit 0 (if the check needs the archived specs, land this edit with the archive in pr-review)

## 7. Final gates

- [ ] 7.1 `pnpm test` green; `la-typecheck`, `la-arch-check`, `likec4 validate architecture` exit 0; `pnpm build` succeeds; `openspec validate dev-2051-worktree-term-pr2-local-daemon-worktrees-ptys-mirrors-state --strict` passes
