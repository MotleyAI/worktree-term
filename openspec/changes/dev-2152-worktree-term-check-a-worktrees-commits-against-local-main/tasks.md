## 1. Protocol

- [x] 1.1 Replace `base` with `local`, `remote`, `fetchFailed` in `worktreeAtRisk` (`src/protocol/messages.ts`), with the `ahead` ⇔ bases refinement (design D8); verify `src/protocol/messages.test.ts` covers the coupling both ways, oversized `local`/`remote`/`fetchFailed.ref`/`fetchFailed.reason`, missing `fetchFailed`, the old `base` shape rejected, and the `fetchFailed` round trip — on encode and decode
- [x] 1.2 Raise `DAEMON_PROTOCOL_VERSION` to 7 and `BROWSER_PROTOCOL_VERSION` to 11; update `test-samples.ts` (samples with and without `fetchFailed`, with a null base) and re-bless `wire.golden.json`; move the "hello from another version" sample from 7 to 8; verify `wire.golden.test.ts` and the constants test pass

## 2. Daemon

- [x] 2.1 Resolve the default branch `D`, `local` and `remote` (design D2); verify `git.test.ts` cases: `origin/HEAD` → `develop` with `main` present, `origin/HEAD` absent, `origin/HEAD` naming a missing ref, only local `master`, only `origin/main`, both `main` and `master`, no default branch
- [x] 2.2 Count commits in neither base with the `ahead` precedence of design D3; verify `git.test.ts` graph cases: commit only in local `main`, only in cached `origin/main`, in neither, a merge of two commits split between them (counts 1); headless worktree with and without a base
- [x] 2.3 Replace `fetchBase` with a typed fetch (design D4–D6) using `+refs/heads/D:refs/remotes/origin/D`, fetching only when the local count is > 0 and `origin` is listed; verify `git.test.ts`: no fetch when covered locally (remote dir removed, still 0 and no `fetchFailed`), merged since last fetch, refspec that does not map `main`, deleted remote dir → `fetchFailed` with non-empty reason, `origin` with a non-repository URL, no `origin`, timeout via an `ext::` hanging remote and an injected short timeout (D7), stderr with blank lines and control characters via an `ext::` remote, spawn-error shape handled
- [x] 2.4 `WorktreeRisks` = `{local, remote, ahead, fetchFailed, changes}`; `removeWorktreeNow` sends them unchanged and does no count or fetch with `force`; verify `src/daemon/server/daemon.test.ts` and `test/process/daemon-worktrees.test.ts` for every daemon scenario in the delta (nothing at risk, local-main-only with remote unreachable, cached `origin/main`, split commits, merged since last fetch, every risk, remote unreachable, no origin, no base, forced removal with no fetch)

## 3. Web

- [x] 3.1 One base-phrase helper (design D9) used by `removalReasons` and `keptNote` in `src/web/ui/sidebar.ts`; `view.ts` passes `{local, remote, fetchFailed}`; verify `sidebar.test.ts` for: both bases, only `local`, only `remote`, fetch failed (with and without `remote`), no base, detached note in each of those, singular/plural
- [x] 3.2 Update `test/e2e/sidebar.spec.ts` deletion tests to the new texts (clean worktree in local `main`, every reason, detached) and add a fetch-failed test (remote directory removed after the last fetch) checking the full sentence with git's reason, and that a reason containing markup renders as text; verify with Playwright

## 4. Gates

- [x] 4.1 Run `pnpm test`, `pnpm lint`, `tsc -b` and `la-arch-check`; all green
