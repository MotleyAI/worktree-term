## Context

See proposal.md for motivation. In `src/daemon/server/daemon.ts`, "ending a terminal" is written out three times by hand: `closeTerm` (registry removal, layout prune and write, `termClosed`, state prune), `removeWorktree` (registry removal, `termClosed`, state prune — no layout prune) and `shutdown` (registry removal only, via `closeTerminal`). `TerminalProcess` (`src/daemon/terminals/terminal.ts`) reports an exit through one `exited(code, signal)` event after the mirror has parsed every output byte, and sets `unseen` on any exit while hidden.

Architecture principles that apply: daemon 1 (only `server` composes `terminals` and `state`), 3 (a PTY ends only by `closeTerm`, `removeWorktree`, process exit or `shutdown` — a clean exit is a process exit, so no arc42 edit), 4 and 5 (output is never dropped; the last byte precedes the end event); web 3 and 4 (the terminal object is disposed only when its terminal closes); protocol 4 (version bumps); system 6 (errors are reported) and 8 (tests in every tier). No model, import arrow or `index.yaml` change.

## Goals / Non-Goals

**Goals:**
- One daemon code path ends a terminal, whatever the cause; the clean exit is its fourth caller, not a fourth copy.
- After this change a daemon never keeps a cleanly exited terminal, and the web relies on that.

**Non-Goals:**
- Telling the user that a hidden terminal exited cleanly (it simply disappears).
- Any change to the red worktree-deletion dialog border.

## Decisions

### D1 — One `retire` path in `daemon/server`
`retire(terms)` takes a set of terminals: removes them from the registry, ends each process (`TerminalProcess.close()`, which only disposes the mirror once reaped), then, once per affected worktree, prunes the layout against the live registry, persists it and broadcasts `layoutChanged` if it changed, then broadcasts `termClosed` for each terminal and prunes the repo's state. A failed layout write is reported via `options.report` and `termClosed` still follows; the caller learns of the failure (so `closeTerm` can still answer `internal`). `closeTerm` retires one terminal, `removeWorktree` retires the worktree's terminals in one call (one layout write, emptying the layout — Codex suggested skipping the layout for removal; rejected, since the write only empties a layout the state prune drops anyway, and a skip mode would reintroduce two paths), and the clean exit retires one. `shutdown` keeps only the process-ending part, since it ends every connection.
- Alternative: a fourth hand-written copy for the clean exit — rejected (the bug class this structure invites is the copies drifting, as `removeWorktree` already has on the layout).

### D2 — Clean vs failed is decided in the daemon, `unseen` in the terminal
`TerminalProcess` keeps its single `exited(code, signal)` event; `createTerm`'s handler retires the terminal when `code === 0 && signal === null` and broadcasts `termExited` otherwise. `TerminalProcess.onExit` sets `unseen` only for a failed exit. Output before a clean exit still sets `unseen` as any output does (Codex finding; the spec scenario is narrowed to "without further output" rather than buffering activity until the exit status is known).

### D3 — No exit before registration
`exited` cannot fire before `createTerm` assigns the id and registers the entry: `TerminalProcess.spawn` builds the PTY and the object synchronously after its last await, the continuation in `createTerm` runs as a microtask before any PTY event, and `exited` is further deferred behind a mirror write callback. (Codex raised this; rejected as impossible, recorded here because `retire` relies on it.)

### D4 — `DAEMON_PROTOCOL_VERSION` 6 → 7, no schema tightening
No message shape changes, but hub and web now rely on "an exited terminal is a failed one"; raising the version makes a daemon still running old code `outdated`, so the existing restart flow offers the switch instead of the feature silently not applying. The wire golden is re-blessed at 7 (a bump with unchanged schemas is legal). `termExited` and the terminal `exit` schema are NOT tightened to reject `{code: 0, signal: null}`: a decoder rejection closes the whole daemon link, a far worse failure than a mislabelled mark; the invariant is held by D1/D2. `BROWSER_PROTOCOL_VERSION` stays 10: the hub serves the web build it talks to.

### D5 — Web: one exited mark
`MARK_ORDER` becomes `input, failed, done, output`; `markOf` maps any non-null `exit` to `failed`; the status text is "killed by <signal>" or "exited with code N"; `.mark-exited` and the e2e contract's `exited` mark go. The "(exited)" tab and pane-header label stays.

### D6 — Choices take the focus only when it was left on the body
When the selected worktree's last terminal closes, the disposed xterm (self-close) or the removed close dialog (confirmed close) leaves `document.activeElement` on the body. The choices list focuses its first option on mount only if the terminal set just went from non-empty to empty for the shown worktree and the active element is the body (or null). First entry is unaffected (selecting a worktree leaves the focus on its row) and focus the user put elsewhere (sidebar search) is never taken. Implementation must make the check after the xterm container left the document (the manager disposes it on `termClosed`) — a check before that would see the dying textarea.
- Alternative: "the closed terminal's pane held the focus" — not evaluable once the pane is gone, and false after a confirmed close where the dialog held it (Codex finding).

## Risks / Trade-offs

- [A one-shot command preset that succeeds disappears with its output] → Accepted (user decision): presets are interactive programs; a failing command still stays readable.
- [Upgrading `wtd` marks every running daemon `outdated`; restarting ends its terminals] → The existing restart dialog names the terminals and needs confirmation.
- [Disposal and focus ordering in the page is timing-sensitive] → e2e scenarios for self-close, confirmed close and focus held elsewhere.

## Migration Plan

Ship as one release. Old daemons show as `outdated` until restarted from the page; rollback is reverting the change (an older hub then sees version-7 daemons as `outdated` and restarts them the same way).
