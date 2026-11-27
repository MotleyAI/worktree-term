## Why

The `perf` Playwright project fails on a developer machine running main's code, depending on machine load: on the same machine and code, medians move by up to 2× between runs. Switch and paint latency comes in whole frames, yet every budget sits on a frame boundary (16 ms is just under one 60 Hz frame; 50 and 100 ms are exactly 3 and 6 frames), a single round of 20 samples decides each verdict so one load burst fails it, and `--repeat-each` runs perf copies in parallel. The budgets are therefore checked only by hand, and then fail for reasons unrelated to the change being tested.

## What Changes

- The switch and divider-drag budgets are stated in frames of the page's frame interval T: recently viewed switch 1 frame, switch to worktrees rendered via DOM 3 frames, switch to an 8-pane tab rendered via DOM 6 frames, divider drag 1 frame. A round meets a budget of n frames when its median is at most (n + ½)·T.
- Each budget, the 250 ms sidebar budget included, holds when at least one of up to 3 rounds, measured in turn, meets it. A sidebar round meets its budget only when both the add and the remove are reflected within 250 ms.
- A slowdown of more than one frame inside the measured window of every recently viewed switch makes all 3 rounds miss the budget; a permanent perf test proves it.
- The `perf` project runs in one worker.
- `test:ci` is unchanged: perf stays local-only, since CI runners have no GPU.

## Capabilities

### New Capabilities

### Modified Capabilities
- `web`: the "Performance budgets" requirement states its switch and drag budgets in frames, judges each budget by the best of up to 3 rounds, and adds a scenario that a one-frame regression still fails.

## Impact

- `playwright.config.ts`: the `perf` project gets `workers: 1`.
- `test/e2e/perf.spec.ts`: every budget measured in rounds through one verdict path; a new injected-slowdown test.
- New `test/e2e/budget.ts` (pure verdict helper) and `test/e2e/budget.spec.ts` (its tests, in the e2e project, so CI runs them).
- No production code, protocol, model or arc42 change.
