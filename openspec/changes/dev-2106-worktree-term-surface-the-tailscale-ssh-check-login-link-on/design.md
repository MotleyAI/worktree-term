## Context

See proposal.md – Why. Today `ProcessLink` (`src/hub/links`) only consults `StderrTail.reason()` once the SSH process ends, and `HostState` (`src/hub/router/hosts.ts`) can express only failure, not "blocked, here is how to unblock". The symptom is one instance of that structural gap: a pending remote link has no channel for live reports, so the fix adds one channel (one parser, one link event, one host event) rather than a UI special case.

Applicable principles: system 1 (no new model arrows — `hub.links → platform.dialer` exists), 5 (the URL is parsed and prefix-checked where it enters, and the wire decoder rejects anything else), 6, 8; hub 2 (only `links` touches the process), 4 and 5 (state stays per session, no buffering); protocol 2–4 (schema-only type, decoder rejects, browser version bump); web 2 and 7. No arc42 or model edits.

## Goals / Non-Goals

**Goals:** surface the check URL within 1 s; connect on approval over the same SSH process; one approval connects every open session.

**Non-Goals:** the install/reinstall SSH path (it may still hang until its timeout when no control master is authenticated); a handshake timeout (a `needs-login` link waits until Tailscale gives up, then the normal retry runs); opening the URL automatically.

## Decisions

- **Wire shape: new status `needs-login` plus a dedicated `login` field**, not the URL in `reason`. `reason` keeps meaning "cause of the latest failure"; the field's schema (`https://login.tailscale.com/` prefix, ≤ 1024 chars, non-null iff `needs-login`) lets the page put it in an `href` safely, since the decoder rejects anything else.
- **Parser in `platform/dialer`, next to `StderrTail`.** It is SSH-standard-error knowledge, pure, and reusable by the install path later. A line scanner on the same stream holds a partial line across chunks, capped at 4 KiB, inside the existing 1 MiB read limit.
- **Optional `login(url)` on `LinkEvents`.** Only `ProcessLink` calls it, only before the first frame, deduplicated per URL. Delivery is guarded exactly like frames: nothing after `closed` or `finished`, and `HostLink` drops callbacks from a link it no longer holds (Codex review finding 1).
- **Host events `login` and `redial`.** `login` → `needs-login`, keeps `failures` (so an expired check that then fails continues the down-count); `redial` → `connecting`, keeps `failures`; `hello` and `failed` clear `login`.
- **Sibling redial through a per-host-key notifier in the router**, beside the existing `HostCoordinator` map. On a greet, it tells every other session's `HostLink` for that key; only one in `needs-login` closes its link, cancels any retry timer, emits `redial` and connects at once. The redial reuses the now-authenticated control master (`ControlMaster=auto`, `ControlPersist=10m`).

## Risks / Trade-offs

- [Tailscale changes the banner wording] → the parser keys on `To authenticate, visit:` plus the URL prefix; a change degrades to today's behaviour (host stays `connecting`), never to a wrong link.
- [A dead link's late banner reinstating a stale URL] → lifetime guards above, with tests for banners after close, finish and replacement.
- [The two-session process test passing without redial, since the fake SSH gate is shared per alias] → the fixture gains per-invocation release: release only session A's original process, keep B's blocked, let later dials through, and assert B's redial and its original process's termination (Codex review finding 2).
- [Each extra page shows a different URL] → accepted; approving any one connects all via redial.

## Migration Plan

Browser protocol 8 → 9 only: the hub serves the page, so an old page reloads once per the existing stale-bundle rule. No daemon restart.
