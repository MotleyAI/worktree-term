## Context

`worktreeRisks` (`src/daemon/worktrees/git.ts`) already fetches the base before counting, but `fetchBase` returns `false` on failure and the caller ignores it, so the count silently uses a stale `origin/main` (proposal.md — Why). System principle 6 forbids this: a typed failure that is returned and then dropped is a swallowed error. Nodes touched: `daemon.worktrees`, `daemon.server` (pass-through), `protocol`, `web.ui`; no new imports, no model or arc42 change. Applicable principles: system 5, 6, 8; daemon 1; protocol 2, 3, 4; web 2.

## Goals / Non-Goals

**Goals:**
- Make a dropped fetch failure unrepresentable: the outcome is a required field of the risks result and of the wire message.
- No network round trip when local knowledge (local default branch ∪ its remote-tracking ref as last fetched) already covers the worktree's commits.

**Non-Goals:**
- Treating a branch pushed to its own upstream (not merged) as safe.
- Caching fetches across removals, or fetching anything but the default branch.

## Decisions

- **D1 — Safe = reachable from local `D` or `origin/D`.** One count, `git rev-list --count <head> --not <local> <remote>` (existing refs only), before and after the fetch. Chosen by the user over the issue's sequential single-base comparison: fewer fetches (GitKraken/IDE auto-fetch keeps `origin/main` fresh) and fewer false warnings offline. Consequence: the warning names the union ("main or origin/main").
- **D2 — Default branch `D`.** First of `origin/HEAD`'s target branch name, `main`, `master` for which `refs/heads/D` or `refs/remotes/origin/D` exists. `origin/HEAD` stays first (existing behaviour; right for a repo whose default is `develop`). Codex suggested restricting to `main`/`master`; rejected.
- **D3 — Precedence of `ahead`.** No base → null (with or without a head); else no head → 0; else the count. Keeps the wire invariant exact: `ahead` null ⇔ `local` and `remote` both null.
- **D4 — Fetch only when the local count is > 0 and `git remote` lists `origin`.** Refspec `+refs/heads/D:refs/remotes/origin/D`, so the remote-tracking ref is updated whatever `remote.origin.fetch` says, and a force-pushed default branch still updates. Env as today (`GIT_TERMINAL_PROMPT=0`, `SSH_ASKPASS_REQUIRE=never`). An `origin` that is listed but broken is a failed fetch, not "no origin".
- **D5 — Typed fetch result.** The fetch returns `{ok: true} | {ok: false, reason}` for every process-failure shape `execFile` produces: non-zero exit (`code` number), timeout (`killed` with `signal`, `code` null), other signal, spawn error (`code` string such as `ENOENT`). Only values that are not such errors are rethrown. After `ok`, a missing `refs/remotes/origin/D` is itself a failure ("origin/D is missing after the fetch").
- **D6 — Reason text.** Timeout → `timed out after <n> s`; otherwise git's stderr with each control character (C0, DEL, C1) replaced by a space, first line that is non-empty after trimming, else the error's message; truncated to 1024 characters (the wire limit).
- **D7 — Timeout injectable for tests.** `worktreeRisks` takes an optional fetch timeout defaulting to 20 000 ms; only tests pass another. Hanging and stderr-printing remotes in tests use `ext::` URLs with `protocol.ext.allow=always` set in the test repo's config.
- **D8 — Wire shape.** `worktreeAtRisk{req, worktree, local, remote, ahead, fetchFailed, changes, running}`; `fetchFailed` is required (nullable) so no encoder can omit it; a zod refinement enforces the `ahead`/bases coupling on encode and decode. Both link versions bump (the message rides the browser link inside `host`).
- **D9 — One base phrase in the web.** A single helper builds "main or origin/main[ as last fetched]" from `{local, remote, fetchFailed}`; `removalReasons` and `keptNote` both use it, so the two sentences cannot disagree.

## Risks / Trade-offs

- [The fetch writes `refs/remotes/origin/D` from the daemon] → same as today; it only moves the ref to the remote's value.
- [Concurrent fetches in one repo can fail on a ref lock] → reported honestly as a failed fetch; the user can retry.
- [A remote daemon without agent forwarding always fails to fetch] → that is now visible with the reason, which is the point.
- [Force-pushed default branch: a commit in a stale `origin/main` may be gone remotely] → only possible offline, and the dialog then says "as last fetched".

## Migration Plan

Protocol bump means hub and daemons must run the same build; an older daemon shows as `outdated` and is restarted as for any version bump. No persisted state changes.
