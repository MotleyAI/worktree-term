## 1. Tests

- [x] 1.1 Record the baseline: run `pnpm test:vitest` and note the `Tests N passed` total; verify by writing N into this task line when done — N = 2051
- [x] 1.2 `test/process/install-local.test.ts` reinstall test: gate `echo after-reinstall` until attach completes, following the `started()` helper pattern (design D6); verify by running that test 20× in a loop (`vitest run --project process -t 'two reinstalls'`) with zero failures, and by showing it fails reliably when the gate is released before attach

## 2. Split the process-test files

- [x] 2.1 Split `test/process/hub-router.test.ts` into `hub-router-<area>.test.ts` files (design D4); shared helpers into `test/support/`; verify every moved test passes and the total from 1.1 is unchanged
- [x] 2.2 Split `test/process/daemon-terminals.test.ts` the same way (its `activity` block likely needs splitting across files); verify as 2.1
- [x] 2.3 Split `test/process/hub-server.test.ts` the same way (the 31 s code-expiry test moves unchanged); verify as 2.1
- [x] 2.4 Split `test/process/daemon-server.test.ts` the same way; verify as 2.1
- [x] 2.5 Verify no old file name remains referenced (README, comments, specs) and `pnpm lint` passes; repoint the arc42 `[enforced: test:…]` tags to the new files (design Context)

## 3. CI

- [x] 3.1 Add `.github/actions/setup/action.yml` with input `arch-tools` (design D2); verify by the workflow run in 3.3
- [x] 3.2 Rewrite `.github/workflows/ci.yml` as jobs `architecture`, `vitest` (shard 1/2, 2/2), `e2e` (shard 1/2, 2/2) per design D1/D3, keeping the hardware-WebGL comment; verify with `actionlint` if available, else by the run in 3.3
- [x] 3.3 `playwright.config.ts`: CI workers = `min(8, availableParallelism())` (design D5); verify locally that `CI=1 pnpm exec playwright test --list` and an unset `CI` both load, and on CI that each e2e shard logs 4 workers
- [x] 3.4 Update README if it describes the single CI job; verify by grep for `pnpm lint` / CI wording

## 4. Measure and final gates

- [x] 4.1 Local: unsharded `pnpm test:ci` passes, and `pnpm test` (incl. perf) passes; `openspec validate dev-2108-worktree-term-cut-ci-time-from-65-min-to-3-min-with-parallel --strict` passes
- [x] 4.2 After the PR is open: 3 consecutive full CI runs (`gh run rerun`) all green; record per-job wall times, each vitest shard's file list, and the total in the PR description
- [x] 4.3 Check targets: total ≤ ~3 min, each e2e shard ≤ the slower vitest shard, no failures; if vitest shards are imbalanced enough to miss the target, add the duration-balancing sequencer (design D4) and re-measure; if e2e flakes at 4 workers, drop to 3 (design D5)
