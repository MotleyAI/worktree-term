## Context

Baseline (green run 39123723382): setup ~15–25 s, `pnpm lint` 36 s, vitest 148 s, Playwright 3.5 min at 2 workers (156 tests). Vitest file wall times: `hub-router` 99 s, `daemon-terminals` 81 s, `hub-server` 58 s (31 s of it one test sleeping past the 30 s code TTL), `static` 40 s (eslint), `daemon-server` 28 s; everything else ≤ 15 s. Process tests mostly wait on real timers. `main` has no branch protection, so job names are free to change. Architecture: system principle 4 names `test/architecture/static.test.ts` as its enforcement; principle 8 keeps split tests in `test/process` and shared helpers in `test/support`. No node principle is touched and no `index.yaml` change is needed.

## Goals / Non-Goals

**Goals:** total CI wall ≤ ~3 min (expected ~2); each e2e shard no slower than the slower vitest shard; zero failures over 3 consecutive full runs; local scripts unchanged.

**Non-Goals:** cancelling superseded runs (concurrency groups); sharing `dist` across jobs; speeding up individual timer-bound tests (the 31 s code-expiry test stays — `src/hub/server/codes.test.ts` covers the logic with an injected clock, the process test covers the wiring).

## Decisions

**D1 — `architecture` job replaces lint.** CI drops the `pnpm lint` step; the `architecture` job runs `pnpm exec vitest run --project architecture`, which runs tsc, eslint, `la-arch-check`, likec4, structure and dependency rules. One definition of lint, the one principle 4 cites. Alternative rejected: a `lint` job plus excluding `static.test.ts` in CI — that leaves principle 4's enforcement unrun in CI and two lint definitions to keep in sync.

**D2 — Composite setup action.** `.github/actions/setup/action.yml`: pnpm, Node 22 with pnpm cache, git identity (`ci` / `ci@example.com`), `pnpm install --frozen-lockfile`. Boolean input `arch-tools` (default `false`) adds uv, `living-architecture==0.3.1` and the TypeScript twin at the pinned commit `15ed4263…` (existing script, moved verbatim), on `PATH`. Checkout stays in each job (`persist-credentials: false`) since a local action needs the repo checked out first.

**D3 — Job matrix.** `architecture`; `vitest` matrix `shard: [1, 2]` running `pnpm exec vitest run --project unit --project process --shard=${shard}/2`; `e2e` matrix `shard: [1, 2]` running `pnpm exec playwright test --project e2e --shard=${shard}/2`. `fail-fast: false`, `timeout-minutes: 10`, `ubuntu-latest`. Each vitest and Playwright invocation runs its project's `globalSetup` (`pnpm build`) once. Playwright with `fullyParallel: true` shards at test level, so e2e shards balance; perf stays local-only.

**D4 — Split process files; balance shards.** Split the four files along `describe` blocks, splitting an oversized block across files where needed (carrying its hooks and timeouts), into `test/process/<old>-<area>.test.ts` of ≤ ~35 s each on the CI runner. Helpers shared by several new files go to `test/support/<name>.ts`. Pure moves: total test count is unchanged (check vitest's `Tests N passed` before and after). Vitest assigns files to shards before ordering by duration, so small files alone do not guarantee balance: record each shard's files and wall time; if imbalance misses the target, add a custom `sequence.sequencer` whose `shard` step balances by recorded durations.

**D5 — Playwright workers.** With `CI` set: `min(8, availableParallelism())`; otherwise unchanged (`min(8, max(1, floor(cpus / 2)))`). The comment on the 8 cap (inotify instances) stays and says CI uses every CPU. If e2e flakes at 4 workers in the measurement runs, drop to 3 and record why here.

**D6 — Reinstall flake is a test bug.** `DaemonClient.waitOutput()` searches only output received since the latest snapshot (`applySnapshot()` clears it) — by design. The reinstall test creates its terminal with `echo after-reinstall; exec sleep 60` and attaches afterwards, so the marker can land only in the snapshot (failure trace: `working` → `done(attach)` → `idle`, no output after). Fix: gate the command until attach completes, following the existing `started()` helper pattern. `waitOutput` semantics stay; production code changes only if a deterministic regression shows snapshot content missing.

## Risks / Trade-offs

- [Four CPUs × four Playwright workers (each Chrome + hub + daemon) contend for CPU] → measure 3 runs; fall back to 3 workers (D5).
- [Split files reshuffle timing, surfacing latent races] → 3 consecutive full CI runs plus a local unsharded `pnpm test:ci`; any flake found is fixed at its cause, not retried.
- [Each job repeats setup and `pnpm build`] → ~25 s per job in parallel; accepted (dist sharing is a non-goal).
- [Lint failures appear as a failed `static.test.ts` assertion] → the assertion message carries eslint/tsc stdout + stderr.
