## Context

See proposal.md for the motivation and specs/ for the behaviour. Today `test/e2e/perf.spec.ts` checks each budget as `median(one round) ≤ X ms`, inline in each test. The page marks `wtd:switch-start` in `View.selectWorktree` and `wtd:switch-end` from a `MessageChannel` message posted in the first `requestAnimationFrame` after the switch (archived change `2026-10-06-dev-2052-…`, D13); the divider drag uses `wtd:drag-move` / `wtd:drag-paint` the same way. The `perf` project depends on `e2e` and is local-only (archived change `2026-10-18-dev-2108-…`, D3).

Measured while planning (60 Hz headless Chrome, hardware WebGL, load average 7–32): recently viewed switch samples 12.8–16.7 ms, bunched just under one frame (16.67 ms); DOM and eight-pane switches ~25–40 ms (2 frames); divider drag 2.5–11.7 ms. In one full run at load ~25, the hanging-`gh` test's DOM-switch round had a median of 71 ms (p95 137), while the standalone DOM-switch test in the same run measured 24.6 ms.

**Symptom, structural cause, grounding.** The symptom is perf failing depending on load. The structural cause has three parts: (1) latency comes in whole frames, but each budget sits on a frame boundary (16 ms < 1 frame; 50 and 100 ms are exactly 3 and 6 frames), so vsync phase and sub-frame jitter decide the verdict; (2) a single round decides each verdict, so a burst over one round fails it; (3) `--repeat-each` runs perf copies in parallel workers. The fix is one budget-verdict path that every budget goes through, instead of a hand-written check per test.

Architecture constraints that apply (see `architecture/`):
- System 8: tests live in their tier; the new helper and its tests are e2e-tier (`test/e2e`).
- System 4: strict compiler and lint config, zero findings.
- Web 4–6 are untouched: no production code changes. No model arrow, allowlist entry or arc42 edit is needed. The spec delta modifies the existing `web` capability, already mapped in the model.

## Goals / Non-Goals

**Goals:**
- `pnpm exec playwright test --project perf` passes 10 times in a row on a developer machine with ordinary background load.
- A slowdown of one frame or more on a measured path still fails its budget, proven on every perf run.

**Non-Goals:**
- Running perf in CI (`ubuntu-latest` has no GPU, so the renderer assertion fails; no GPU runner is added).
- Detecting sub-frame slowdowns: latency is quantised to frames, so they were never reliably observable.
- The `sidebar.spec.ts:255` flake: it has no timing budget and didn't reproduce (8 parallel repeats of the file at load ~32, 344/344 passed); it is tracked on DEV-2111.
- Any change to the switch/drag marks in `src/web/ui/view.ts`, or to `test:ci`.

## Decisions

- **D1. Budgets in frames, threshold (n + ½)·T.** A switch or drag budget is a whole number of frames at the page's frame interval T, and a round meets n frames when its median is at most (n + ½)·T. That is recently viewed 1 (25 ms at 60 Hz), DOM switch 3 (58 ms), eight-pane 6 (108 ms), divider drag 1 (25 ms). The half frame absorbs where the input lands within a frame; a regression of one frame or more crosses it. Alternative: keep the ms budgets and absorb noise statistically (best of N or a lower percentile). Rejected because the recently viewed budget would stay below one frame and the others on frame boundaries. (user)
- **D2. Best of up to 3 rounds, inside the test.** Each budget is measured in rounds (20 switches, 60 pointer moves, or one add plus one remove). Measuring stops at the first round that meets the budget; the budget fails only if all 3 miss. Every round's median, p95 and max, plus T and the threshold, are logged and annotated. Alternatives: Playwright `retries` on the perf project, rejected because it reruns the whole serial group and worker fixture, reports "flaky" rather than passed, and the spec would no longer state what is checked; more samples per round, rejected because a multi-second burst covers a longer round too. (user)
- **D3. Regression detection is proven permanently.** A pure test of the verdict helper on synthetic samples, plus a perf test whose init script wraps `performance.mark` so that right after `wtd:switch-start` it busy-waits 2·T, inside the app's own switch handler and after the start mark. The test runs the recently viewed rounds through the same runner and asserts that the verdict fails in all 3 rounds. Alternative: a one-off manual probe, rejected because it proves detection only on the day it was run. (user)
- **D4. The `sidebar.spec.ts:255` flake is out of scope.** It has no timing budget, so it doesn't share the cause, and it didn't reproduce. It was recorded as item 4 on DEV-2111, the existing issue for flaky tests under load. Alternative: harden its non-retrying list assertion now, rejected as a guess that could mask a real ordering bug. (user)
- **D5. `perf` runs in one worker.** `workers: 1` on the `perf` project (Playwright 1.63 `TestProject.workers`), so `--repeat-each` copies run one after another. (default)
- **D6. Frame-interval estimate.** In-page, collect at least 60 `requestAnimationFrame` gaps once per page after `openUi`; T is their lowest decile. Load only lengthens gaps (to 2T, 3T, …), so a low decile stays near T where a median could double and silently loosen every threshold. Fewer than 30 gaps, or any non-finite or non-positive gap, throws, and so does a T outside 4–34 ms (30–250 Hz). (default; malformed-input checks: codex)
- **D7. The sidebar budget stays in ms**, through the same runner. A round meets it only when both the add and the remove are reflected within 250 ms; the round's maximum is its verdict value, so one slow command can't hide behind the other. (default; max rule: codex)
- **D8. One verdict path.** A pure `test/e2e/budget.ts` holds the frame-interval estimate, the round verdicts ("n frames at T" by median, "≤ X ms" by maximum), and the best-of-N runner, which takes a round function and returns every round's statistics plus the verdict. Each perf measurement becomes a round function. Its tests are `test/e2e/budget.spec.ts`, in the e2e project with no browser fixture, so CI runs them with no config change; a vitest home would need a new include for an e2e-tier helper. A round whose durations include a non-finite value fails. (default)
- **D9. Each round restores its preconditions.** Reattach rounds first view 9 worktrees outside the 20 targets, so every target is back on DOM (the LRU holds 8). Each eight-pane round starts with the other tab holding WebGL. Each sidebar round uses a fresh branch name. The hanging-`gh` test runs the same round functions. (default)
- **D10. Timeouts hold 3 failing rounds.** Each affected test's timeout (eight-pane, divider drag, hanging `gh`, injected regression) is set from the worst-case round duration measured during implementation, so that 3 failing rounds plus setup finish before the timeout and produce a verdict. (codex)
- **D11. Codex findings rejected.**
  - "Best of 3 hides intermittent regressions; require 2 of 3": each round is a median over 20 switches. A code regression acts on switches, so one that slows more than half of them lifts every round's median; one that slows fewer is missed by a single-round median today too. Best of 3 only absorbs time-correlated bursts, and 2 of 3 would bring back failures whenever two rounds hit bursts. rejected (codex)
  - "Later rounds are warmer, so best of 3 hides cold-path regressions": every round, round 1 included, follows unscored views of the same path (recently viewed shows its 4 worktrees first, reattach 29, eight-pane both tabs), so round 1 is already warm. One-off cold costs are outside the budgets, and a median ignores them. rejected (codex)
- **D12. No CI perf run.** `ubuntu-latest` has no GPU; the done-when targets developer machines. (default)

## Risks / Trade-offs

- [A slowdown smaller than one frame is not detected] → It was never reliably observable under frame quantisation. D3 proves that one frame or more is caught.
- [Sustained heavy load across all 3 rounds still fails] → Intended: the budgets are for ordinary background load. Every round's log shows the load pattern.
- [A failing budget takes ~3× as long] → Covered by D10's timeouts; a passing run costs nothing extra.
- [Headless Chrome reports a frame interval other than the display's] → D6's range check fails loudly, and T is logged on every run.
