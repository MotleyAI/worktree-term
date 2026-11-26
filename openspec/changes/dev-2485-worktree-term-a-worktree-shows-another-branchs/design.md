## Context

See proposal.md for the symptom. Both causes live in `src/daemon/prs/github.ts`:

1. **Branch on origin.** Branch resolution derives the branch's name on `origin` by hand from `branch.<b>.remote`/`merge`. That treats the upstream, which is often just the base the branch was created from, as where the branch is pushed.
2. **Candidates.** Two code paths filter candidates differently. The ref path (`associatedPullRequests`) takes every pull request with the ref as head, whatever repository it belongs to. The head-name path filters by head repository only, and runs only when the ref is gone.

Applicable principles:
- system 5: input from outside the process is schema-parsed at the boundary. This now includes `git for-each-ref`/`git config` output and the new GraphQL fields.
- system 6: errors become typed failures.
- system 8: tests ship in their tier.
- daemon 5: only forge state is polled.

No model, import or arc42 change. The spec stays in the `daemon` capability.

## Goals / Non-Goals

**Goals:**
- The branch's name on `origin` follows where `git push` sends it, never its base.
- One candidate predicate applied to every pull request, whichever alias found it.

**Non-Goals:**
- Reproducing every `push.default` mode's refusal. A branch git would refuse to push bare is still looked up under its own name (D3).
- Paginating GraphQL connections beyond `first: 5` (see Risks).
- Hiding pull requests of the default branch as such.

## Decisions

### D1 — Push remote from git, branch name from `push.default`

- Run `git for-each-ref --format='%(refname)%00%(push:remotename)%00%(upstream:remotename)' refs/heads`. `%(push:remotename)` is git's own resolution of `branch.<b>.pushRemote` > `remote.pushDefault` > `branch.<b>.remote`. When it is empty (nothing configured), the push remote is `origin`. When it names another remote, the branch has no branch on `origin`.
- Also run `git config -z --get-regexp '^(push\.default|branch\..*\.merge)$'`, giving `push.default` and every merge value. The upstream's name `<x>` is used only when `push.default` is `upstream` or `tracking`, the upstream remote is `origin` and there is exactly one `refs/heads/<x>` merge value. Otherwise the branch's own name is used.
- Both processes are bounded at 5 s. `git config` exit 1 means none set. Any other nonzero exit, a nonzero `for-each-ref` exit, or output that doesn't parse fails the refresh (`exit` / `invalid-response`), keeping the last statuses.
- `%(push)` is not used. On git 2.54 it is empty for a triangular `simple` push, and under `push.default=upstream` with `pushRemote` ≠ the upstream's remote it names the upstream's remote. `%(push:remoteref)` is empty without a push refspec. `%(upstream:remoteref)` shows only the first of several merge values, so merges are counted from `git config`.
- Alternatives: keep hand-parsing `branch.*` config. Rejected: it reimplements git's push-remote precedence, which is the bug's root.

### D2 — One candidate predicate over every alias

- The `P` fragment gains `repository { nameWithOwner }`, and the query reads `parent { nameWithOwner … }`.
- A pull request is a candidate iff:
  - its `headRepository` is the `origin` repository, and
  - its `repository` is the `origin` repository or its parent (case-insensitive).
- Candidates are the union of the ref aliases (`r<i>.all/open`) and the head-name aliases (`n<i>`/`o<i>`) of origin and parent, whether or not the ref exists. All of these are already fetched on every refresh. A null ref (branch deleted) contributes none.
- Alternatives:
  - Filter only the ref path. Rejected: two paths that must agree by hand.
  - Head-name aliases only. Rejected: in a busy parent, other forks' same-named heads crowd ours out of `first: 5`.

### Decisions log

1. Branch name under `push.default=upstream`. Options: A, always own name; B, honour `upstream`/`tracking`. **B taken**: no regression, and it matches `git push`. (user)
2. Which remote decides whether a branch is on `origin`. Options: the upstream's remote (as before); the push remote as git reports it. **Push remote taken**: triangular fork setups get their pull request. An extension beyond the issue. (user)
3. Several upstream branches give the branch's own name instead of none. Without `push.default=upstream` the upstream is irrelevant; with it, `git push` refuses. (default)
4. Read the push remote from git (`%(push:remotename)`) instead of reimplementing its precedence; `%(push)` not used (probe in D1). (default)
5. One candidate predicate (head repository is origin, own repository is origin or its parent) over every alias; the ref query stays. (default)
6. `github-capture.json` is re-captured from a real `gh api graphql` call with the new query, never hand-edited. (default)
7. Codex: `%(push:remotename)` may be empty under `simple`/`nothing` and ignore a non-origin `pushRemote`. Rejected (codex): a git 2.54 probe shows it reports `pushRemote`/`remote.pushDefault` under `simple` and `nothing`, and is empty only when nothing is configured. Tests pin a non-origin push remote under `simple` and `nothing`.
8. Codex: `%(upstream)` cannot establish exactly one upstream branch. Folded (codex): merge values are counted from `git config -z --get-regexp`, which also reads `push.default` (D1).
9. Codex: own name under `nothing`/`simple`/`matching` is not git push semantics. Folded (codex) as a clarification: the rule is a lookup policy (own name, except the upstream's name under `upstream`/`tracking`), tested for `simple`, `current`, `matching`, `nothing` and an invalid value. Rejected (codex): returning none where a bare `git push` refuses, since such branches are pushed as `git push -u origin <b>` under their own name, and none would break the issue's Done-when.
10. Codex: `first: 5` lets ineligible pull requests crowd out an eligible one. Folded (codex): candidates are the union of ref and head-name aliases behind one predicate (D2). The remaining bound is under Risks.
11. Codex: git failure paths. Folded (codex): `git config` exit 1 means none set; every other git failure fails the refresh (D1).

## Risks / Trade-offs

- [An eligible pull request crowded out of both the ref aliases (five newer pull requests in other repositories with the same head) and the head-name aliases (five newer same-named heads from other forks)] → It is missed. That needs 5+ foreign pull requests on both paths; accepted rather than paginating.
- [A never-pushed branch tracking `origin/main` under `push.default=upstream` shows `main`'s pull request] → Intended: `git push` would push it there (decision 1).
- [Two git processes per refresh instead of one] → Each is bounded at 5 s and runs before `gh`, which dominates.
