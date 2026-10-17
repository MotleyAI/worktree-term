## 1. Tests — unit

- [x] 1.1 `src/platform/dialer`: `tailscaleLoginUrl(line)` accepts the real banner line (with and without `# ` prefix, with CRLF and control characters) and rejects a non-Tailscale host, `http:`, `https://login.tailscale.com.evil/…`, `javascript:`, a URL over 1024 chars, and a line with no URL; fails before the parser exists
- [x] 1.2 `src/platform/dialer`: the line scanner yields complete lines across chunk boundaries and caps a newline-free partial line at 4 KiB
- [x] 1.3 `src/hub/router/hosts.test.ts`: `hostTransition` covers connecting→needs-login→connected; reconnecting/down→needs-login keeping `failures`; needs-login→failed continuing the count (reaching `down` at 3); `redial`→connecting with `failures` kept; `login` null after `hello`, `failed` and `redial`; `reason`/`daemonVersion`/`instance` null in needs-login
- [x] 1.4 `src/hub/links/remote.test.ts` (fake SSH that prints the two-line banner then waits): `login` fires within 1 s and `ended` does not; a repeated URL is reported once; a banner after the first frame, after `close()`, or after the link finished produces no `login` call
- [x] 1.5 `src/hub/router` (session/HostLink level): a `login` callback from a link the `HostLink` no longer holds (replaced by a redial or retry) changes no host state
- [x] 1.6 `src/protocol/messages.test.ts`: needs-login entry with a valid `login` decodes; bad prefix, lookalike host, `javascript:`, 1025 chars, null `login` with `needs-login`, non-null `login` with any other status all reject; `src/protocol/wire.golden.*` re-blessed for `BROWSER_PROTOCOL_VERSION` 9 with `DAEMON_PROTOCOL_VERSION` unchanged; `test-samples.ts` gains a needs-login entry
- [x] 1.7 `src/web/ui/hosts.test.ts`: `hasBanner` true for `needs-login`; `hostAction` null for it

## 2. Tests — process and e2e

- [x] 2.1 `test/support/fake-ssh.ts`: add a per-invocation gate — a fake remote can print the Tailscale banner and block each SSH invocation until that specific invocation is released, while later invocations can be configured to proceed; existing per-alias behaviour unchanged for current tests
- [x] 2.2 `test/process/hub-router.test.ts`: banner then release → the session receives `connecting`, `needs-login` with the URL (within 1 s of the banner), then `connected` with no second SSH invocation and no browser action
- [x] 2.3 `test/process/hub-router.test.ts`: needs-login SSH exits with a reason → `reconnecting` with that reason and null `login`, then `needs-login` with the next invocation's new URL
- [x] 2.4 `test/process/hub-router.test.ts`: three sessions — A and B `needs-login` on their own invocations, C already `connected`; release only A's original invocation (B's original stays blocked, later dials proceed) → B receives `connecting` then `connected` over a new invocation, B's original process is terminated, C receives no change to that host
- [x] 2.5 `test/process/hub-router.test.ts`: `host{watchRepo}` to a `needs-login` host → `error` `host-unavailable`
- [x] 2.6 `test/e2e`: a fake remote blocked on the banner shows `host-banner` naming the host with `host-login` whose `href` is the URL, `target=_blank`, `rel` containing `noopener` and `noreferrer`; its repo tab shows `needs login`; after release the banner disappears and the tab shows no status

## 3. Implementation

- [x] 3.1 `src/protocol`: `needs-login` status, `login` field with its prefix/length refine and the iff-`needs-login` check on the host entry; `BROWSER_PROTOCOL_VERSION` 9; tests 1.6 pass
- [x] 3.2 `src/platform/dialer`: `tailscaleLoginUrl` and the line scanner, exported from `index.ts`; tests 1.1–1.2 pass
- [x] 3.3 `src/hub/links`: optional `LinkEvents.login`; `ProcessLink` scans stderr live before the first frame, dedups the URL, and delivers only while neither `closed` nor `finished`; test 1.4 passes
- [x] 3.4 `src/hub/router/hosts.ts`: `HostState.login`, `login` and `redial` events; `session.ts` forwards `login` only from the link it holds, sends `login` in `hosts` entries, and rejects requests to `needs-login` with `host-unavailable`; tests 1.3, 1.5, 2.2, 2.3, 2.5 pass
- [x] 3.5 `src/hub/router/index.ts` + `session.ts`: per-host-key greet notifier beside the coordinators; a sibling `HostLink` in `needs-login` closes its link, cancels its retry timer, emits `redial` and connects at once; test 2.4 passes
- [x] 3.6 `src/web/ui`: `hasBanner` includes `needs-login`; `HostBanner` renders "<name>: needs Tailscale login" with an "Open login link" anchor (`data-testid="host-login"`, `target="_blank"`, `rel="noopener noreferrer"`) and no action; repo tabs show `needs login`; tests 1.7 and 2.6 pass
- [x] 3.7 README remote-host paragraph: one sentence on the "needs Tailscale login" banner and link

## 4. Final gates

- [x] 4.1 `pnpm test` green (incl. Playwright); `pnpm lint` exits 0; `tsc -b` clean; `la-arch-check` passes with no new arrows; `openspec validate dev-2106-worktree-term-surface-the-tailscale-ssh-check-login-link-on --strict` passes
