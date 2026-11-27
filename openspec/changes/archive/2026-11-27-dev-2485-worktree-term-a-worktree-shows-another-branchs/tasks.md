## 1. Tests first (pr-tests)

- [x] 1.1 `src/daemon/prs/github.test.ts`, branch on origin (real git, fake `gh`; assert the branches asked and the local branch each status is keyed by). Cover:
  - `--track origin/main` with `push.default` unset, `simple`, `current`, `matching` and `nothing` → own name;
  - `push.default` `upstream` and `tracking` → upstream's name;
  - `upstream` with two `branch.<b>.merge` values → own name;
  - `upstream` with `branch.<b>.remote` ≠ `origin` while the push remote is `origin` → own name;
  - `branch.<b>.pushRemote=origin` and `remote.pushDefault=origin` while tracking `upstream/main` → own name asked;
  - a non-origin `pushRemote` under `simple` and under `nothing` → not asked;
  - a branch tracking `upstream/feature/x` with no push remote set → not asked;
  - no config → own name.

  Verify they fail.
- [x] 1.2 `src/daemon/prs/github.test.ts`, align existing tests (approved with the plan):
  - "asks for the origin branch a local branch tracks…" now sets `push.default=upstream`;
  - "asks for no branch that tracks another remote or several branches": the several-branches part now asks for the branch's own name.
- [x] 1.3 `src/daemon/prs/github.test.ts`, git failures:
  - `for-each-ref` nonzero exit → `exit`;
  - an invalid `push.default` (git's own `for-each-ref` exits 128) → `exit`;
  - `git config` exit 2+ → `exit`;
  - exit 1 → treated as unset;
  - malformed `for-each-ref` output → `invalid-response`;
  - either git process timing out → `timeout`.

  Verify they fail.
- [x] 1.4 `src/daemon/prs/github.test.ts`, candidates. Every PR node in the test responses carries `repository { nameWithOwner }`, and the parent carries `nameWithOwner`. Cover:
  - the ref path drops a pull request whose repository is a fork of origin (the issue's `main` case);
  - the head-name path applies the same predicate;
  - a pull request into the parent is kept;
  - repositories are compared ignoring case;
  - with five newer foreign pull requests on the ref path, the eligible one is still found through the head-name aliases;
  - a null ref still uses the head-name aliases;
  - a missing `repository` field → `invalid-response`.

  `buildQuery` asks for `repository { nameWithOwner }` in the fragment and `nameWithOwner` in `parent`. Verify they fail.
- [x] 1.5 `test/support/fake-gh.ts`: every node answers `repository: { nameWithOwner: 'acme/app' }`.
- [x] 1.6 `test/process/daemon-prs.test.ts`, scenario "Upstream names another branch". A worktree on `feature/y`, created with `--track origin/main`, beside `main`: the `gh` call asks for `feature/y` and `main`, and `prStatus` lists nothing for `feature/y`. Verify it fails.
- [x] 1.7 Codex review of the tests against the spec delta and design.

## 2. Daemon

- [x] 2.1 `src/daemon/prs/github.ts`, branch on origin per design D1:
  - `git for-each-ref` plus `git config -z --get-regexp '^(push\.default|branch\..*\.merge)$'`;
  - strict parsing;
  - `git config` exit 1 = none set, any other failure fails the refresh.

  Verify 1.1–1.3 pass.
- [x] 2.2 `src/daemon/prs/github.ts`, candidates per design D2: `repository { nameWithOwner }` in the fragment, parent `nameWithOwner`, zod schema, one predicate over the union of all aliases. Verify 1.4–1.6 pass.
- [x] 2.3 Re-capture `src/daemon/prs/github-capture.json` by running the new query once against real GitHub with the local `gh` (same repository and branch as the current capture). Never hand-edit it. Verify the capture test passes.

## 3. Gates

- [x] 3.1 Run the local test scope (`la-affected-tests --base main`, plus `test/process/daemon-prs.test.ts`); all green.
- [x] 3.2 Enforcement bundle: `la-arch-check`, LikeC4 validation, `la-typecheck`, `pnpm lint`; all green.
