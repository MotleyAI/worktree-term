## 1. Tests first (pr-tests)

- [x] 1.1 `test/e2e/budget.spec.ts` (e2e project, no browser fixture): pure tests of the verdict helper's intended API (design D6–D8). Cases:
  - phase jitter just under one frame meets 1 frame;
  - one-frame regression in every round fails all 3 rounds;
  - burst in round 1, then a passing round 2 → holds, and round 3 is not run;
  - all 3 rounds bursting fails;
  - frame-interval estimate stays near T with many doubled or tripled gaps;
  - fewer than 30 gaps, an empty set, `NaN`, an infinite or a non-positive gap each throw;
  - T outside 4–34 ms throws;
  - a round with a non-finite duration fails;
  - ms verdict by maximum: add 120 / remove 300 misses 250, 120 / 240 meets it.

  Verify they fail (the helper does not exist yet).
- [x] 1.2 `test/e2e/perf.spec.ts`: rewrite every budget test against the spec delta, with frame budgets via the best-of-3 runner and per-round preconditions (design D9):
  - titles state the frame budgets;
  - the sidebar round needs both commands within 250 ms;
  - the hanging-`gh` test uses the same round functions;
  - add the injected-slowdown test (design D3: wrap `performance.mark`, busy-wait 2·T right after `wtd:switch-start`, assert all 3 recently viewed rounds miss the budget).

  Verify they fail or don't compile until `budget.ts` exists.
- [x] 1.3 Codex review of the tests against the spec delta and design

## 2. Verdict helper

- [x] 2.1 `test/e2e/budget.ts`: frame-interval estimate (lowest decile, ≥ 30 finite positive gaps, 4–34 ms), round verdicts ("n frames at T" by median against (n + ½)·T; "≤ X ms" by maximum), best-of-N runner (stop at first pass, return every round's median/p95/max and the verdict), reporting of every round with T and threshold; verify 1.1 passes

## 3. Perf project

- [x] 3.1 `playwright.config.ts`: `workers: 1` on the `perf` project and its comment updated (timed after `e2e`, in one worker); verify `--project perf --no-deps --repeat-each 2` runs its copies one after another
- [x] 3.2 `test/e2e/perf.spec.ts`: in-page frame-interval measurement once per page after `openUi` (≥ 60 `requestAnimationFrame` gaps), logged; each measurement becomes a round function through the runner; verify `pnpm exec playwright test --project perf --no-deps` passes, the injected-slowdown test included
- [x] 3.3 Timeouts (design D10): measure the worst-case round duration of each budget and set the eight-pane, divider-drag, hanging-`gh` and injected-slowdown tests' timeouts so 3 failing rounds plus setup finish; verify by forcing all rounds to fail once (e.g. a temporarily tightened threshold) and confirming a budget verdict, not a timeout, is reported; revert the temporary change

## 4. Done-when verification

- [ ] 4.1 Run `pnpm exec playwright test --project perf` (e2e first) 10 times in a row on the developer machine under ordinary background load; record each run's result and load average here; all 10 pass
- [ ] 4.2 Confirm the injected-slowdown test failed its budget in all 3 rounds in every one of those 10 runs (from the logged round medians)
