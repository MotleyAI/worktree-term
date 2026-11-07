## Why

"Delete worktree" checks a worktree's commits only against the repo's default branch, so a worktree branched off another branch (a stacked feature branch, a branch off `release/x`) is reported as having commits "not in main or origin/main" even after they were merged into its real base. The daemon should find the worktree's base branch and accept commits merged there.

## What Changes

- The daemon finds a worktree's **base branch**: its upstream (`branch.<b>.remote`/`merge`) when that is a branch other than its own, else the branch its reflog records it was created from, else none.
- Commits are at risk only when reachable from none of the **bases**: the base's local branch and `origin/<base>`, then the default branch's local branch and `origin/<default>`, each when it exists, without duplicates.
- With commits at risk and an `origin`, the daemon fetches `origin/<default>` (as today) and, when it already exists, `origin/<base>`, concurrently, then compares again; each failed fetch is reported.
- **BREAKING** (wire): `worktreeAtRisk` carries `bases` (a list) and `fetchFailed` (a list) instead of `local`, `remote` and a single nullable `fetchFailed`; `DAEMON_PROTOCOL_VERSION` 8 → 9 and `BROWSER_PROTOCOL_VERSION` 11 → 12.
- The confirmation names every base compared with ("not in feature-x, origin/feature-x, main or origin/main"), one fetch-failure clause per failed fetch, and "There is no base branch to check that its commits are merged." when there is none.

## Capabilities

### New Capabilities

### Modified Capabilities
- `daemon`: "Worktree removal" — base-branch discovery, comparison with base plus default branch, fetching both, list-shaped risks.
- `protocol`: "Daemon-link message catalogue" — new `worktreeAtRisk` shape; "Protocol version and frozen handshake messages" and "Shared constants" — both versions raised.
- `web`: "Deleting worktrees" — naming a list of bases and several fetch failures; new no-base sentence.

## Impact

- `src/daemon/worktrees/git.ts` (base discovery, compare/fetch over a list), `src/daemon/server/daemon.ts` (forwarding the new shape).
- `src/protocol/messages.ts`, `constants.ts`, `test-samples.ts`, `wire.golden.json` (new shape, version bumps).
- `src/web/ui/sidebar.ts`, `view.ts`, `src/web/client` (wording, typed consumers).
- Tests: `src/daemon/worktrees/git.test.ts`, `src/web/ui/sidebar.test.ts`, protocol tests and goldens, `test/process/daemon-worktrees.test.ts`, `test/support` clients, `test/e2e/sidebar.spec.ts`.
- Running daemons of version 8 are reported outdated by an upgraded hub and restarted, as for any daemon-link change.
