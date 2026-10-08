## Why

The sidebar shows a worktree's most urgent mark but not what each of its terminals is doing, and finished worktrees can only be removed from a shell. Removing one by hand is also where work gets lost: unmerged commits, uncommitted files and agents still running in it.

## What Changes

- **BREAKING** (wire): `DAEMON_PROTOCOL_VERSION` 6 and `BROWSER_PROTOCOL_VERSION` 7 — the daemon link gains `removeWorktree{req, worktree, force}` and its reply `worktreeAtRisk{req, worktree, base, ahead, changes, running}`; the browser link carries them in its `host` envelopes. A daemon of the previous release shows as `outdated`, and restarting it kills its terminals once.
- `daemon.worktrees`: what deleting a worktree would lose — commits of its head not in `origin/main` (the ref `origin/HEAD` names, else `origin/main`, else `origin/master`, fetched from its remote first; unknown without one), and uncommitted changes including untracked files — and removal (`git worktree remove`, forced after confirmation, also for a worktree whose directory is gone). The branch is always kept.
- `daemon.server`: `removeWorktree` without `force` removes at once only when nothing is at risk; otherwise it answers `worktreeAtRisk` and removes nothing. With `force` (after the user confirmed) it removes the worktree and closes all of its terminals. The main and locked worktrees are refused.
- Web: hovering a worktree shows its path and `<preset> <id>: <status>` per terminal (waiting for input, running, done, idle, exited, exited with code N, killed by SIG…); right-clicking it opens a menu with "Delete worktree"; when the daemon reports risks, an in-page confirmation lists every reason and says the branch is kept.
- CLI: `wtd --version` shows the new versions.

## Capabilities

### New Capabilities

### Modified Capabilities
- `protocol`: versions 6 and 7; `removeWorktree` and `worktreeAtRisk`; correlation; constants.
- `daemon`: handshake version; worktree removal.
- `web`: worktree hover text; deleting worktrees.
- `cli`: version line.

## Impact

- Code: `src/protocol/**`, `src/daemon/worktrees/git.ts`, `src/daemon/server/daemon.ts`, `src/daemon/main/index.ts`, `src/web/client/**`, `src/web/ui/**`, `src/web/main/styles.css`.
- Architecture: no element or arrow changes; daemon principle 3 now names `removeWorktree` among the ways a PTY ends, enforced also by `test/process/daemon-worktrees.test.ts`.
- Wire: `wire.golden.json` re-blessed for `{daemon: 6, browser: 7}`.
- Upgrade: the running daemon must be restarted ("Restart daemon" on the page), killing its terminals once.
- Tests: unit (`daemon/worktrees/git.test.ts` with real git, protocol, status and reason texts), `test/process/daemon-worktrees.test.ts`, `test/e2e/sidebar.spec.ts`; the e2e contract now finds worktree rows by `data-path`, since their `title` carries the status.
- Depends on the change `sidebar-presets-browser-protocol`, whose requirement text the MODIFIED requirements here build on; archive that one first.
