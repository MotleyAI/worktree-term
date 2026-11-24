## Context

See proposal.md for the motivation and specs/ for the behaviour. Today the daemon's `server` keeps one shared worktree watch per repo (`RepoEntry` with its watchers) and broadcasts `worktreesChanged`; each browser page has its own hub session and its own daemon link per host, so a status the daemon keeps reaches every page through the existing `watchRepo` path. The hub relays every daemon event inside `host{m}` and keeps no state but config.

Architecture constraints that apply (see `architecture/`):
- System 1 (import law): the new component and its arrows go into `model.c4`; system 3 (allowlist): only `daemon.prs` may use `child_process` for this; system 5 (parse at the boundary): `gh` output is schema-parsed inside `prs`; system 6 (no swallowed errors): a failed refresh returns a typed failure; system 8 (tests per tier).
- Daemon 6 (new wording, below): forge state is the only polled state, and only while its repo is watched.
- Protocol 2–4: `prStatus` is a zod schema with a strict decoder; both link versions are bumped.
- Web 2 (only `client` decodes) and 5 (switching makes no network round trip): the icon renders from the store only.
- Hub 4–5: the event is relayed unchanged; nothing is cached in the hub.

## Goals / Non-Goals

**Goals:**
- One `gh` request per repo per refresh, bounded in time, count and concurrency, never on the path of any other reply or event.
- Exact attribution of a pull request to `origin:<branch>`, also for pull requests into origin's parent and after the head branch was deleted.

**Non-Goals:**
- Pull request status for forges other than GitHub (a non-GitHub `origin` shows no icons).
- Refreshing on local commits, lock changes or prunable changes (user-approved narrowing of "when its worktree list changes").
- Attributing pull requests whose head repository was deleted (`headRepository` is null; they are excluded).
- An automated test against the real GitHub API (`test/integration` holds only opt-in real-SSH tests, system principle 8).
- Any icon on repo tabs, or any status in the hub.

## Decisions

### Architecture

- **D1. New daemon component `daemon.prs`** (`src/daemon/prs/`, public surface `index.ts`), composed by `server` (feeds worktree lists, broadcasts statuses) and `main` (wires it into `DaemonServices`, reads `WTD_PR_INTERVAL_MS`). Model: `prs = component 'PRs'` under `daemon`; arrow `daemon.main -> daemon.prs` (`server` declares the service shape it uses and imports nothing from `prs`); regenerate the view diagrams. Allowlist: `'daemon.prs': ['child_process', 'zod']`. Alternative: inside `daemon.worktrees` next to `fetchBranch` — rejected: it would mix polled forge state into the event-driven watch boundary. (user)
- **D2. Daemon arc42 principle 6** — (user, approved wording) "6. Worktree changes are observed by events, never by polling; only forge state (≡ pull requests on the repo's git server) is polled, and only while its repo is watched. [review]"
- **D3. Daemon arc42 principle 1 deleted**, principles 2–8 renumbered 1–7: it restated the model's import law (model-truth already bans every undeclared arrow), and naming the composed elements would go stale with `prs`. Alternatives: delete and keep the gap; leave it untouched. Nothing cites daemon principles by number. (user)

### Which pull request

- **D4. Origin** — parse `git remote get-url origin` into (host, owner, name) for `https://host/owner/name[.git]`, `user@host:owner/name[.git]` and `ssh://[user@]host[:port]/owner/name[.git]`; an SSH host is resolved with `ssh -G <host>` (its `hostname` line), so `~/.ssh/config` aliases work; the result is cached per origin URL value; `gh api --hostname <host>` makes GitHub Enterprise work. No `origin` or an unparsable URL is a successful empty result. Alternative: gh's own repo resolution (`{owner}`/`{repo}` placeholders) — rejected: gh prefers an `upstream` remote or `gh repo set-default`, not `origin`. (default)
- **D5. Branch on origin** — tracked branch when `branch.<b>.remote` is `origin` and `branch.<b>.merge` is a single `refs/heads/…` ref; none when it tracks another remote or has several merge refs; else the local name. Not required: an existing `refs/remotes/origin/<b>` (a `fetch --prune` after an auto-deleted head branch would hide merged PRs). (default, codex)
- **D6. Exact head lookup with a deleted-branch fallback**, in one GraphQL request (codex finding 1):
  ```graphql
  query($owner: String!, $name: String!, $q0: String!, $b0: String!, …) {
    repository(owner: $owner, name: $name) {
      nameWithOwner
      r0: ref(qualifiedName: $q0) {           # $q0 = "refs/heads/<branch>"
        all: associatedPullRequests(first: 5, states: [OPEN, CLOSED, MERGED],
                                    orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { ...P } }
        open: associatedPullRequests(first: 5, states: [OPEN],
                                     orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { ...P } }
      }
      n0: pullRequests(headRefName: $b0, first: 5, states: [OPEN, CLOSED, MERGED],
                       orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { ...P } }
      o0: pullRequests(headRefName: $b0, first: 5, states: [OPEN],
                       orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { ...P } }
      parent {
        n0: …same as n0 above…
        o0: …same as o0 above…
      }
    }
  }
  fragment P on PullRequest {
    number url state isDraft updatedAt mergeable reviewDecision
    headRepository { nameWithOwner }
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  }
  ```
  One alias set per distinct branch. Each connection is asked for every state and for open ones only, so `first: 5` never hides an open PR behind more recently updated closed ones; the candidates are the union. `rN` non-null → its `all` and `open` connections are the candidates (exact head, any base, parent included). `rN` null (branch gone) → `nN` and `oN` of origin and of `parent`, filtered to `headRepository.nameWithOwner` equal (case-insensitively) to `repository.nameWithOwner`; a null `headRepository` is dropped. Nullable everywhere: `parent`, `rN`, `headRepository`, `commits.nodes` (may be empty), `statusCheckRollup`, `reviewDecision`. Sent as a JSON body `{query, variables}` on stdin (`gh api graphql --hostname <host> --input -`) so no argument-length limit applies. Alternative: `gh pr list --state all` — rejected: capped, misses older PRs, fetches PRs of branches without worktrees, and cannot express the exact head. (default, codex)
- **D7. Choice and mapping** — open/draft wins (most recently updated), else most recently updated. `state`: `MERGED`→merged, `CLOSED`→closed, `OPEN`+`isDraft`→draft, `OPEN`→open. `checks`: `FAILURE`/`ERROR`→failing, `PENDING`/`EXPECTED`→pending, `SUCCESS`→passing, absent→none. `conflicts`: `mergeable == CONFLICTING` (`UNKNOWN` → false; the next refresh resolves it). `review`: `APPROVED`/`CHANGES_REQUESTED`/`REVIEW_REQUIRED`→approved/changes-requested/review-required, null→null. (default)
- **D8. Hover shows all three review decisions** as GitHub reports them. (default)

### Fetching

- **D9. Refresh triggers** — when the repo's watch starts, when its set of (worktree path, branch) pairs changes, and every 60 s while watched. Commits, lock and prunable changes do not trigger. Alternative: every `worktreesChanged` (the issue's literal wording) — rejected: commit storms would spend the shared GraphQL budget on refreshes that cannot show anything new. (user)
- **D10. Coalescing and concurrency** — per repo at most one refresh in flight; a trigger during it queues one follow-up; a timer tick during it is skipped. Daemon-wide at most 4 refreshes at a time, FIFO; a queued refresh of a repo no longer watched is dropped. An in-flight refresh whose repo loses its last watcher completes and fills the cache (no new one starts). (default, codex)
- **D11. Bounded subprocesses** — `gh` 20 s (matching `fetchBranch`), `git` and `ssh -G` 5 s; output capped; children killed on timeout and on `close()`. (default, codex)
- **D12. Outcomes** — success-empty (replaces the cache, broadcast when different): no `origin`, unparsable URL, `gh` missing (`ENOENT`), `gh` exit code 4 (authentication required; also what a non-GitHub host yields). Failure (cache kept, nothing sent, retried next refresh): timeout, other non-zero exit, network error, JSON that does not parse, a response that fails the schema. (codex)
- **D13. Cache** — last successful statuses per repo, in memory, for the daemon's lifetime, also after unwatch. The first success is always sent; later ones only when they differ. (default)
- **D14. Failure logging** — a fixed failure class (`timeout`, `exit`, `network`, `invalid-json`, `invalid-response`) per repo, logged to the daemon's stderr once per class until a success resets it; never raw `gh` output, never shown in the UI. (default, codex)
- **D15. Shutdown** — `prs.close()` stops timers, refuses new refreshes, kills every running child and awaits its exit, and suppresses callbacks after closing; `Daemon.shutdown()` awaits it. (codex)
- **D16. Test seams** — `gh` comes from `PATH` (fake `gh` scripts in process and e2e tests); `WTD_PR_INTERVAL_MS` (positive integer) overrides the 60 s interval, read in `main` like `WTD_MEMORY_SAMPLE_MS`. (default)
- **D17. Query verification** — during implementation the query is run once against real GitHub with the developer's `gh`, and the captured responses (exact head, deleted branch, parent PR, no checks, empty commits) become unit-test fixtures. No automated real-GitHub test (system principle 8). (codex, partly)

### Wire and web

- **D18. Separate `prStatus{repo, prs}` daemon event** keyed by local branch, entries only for branches with a PR; sent after `repoState` and before `done` on `watchRepo` when cached, and to every watcher on change. `DAEMON_PROTOCOL_VERSION` 12, `BROWSER_PROTOCOL_VERSION` 16. Alternative: a field in `Worktree` / `repoState` — rejected by the issue (status must never delay or travel with the worktree list). (default)
- **D19. Store lifecycle** — the web store keeps the latest `prs` per (host, repo); `repoState` resets it (the daemon resends its cache right after), dropping a repo or clearing a host drops it, and a `prStatus` for a repo the store does not hold is ignored. (codex)
- **D20. Icon** — an `<a href target="_blank" rel="noopener noreferrer">` holding the inline octicon (`git-pull-request`, `git-pull-request-draft`, `git-merge`, `git-pull-request-closed`; MIT) in GitHub's colours; its click handler stops propagation so the row is not selected; `title` and `aria-label` carry the hover line. Attention as a corner badge on the glyph: red ✕ for failing checks or conflicts, amber dot for pending checks. Alternative: swapping the glyph for a ✕ / dot — rejected: loses open vs draft and the amber dot looks like the input mark. (user)

### Codex plan review

- **D21.** Finding 6 (hub one-shot `watchRepo` starts a refresh) — rejected (codex): `addRepo`'s one-shot is followed at once by the page's real watch, which then uses the result; `removeRepo` costs at most one request.
- **D22.** Finding 12 (wrong arc42 file name; principle 1 removal is churn) — rejected (codex): the file is `architecture/typescript.daemon.arc42.md`, and the removal is user-approved (D3).
- **D23.** Finding 9 (deleted fork) — folded as the stated limitation in Non-Goals. (codex)

## Risks / Trade-offs

- [GitHub's GraphQL budget is shared by every repo and host on one account] → refresh only on branch-set changes, 60 s interval, one request per repo, ~10 points per request at 58 worktrees.
- [GraphQL schema drift or a query GitHub rejects] → the query is verified against real GitHub once (D17); a rejected query is a failure class `exit`, logged once, and keeps the last status.
- [`mergeable` is `UNKNOWN` until GitHub computes it] → shown as no conflict; the next refresh corrects it.
- [Daemon `PATH` may lack `gh` under systemd] → no icons, no error, as specified; nothing else breaks.
- [Up to 1024 worktrees make a large query] → body on stdin, deduplicated branches; at 3 connections per branch the node count stays far below GitHub's limits.

## Migration Plan

Both protocol versions rise, so a hub of this version marks older daemons outdated and restarts them as for any wire change; no persisted state changes. Rollback is installing the previous version.
