## Why

The sidebar shows a merged pull request on worktrees that have none. A branch created from `origin/main` with tracking is looked up as `main`, so it shows `main`'s pull request. A pull request opened in a fork with origin's branch as its head, such as a fork's "sync with upstream", is shown as origin's own.

## What Changes

- A worktree's branch is looked up on `origin` under its own name. Its upstream's name is used only when `push.default` is `upstream` or `tracking`, where `git push` really sends it there, and the branch has exactly one upstream branch.
- Whether a branch is on `origin` follows its push remote as git reports it (`branch.<b>.pushRemote`, `remote.pushDefault`, `branch.<b>.remote`), no longer its upstream's remote. Triangular setups (tracking `upstream`, pushing to `origin`) now get their pull request.
- A pull request counts only when its head repository is the `origin` repository and it belongs to the `origin` repository or to the repository `origin` is a fork of. One rule covers every way a pull request is found.
- A branch's candidates are those whose head is that branch of `origin`, found by the branch's ref or by head branch name, whether or not the branch still exists on GitHub.

## Capabilities

### New Capabilities

### Modified Capabilities
- `daemon`: Requirement "Pull request status" changes which branch of `origin` a worktree's branch stands for, and which pull requests are its candidates.

## Impact

- `src/daemon/prs/github.ts`: branch resolution reads `git for-each-ref` and `git config` instead of the branch config alone; the GraphQL query fetches each pull request's repository and the parent's name; one candidate predicate.
- Tests: `src/daemon/prs/github.test.ts`, `src/daemon/prs/github-capture.json` (re-captured), `test/support/fake-gh.ts`, `test/process/daemon-prs.test.ts`.
- No protocol, web or architecture model change.
