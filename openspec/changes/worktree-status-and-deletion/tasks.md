## 1. Architecture

- [x] 1.1 Daemon principle 3 names `removeWorktree` among the ways a PTY ends, enforced also by `test/process/daemon-worktrees.test.ts`; verify `la-arch-check` and the architecture tests pass

## 2. Protocol

- [x] 2.1 `removeWorktree{req, worktree, force}` and `worktreeAtRisk{req, worktree, base, ahead, changes, running}`; `DAEMON_PROTOCOL_VERSION` 6, `BROWSER_PROTOCOL_VERSION` 7; samples, correlation and rejection tests, envelope test; re-bless `wire.golden.json`; version expectations in unit and process tests

## 3. Daemon

- [x] 3.1 `daemon.worktrees`: `worktreeRisks` (base ref fetched first, commits ahead, changes) and `removeWorktree` (remove, force, prune) with real-git unit tests (no origin, origin/HEAD, fallback, merged, merged since the last fetch, remote unreachable, ignored files, gone directory, branch kept)
- [x] 3.2 `daemon.server`: `removeWorktree` per design D1–D3; process tests: clean removal closing exited terminals, every risk reported, no origin, forced removal closing running terminals, main/locked/unknown refused; unit tests: a terminal starting during a removal is awaited and reported, `createTerm` during a removal is refused

## 4. Web

- [x] 4.1 `terminalStatus`, `worktreeTitle`, `removalReasons` with unit tests; row `title` and `data-path`; e2e contract by `data-path`
- [x] 4.2 Worktree context menu, "Delete worktree" with its blockers, confirmation listing reasons; e2e: hover text follows terminals, clean worktree deleted without asking, at-risk worktree lists all reasons and is kept on cancel and deleted on confirm, detached worktree names the reflog, main worktree disabled, Escape closes the menu

## 5. Final gates

- [x] 5.1 `pnpm test` green (incl. Playwright); `pnpm lint`, `la-typecheck`, `la-arch-check` exit 0; `openspec validate worktree-status-and-deletion --strict` passes
