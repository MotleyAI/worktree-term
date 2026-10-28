## Why

Deleting a worktree whose PR was just merged warns that its commits are not in `origin/main`. The daemon does fetch before comparing, but a failed fetch is dropped silently and the count falls back to the stale remote-tracking ref, so the warning is wrong and does not say why. Local `main`, often already holding the merge, is never consulted.

## What Changes

- A worktree's commits count as safe when reachable from the local default branch or its `origin` remote-tracking ref as last fetched; only when some are in neither does the daemon fetch the default branch and count again against the fresh ref.
- A failed fetch is reported with its reason instead of being dropped; the confirmation says the commits are not in local `main` (or `origin/main` as last fetched) and that the fresh comparison failed, and why.
- **BREAKING** (wire): `worktreeAtRisk` replaces `base` with `local`, `remote` and `fetchFailed`; `DAEMON_PROTOCOL_VERSION` 7 → 8 and `BROWSER_PROTOCOL_VERSION` 10 → 11.
- The fetch targets the remote-tracking ref explicitly, and every process failure (exit, timeout, signal, spawn) is a typed failure.

## Capabilities

### New Capabilities

### Modified Capabilities
- `daemon`: "Worktree removal" — bases compared with, when to fetch, and reporting a failed fetch.
- `protocol`: "Daemon-link message catalogue" (`worktreeAtRisk` shape), "Protocol version and frozen handshake messages" and the exported constants (version bumps).
- `web`: "Deleting worktrees" — confirmation wording for the bases and a failed fetch.

## Impact

- `src/daemon/worktrees/git.ts` (`worktreeRisks`, fetch, base resolution); `src/daemon/server/daemon.ts` passes the new fields through.
- `src/protocol/messages.ts`, `constants.ts`, `test-samples.ts`, `wire.golden.json`.
- `src/web/ui/sidebar.ts` (`removalReasons`, `keptNote`), `src/web/ui/view.ts`.
- Daemons and hubs must be restarted together for the new protocol versions.
