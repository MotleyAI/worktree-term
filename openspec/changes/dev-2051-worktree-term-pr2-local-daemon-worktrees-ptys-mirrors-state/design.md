## Context

PR 2 of 5 for DEV-1989 (see proposal.md). PR 1's design (archived change `2026-10-05-dev-1989-…`, D1–D8) is binding, especially D6 (peer semantics) and D7 (per-element import allowlist). `architecture/` is normative: daemon principle 1 (`worktrees`, `terminals`, `state` never import each other; `server` and `main` compose them), platform principle 2 (only `dialer` connects to or spawns a daemon), system principles 3, 5, 6. Built-in allowlist per element: `platform.files` fs · `platform.dialer` net, child_process · `daemon.worktrees` fs, child_process · `daemon.terminals` the PTY and xterm packages, fs · `daemon.state` zod · `daemon.server` net · `cli` child_process. `process`, `os`, `crypto`, `events`, `timers` are free.

## Goals / Non-Goals

**Goals:**
- A daemon that satisfies the `daemon` spec with every [review] principle that is testable turned into an enforced test.
- One code path per invariant: one output sequencer per terminal, one flow-control model, one layout-prune function, one re-list-and-diff path.

**Non-Goals:**
- Hub, browser, presets catalogue (the hub owns it; `preset` is an untrusted display label here), remote install, `loginctl` linger, systemd unit.
- Symlink-hardening inside the state directory: both directories are verified 0700 and owner-only, so only the same uid can place objects there.

## Decisions

### D1 Protocol v2
`termCreated.req` becomes nullable so creation reaches every watcher by the same event path as `termExited`/`termClosed`; `not-a-repo` names a user error that had no code. `PROTOCOL_VERSION` 2, `wire.golden.json` re-blessed; `hello`, `shutdown` and the frame header are untouched (`frozen.golden.json`). `protocol/index.ts` also exports the layout schema and the inferred `Layout`, `Worktree`, `Terminal` types (no wire change). Alternative — resend `repoState` to other watchers — rejected: a second path for one event.

### D2 Socket under `$XDG_STATE_HOME`
`$XDG_RUNTIME_DIR` is a tmpfs that logind removes when a user's last session ends; on a remote host an SSH drop would delete a live daemon's socket and the next `wtd connect` would start a second daemon, orphaning every terminal. `run/<host>.sock` in the state directory survives, needs no linger or root, and `<host>` separates hosts sharing an NFS home. Alternatives: runtime dir + `loginctl enable-linger` (needs polkit over SSH, fragile); re-bind on loss (needs polling).

### D3 Start lock and binding (`platform.files` lock, `daemon.server` bind)
Lock file created with `wx` holding `{pid, nonce}`; stale only when `pid` is not alive (`process.kill(pid, 0)` → ESRCH), never by age, so a slow but live starter is never displaced. The starter holds the lock until the socket is bound and chmodded 0600; only the holder probes and unlinks a stale socket. Release checks the nonce. On exit the daemon unlinks the socket only if its inode matches the one it bound. Alternative — age-based staleness — rejected (Codex review): a delayed live starter could lose its lock and two daemons would unlink each other's sockets.

### D4 Dialer
`dial({spawn})` lives in `platform.dialer`; the CLI passes `[process.execPath, <script>, 'daemon']`, so `platform` stays ignorant of the CLI. Spawn uses `detached: true` (new session), stdin ignored, stdout/stderr to an fd from `platform.files`' owner-only append-open of `daemon.log` (rotated once over 1 MiB), then `unref()`. Connect retries every 50 ms for 5 s; concurrent dials each spawn, the start lock lets one win, the others print "already running" into the log and exit 1 while their dialers connect to the winner. `wtd connect` is a byte pipe: it never parses frames, so it needs no protocol knowledge and a version-mismatched daemon is handled by the hub.

### D5 Terminal output sequencer and the snapshot cut (`daemon.terminals`)
Each terminal has one sequencer that owns, in a single synchronous step per PTY chunk: assigning the offset, `mirror.write(chunk, onParsed)`, and fanning the chunk out to attached consumers. `attach` runs inside the same owner: it takes S = produced, registers the consumer with cursor S and a pending-output queue, and enqueues `mirror.write('', barrier)`. xterm's `WriteBuffer` parses queued chunks in order and invokes each chunk's callback synchronously after parsing it and before parsing the next, so inside `barrier` the mirror reflects exactly bytes < S; `serialize({scrollback: 5000})` (modes included) runs there, synchronously. Then: snapshot frame (offset S) → `done` → the queued output from S. Snapshots over `MAX_FRAME` minus the header halve their scrollback until they fit. This ordering is an implementation property of the pinned `@xterm/headless`, not a documented API, so task 1 verifies it in the pinned source and a process test forces attaches between queued writes; a version bump of the package must re-run that test.

### D6 Flow control as a pure model
A pure `FlowControl` per terminal (no I/O, injected clock) holds per-consumer `sent`/`acked` and the mirror's `produced − parsed`, and decides pause, resume and eviction (spec "Output flow control"). Mirror backpressure is a deliberate refinement of PR 1's D6 sentence "with no attached connection a PTY never pauses": its intent — no client can stall an unwatched PTY — holds, while unbounded mirror backlog (an OOM that would kill every terminal on the host) is ruled out. The mirror is never evicted. "Sent" means handed to the connection's outbound queue (D7), which is itself bounded.

### D7 Connection outbound queue
Each connection serialises its writes and counts queued-but-unwritten bytes (`socket.write` return value / `drain`). Over 64 MiB the connection is closed; a snapshot is not produced while more than `FLOW_HIGH` is queued (the attach waits for `drain`). Output frames are already bounded per terminal by `FLOW_HIGH`; this bound covers snapshots and control traffic for a client that stops reading entirely.

### D8 Terminal lifecycle
States: running → exited (process reaped) → drained (PTY stream ended, sequencer flushed) → reported (`termExited` sent); `closeTerm` moves any state to closing, which keeps the PTY handle and the SIGKILL timer until the process is reaped, then disposes. The `forkpty` child calls `setsid`, so its pid is its process-group id; `closeTerm` signals `-pid`. The SIGKILL timer is cancelled on reap, so a reused pid is never signalled. The pinned package destroys its PTY read stream 200 ms after the child exits, which would drop unread output while the PTY is paused; `daemon.terminals` defers that destroy until reading has resumed, then allows 200 ms of reading before it.

### D9 Input bound
The package's `write` blocks the event loop once the PTY's input buffer is full (task 1.2 probe), so input bypasses it: `daemon.terminals` writes to the PTY master fd (non-blocking) with `fs.write`, in order, retrying after 10 ms on `EAGAIN`. Unaccepted bytes per terminal are counted exactly; above 1 MiB a frame is discarded with `error{req: null, busy}`. Pausing the socket instead was rejected (Codex review): the socket also carries acks, and a program blocked on paused output never reads its input, so pausing reads deadlocks.

### D10 Worktree watching (`daemon.worktrees`)
Porcelain `-z` parser as a pure function. Watch set: `<common>` (filter `HEAD`, `packed-refs`, `worktrees`), `<common>/worktrees/`, each `<common>/worktrees/<name>/`, `<common>/refs/heads` with `{recursive: true}` (supported on Linux in Node ≥ 20; verified on 22 for newly created nested directories), each linked worktree's `.git` file. Watching directories rather than files survives git's lock-file-and-rename writes. Any event → 100 ms debounce → reconcile watchers (keep valid handles, add new ones) **before** the authoritative re-list → diff → emit if changed. A watcher `error` or the loss of a watched directory rebuilds from `<common>`. Failure of the whole repo watch ends its subscriptions (spec) so no client holds a silently stale list. One watcher per repo, shared and reference-counted by connections. Discovery is a pure-ish walk in the same element (it needs `fs`).

### D11 State (`daemon.state`)
`state.json` = `{version: 1, repos: [{repo, worktrees: [{path, checked, layout}]}]}`, a zod strict schema reusing the protocol layout schema. One pure `pruneLayout(layout, live)` serves `closeTerm` and start-up (start = no live terminals). Mutations carry a generation; writes are serialised and coalesced, and a request resolves only after a successful atomic write containing its generation; a failed write rolls back the in-memory change. `state` knows nothing of terminals or worktrees: `server` passes in listed paths and live terminal ids.

### D12 Composition (`daemon.server`, `daemon.main`)
`server` owns connections, the handshake state machine (pure, unit-tested), the repo↔watcher registry, terminal ↔ repo association, visibility counts and request dispatch; it composes `worktrees`, `terminals` and `state` (daemon principle 1). `main` reads paths from `platform.files`, loads state, binds, installs signal handlers and resolves an exit code. The CLI calls `main` with the package version and paths; `hub.*` placeholders switch to real `platform.files` exports so every model arrow remains a runtime import.

## Risks / Trade-offs

- [Snapshot cut depends on xterm `WriteBuffer` internals] → pinned exact version, source verified in task 1, process test that forces interleaving.
- [Mirror backpressure throttles an unwatched flood to parse speed] → parse speed is many MB/s; accepted for bounded memory.
- [Input over 1 MiB unread is discarded] → only when a program has not read 1 MiB of input; the client gets `busy`.
- [Watch failure ends subscriptions] → explicit `internal` error; the hub re-watches (DEV-2052).
- [inotify watch count: ~2 per worktree + ref dirs] → far below default limits; failure is reported, not hidden.
- [Process tests with real PTYs and git are timing-sensitive] → assert the 250 ms budget (the issue's end-to-end budget), log measured latency, wait for states not fixed sleeps; the 100 ms debounce is pinned by a unit test.
- [Stale socket file after reboot] → probe gets ECONNREFUSED and the lock holder replaces it.
