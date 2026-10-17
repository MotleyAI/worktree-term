## Why

A remote host reached over Tailscale SSH whose tailnet rule uses `"action": "check"` blocks on an expired check: sshd prints a `https://login.tailscale.com/…` link on standard error and holds the connection until it is approved in a browser. The hub reads a remote link's standard error only after SSH ends, so the host sits in `connecting` forever with no reason shown and no way to find the link from the page (DEV-2106).

## What Changes

- A remote link reads SSH's standard error live while it waits for the daemon's first frame, and reports a Tailscale check login URL (`https://login.tailscale.com/` only) the moment SSH prints it.
- New host status `needs-login`, carrying that URL in a new host-entry field `login`; approving the check lets the waiting SSH proceed, so the host connects with no retry or user action in worktree-term.
- When one session's link to a host greets, every other session's link to that host that is `needs-login` is redialed at once, so one approval connects every open page.
- The page shows a `needs-login` host with a banner and an "Open login link" button opening the URL in a new tab; its repo tabs show `needs login`.
- **BREAKING** (browser link only): `BROWSER_PROTOCOL_VERSION` 8 → 9 for the new status and field; the daemon link is unchanged.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `protocol`: host entry gains status `needs-login` and the `login` field with its URL invariant; browser protocol version 9.
- `hub`: remote links report the Tailscale check URL live and the host becomes `needs-login`; sibling sessions redial when one link greets.
- `web`: banner and repo-tab status for a `needs-login` host, with the login link.

## Impact

- Code: `src/platform/dialer` (login-line parser and line scanner), `src/hub/links` (live stderr scan, `login` link event), `src/hub/router` (host state, session redial across sessions), `src/protocol` (host entry schema, version, goldens), `src/web/ui` (banner, tab status).
- Tests: unit (parser, scanner, host transitions, remote link, protocol, web hosts), process (`test/process/hub-router.test.ts` with a fake `WTD_SSH` gated per invocation), e2e (banner and link).
- Docs: README remote-host paragraph.
- Unchanged: the install/reinstall SSH path; no handshake timeout.
