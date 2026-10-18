## Why

A CI run takes 6.5–9 min: one job on a 4-CPU runner runs lint, vitest and Playwright in sequence. Profiling (runs 39123723382, 38746061575) shows three causes beyond the serial layout: `pnpm lint` repeats exactly what `test/architecture/static.test.ts` runs (`tsc -b` + eslint, ~40 s); vitest's 148 s wall is bounded by four huge, timer-bound process-test files (`hub-router` 99 s, `daemon-terminals` 81 s, `hub-server` 58 s, `daemon-server` 28 s) whose tests run sequentially; and Playwright runs only 2 workers on CI. Main is also intermittently red from an `install-local` test that misses output printed before it attaches.

## What Changes

- Split `.github/workflows/ci.yml` into parallel jobs: `architecture` (the architecture vitest project, which includes tsc + eslint and replaces the `pnpm lint` step), `vitest` × 2 shards (unit + process), `e2e` × 2 shards (Playwright `--shard`).
- Move the shared setup into a composite action `.github/actions/setup`, with the living-architecture tools behind an input so only the `architecture` job installs them.
- Run Playwright with every CPU (capped at 8) on CI; local runs keep half the CPUs.
- Split the four big process-test files into smaller files (pure moves, no test renamed, rewritten or dropped) so vitest shards balance and no file bounds the critical path.
- Fix the `install-local` reinstall flake in the test: gate its command until attach completes.
- `pnpm test`, `test:ci`, `test:vitest` and `lint` stay unchanged and keep working locally.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None — CI layout and test organisation only; no specified behaviour changes (`skip_specs: true`).

## Impact

- `.github/workflows/ci.yml`, new `.github/actions/setup/action.yml`.
- `playwright.config.ts` (CI worker count).
- `test/process/{hub-router,daemon-terminals,hub-server,daemon-server}.test.ts` split into `test/process/<old>-<area>.test.ts`; shared helpers into `test/support/`.
- `test/process/install-local.test.ts` (reinstall test).
- Possibly a vitest sequencer file if shard imbalance requires it (design D4).
- README, if it describes the single CI job.
