## 1. Tests first (pr-tests)

- [ ] 1.1 `src/protocol/messages.test.ts`: `prStatus` round-trips (two entries; empty `prs`), closed value sets, `https:`-only bounded `url`, distinct non-empty `branch`, 1025 entries rejected, browser `host{m: prStatus}` round-trips (protocol delta scenarios); `constants.test.ts` expects 12 / 16; verify they fail
- [ ] 1.2 `src/daemon/prs/*.test.ts` (unit, fake runner typed against the real module): origin URL parsing for every form with and without `.git`, SSH alias resolved through `ssh -G`, unparsable → empty (D4); branch on origin incl. other remote, several merge refs, no upstream (D5); query building — one alias triple per distinct branch, body on stdin (D6); response parsing from captured fixtures — exact head, deleted branch fallback with head-repo filter, parent PR, other fork same name excluded, null `headRepository`/`parent`/`statusCheckRollup`, empty commits, open-over-recent choice, every mapping (D6, D7); outcomes — ENOENT and exit 4 → empty, timeout/exit/invalid JSON/invalid schema → kept (D12); triggers — watch start, branch-set change refreshes, head/lock/prunable change does not, interval only while watched (D9); coalescing, skip-on-tick, ≤4 concurrent FIFO, queued unwatched dropped (D10); timeouts kill children (D11); first success always sent, identical not resent (D13); failure-class logging once until success (D14); `close()` kills children and suppresses callbacks (D15); verify they fail
- [ ] 1.3 `test/support/`: a fake `gh` (and fake `ssh`) script helper that logs each call, answers from a scripted response file, can exit with a code or hang; `test/process/daemon-prs.test.ts`: every daemon delta scenario — open PR status, one request for 58 worktrees, second connection served from memory before `done` without a call, branch change refreshes, commit does not, change within one interval (`WTD_PR_INTERVAL_MS`), no change no event, unwatch stops calls, missing gh / exit 4 → empty `prStatus` and no `error`, origin removed → empty, failure keeps status for a later watcher, hanging gh delays neither `repoState`/`done` nor `worktreesChanged` (250 ms) and is killed after 20 s, ≤4 concurrent over 10 repos; `test/process/daemon-server-startup.test.ts` (or the existing shutdown test): shutdown ends a hanging `gh` and exits 0 without waiting for the timeout; verify they fail
- [ ] 1.4 `src/web/client/store.test.ts`: `prStatus` stored per (host, repo), reset by `repoState`, dropped with the repo and with the host, ignored for an unknown repo (D19); `src/web/ui/*.test.ts`: hover-line builder for every state/checks/conflicts/review combination, glyph and badge choice per status, lookup by branch (none for detached and gone rows); verify they fail
- [ ] 1.5 `test/e2e/contract.ts`: test ids for the PR icon (e.g. `TID.prIcon`) and its badge; e2e fixture support for a fake `gh` on the daemon's `PATH`
- [ ] 1.6 `test/e2e/sidebar.spec.ts` (or a new `test/e2e/prs.spec.ts`): every web "Pull request icons" scenario — icons by state, pending draft, hover lines, click opens a new page with the PR URL and keeps the selection, no-PR row reserves no space and marks align, icon follows a scripted state change within one interval without reload, second page shows the icons without a new `gh` call, no gh / exit 4 → no icons and no error; verify they fail
- [ ] 1.7 `test/e2e/perf.spec.ts`: "Budgets with a hanging status request" — the switch budgets and the 250 ms sidebar add/remove with a `gh` that never returns; verify it fails
- [ ] 1.8 Codex review of the tests against the spec delta and design

## 2. Architecture

- [ ] 2.1 `architecture/model.c4`: `prs = component 'PRs'` under `daemon`, arrows `daemon.server -> daemon.prs` and `daemon.main -> daemon.prs`; regenerate diagrams with `la-arch-diagrams`; verify `la-arch-check` and LikeC4 validation pass
- [ ] 2.2 `architecture/typescript.daemon.arc42.md`: delete principle 1, renumber 2–8 as 1–7, replace principle 6 with the approved wording of design D2 verbatim; verify `la-arch-check` passes
- [ ] 2.3 `test/architecture/dependencies.ts`: allowlist `'daemon.prs': ['child_process']`; verify the architecture tier passes

## 3. Protocol

- [ ] 3.1 `prStatus` schema and PR status type in `src/protocol/messages.ts` (values in `values.ts`); bump `DAEMON_PROTOCOL_VERSION` to 12 and `BROWSER_PROTOCOL_VERSION` to 16; re-bless `wire.golden.json`; verify 1.1 passes

## 4. Daemon

- [ ] 4.1 `src/daemon/prs/`: origin resolution, branch-on-origin, query builder, response schema and mapping, bounded subprocess runner, per-repo refresher with coalescing, daemon-wide queue (4), cache, failure classes, `close()`; verify 1.2 passes
- [ ] 4.2 `src/daemon/server/daemon.ts`: start/stop per-repo PR refresh with the repo watch, feed branch-set changes, send cached `prStatus` after `repoState` before `done`, broadcast changes, await `prs.close()` in shutdown; `src/daemon/main/index.ts`: wire the service and `WTD_PR_INTERVAL_MS`; verify 1.3 passes
- [ ] 4.3 Run the D6 query once against real GitHub with the local `gh` and confirm the captured fixtures in 1.2 match real responses (D17)

## 5. Web

- [ ] 5.1 `src/web/client/store.ts` (+ `connection.ts` if events are routed there): keep `prs` per (host, repo) with the D19 lifecycle; verify 1.4 store cases pass
- [ ] 5.2 `src/web/ui/`: PR lookup per entry, hover-line builder, `PrIcon` component (inline octicons, badge, link with stopped propagation) placed left of `Mark`/`Ring` in `WorktreeEntry`; `src/web/main/styles.css`: glyph colours and badge; verify 1.4 UI cases, 1.6 and 1.7 pass

## 6. Gates

- [ ] 6.1 Run the local test scope (`la-affected-tests --base main` plus the e2e specs of 1.6–1.7 and `test/e2e/sidebar.spec.ts`, `test/e2e/attention.spec.ts`); all green
- [ ] 6.2 Enforcement bundle: `la-arch-check`, LikeC4 validation, `la-typecheck`, `pnpm lint`; all green
