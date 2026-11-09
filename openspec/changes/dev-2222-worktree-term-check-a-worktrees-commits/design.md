## Context

See proposal.md (Why). Today `worktreeRisks` in `src/daemon/worktrees/git.ts` resolves one default branch, compares the head with its local branch and `origin` ref, and on unmerged commits fetches that one ref with an explicit refspec and compares again. The wire (`worktreeAtRisk.local`/`remote`/`fetchFailed`) and the web phrase builder (`basesPhrase`/`removalReasons`/`keptNote` in `src/web/ui/sidebar.ts`) are shaped around exactly that pair.

Symptom: a stacked worktree merged into its real base is reported as "not in main or origin/main". Structural cause: the comparison set is a hard-coded pair in three places — daemon, wire, web — that must agree by hand. Fix: the daemon resolves an ordered list of bases once, and that list flows end to end (one compare/fetch path over the list, one wire field, one phrase builder), so adding a base source never touches the wire or the web again.

Applicable principles: system P5 (git config/reflog output parsed by a pure, typed parser before use), P6 (no swallowed errors: a missing key/reflog is a typed "none", anything else rethrows), P8 (tests per tier); daemon P1 (all git logic stays in `daemon/worktrees`); protocol P2 (schema only), P3 (old shape rejected), P4 (both link versions raised — `hubToBrowser.host{m}` embeds daemon events); web P2 (only `client` decodes; `ui` consumes the typed message). No model or arc42 change; deltas modify the existing `daemon`, `protocol` and `web` capabilities.

## Goals / Non-Goals

**Goals:**
- Base discovery from local git only (upstream, then reflog creation record), falling back to the default branch.
- Commits count as at risk only when in none of the base pair and the default pair.
- Wait before the confirmation stays bounded by one fetch time limit.

**Non-Goals:**
- GitHub PR base lookup (`gh`) and fork-point heuristics (decision 1).
- Squash-merge detection (unchanged from today).
- Remotes other than `origin` (decision 5).
- Fetching an `origin/<base>` that does not exist locally yet (decision 3).

## Decisions

1. **Base lookup: upstream → reflog "Created from" → default branch, all local git.** Weighed: GitHub PR base first (needs `gh`, auth and a network call on every host, GitHub-only); fork-point heuristic (wrong once the base advanced or merged the work; a branch stacked on top looks like a perfect base). (user)
2. **Compare with the base plus the default branch**, not the base only: no false alarm for a stacked branch that was retargeted and merged into main while a stale local base remains; a commit in main is never at risk. Costs a wire change and both version bumps. Codex finding #2 (base only, as the issue text reads) — rejected (codex): reverses this user decision; a commit reachable from the default branch is not lost. (user)
3. **Fetch `origin/<base>` only when it already exists locally; `origin/<default>` always, as today.** Weighed: always fetch (every warning for a local-only stack gains a "couldn't find remote ref" clause and a doomed round trip). Codex finding #1 (always fetch the base, per the issue text) — rejected (codex): reverses this user decision, whose con (a never-fetched remote base is missed) was accepted. (user)
4. **A candidate is used only if its local branch or `origin/<x>` exists**, else the next source — a deleted base falls through to the default branch. (default)
5. **An upstream on a remote other than `origin` gives no candidate**; all comparison is origin-only, as today. (default)
6. **Reflog `Created from HEAD` gives no candidate**; HEAD at creation time cannot be recovered reliably. (default)
7. **Wire: flat `bases: string[]` + `fetchFailed: {ref, reason}[]`** rather than `{local, remote}[]` pairs — the web needs only the names in order and which remotes failed to fetch. (default)
8. **The base and default branch are chosen once per removal; after the fetches only ref existence, head, `bases`, `ahead` and `changes` are read again** (was: values kept from before a failed fetch). Needed for partial success (one fetch fails, the other succeeds); a base re-chosen mid-request could name refs that were never refreshed. (codex #7, replacing the original "re-determine everything")
9. **Both fetches run concurrently, isolated: `--no-write-fetch-head --no-auto-maintenance`**, each with its own 20 s limit, so the wait stays bounded at 20 s and the two processes share no file (`FETCH_HEAD`, maintenance locks). Weighed: sequential, base first (simplest, but up to 40 s when the remote hangs). (user, codex #4)
10. **Phrase joining "a, b, c or d"; one failure clause per failed fetch, base first.** Two bases read exactly as today ("main or origin/main"). (default)
11. **No-base sentence:** "There is no base branch to check that its commits are merged." (user, approved wording)
12. **Both protocol versions raised: `DAEMON_PROTOCOL_VERSION` 10, `BROWSER_PROTOCOL_VERSION` 13**, since `hubToBrowser.host{m}` embeds daemon events. The "Hello from another protocol version" scenario moves from 9 to 99 so it stays a foreign version. (default)
13. **Reflog candidates must be branch names**: the recorded `<ref>` is the user's start-point argument and may be a tag, a commit id, a revision expression or another remote's ref; after stripping `refs/heads/`, `refs/remotes/origin/` or `origin/`, a candidate is skipped when it is not a valid branch name (`git check-ref-format --branch` rules: no `~ ^ : ? * [ \` space, `..`, `@{`, …), is `HEAD`, or also names a tag (ambiguous). Validation also guarantees the name is safe inside the fetch refspec. (codex #3)
14. **Reflog query is `git reflog show --format=%gs refs/heads/<b>`**, bounded by the existing `MAX_OUTPUT`; only its last (oldest) line is used and only when it starts with `branch: Created from `. No reflog (e.g. a bare repo, `core.logAllRefUpdates` off) or an expired creation entry gives no candidate. Reflog messages are not localized. (codex #5)
15. **Branch config is read by exact key**: `git config --get branch.<b>.remote` and `git config --get-all branch.<b>.merge` (git splits section/subsection/key at the first and last dot, so names with dots and slashes work); exit 1 = unset; more than one `merge` value gives no candidate. (codex #6)
16. **Protocol rejects duplicate `bases` and duplicate `fetchFailed` refs.** Not adopted from Codex #8: requiring `origin/` refs on the wire (remote naming is daemon policy) and requiring each failed ref to be among `bases` (legitimately false for an unusable origin or a ref missing after the fetch). (codex #8, partly)
17. **Extra coverage** for a tracked base excluded by `remote.origin.fetch`, non-branch creation sources (tag/branch collision, commit id, `HEAD~1`, other remote), dotted/slashed names, several `merge` values, an expired/missing reflog, a non-default base named in a process-tier warning, and a remote base that becomes safe only after the fetch. (codex #9)

## Risks / Trade-offs

- [A branch created without a start point (`Created from HEAD`), cloned, or with an expired reflog has no detected base] → falls back to the default branch, today's behaviour; `git branch -u <base>` sets the base by hand via the upstream source.
- [A never-fetched remote base is not refreshed] → accepted (decision 3); the commits are still compared with the local base and a fresh `origin/<default>`.
- [Concurrent fetches in one repo] → isolated by `--no-write-fetch-head --no-auto-maintenance` and destinations that differ (the base equal to the default is deduplicated, so one ref is never fetched twice).
- [Wire break with running daemons] → both versions raised; an upgraded hub reports old daemons outdated and restarts them, as for any daemon-link change.

## Migration Plan

Ships as one release: daemon, hub and web move to the new versions together; no persisted state changes. Rollback is a downgrade of the package, which restarts daemons at the old version.
