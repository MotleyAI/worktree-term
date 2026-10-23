## 1. Tests — unit

- [x] 1.1 `src/protocol/messages.test.ts` + `test-samples.ts`: `openHub`, `installHub`, `hubLogin`, `hubOpened` round-trip and are rejected in the wrong direction; `hubOpened.url` rejections (foreign host, `https:`, port 80, a path other than `/`, `javascript:`); `hubLogin` lookalike URL rejected; `hub-outdated` and `hub-failed` accepted by the hub `error` and rejected by the daemon `error`; fails before the schemas exist
- [x] 1.2 `src/protocol`: print-code line round-trip, single trailing newline, extra field, leading `motd` line, port 80 and 7417.5 rejected; home and remote fragment decode and reject cases from the spec; the samples are added to `frozen.golden.json` and the frozen golden test fails on any shape change
- [x] 1.3 `src/protocol/wire.golden.*`: re-blessed for `BROWSER_PROTOCOL_VERSION` 10 with `DAEMON_PROTOCOL_VERSION` 6 and daemon-link goldens unchanged; `constants.test.ts` expects 10
- [x] 1.4 `src/hub/config`: the `port` schema (range, unique, ≠ hub port incl. default 7417, unknown keys still rejected); the assignment edit: first port 7418, max+1 (7418 and 7425 give 7426), a removed lower port not reused, the wrap-around (hub 65535, held 1024, gives 1025), no free port → error, a present port untouched and the file unchanged, recomputed after a concurrent writer (gives 7422 with 7421 taken), other values kept as written
- [x] 1.5 `src/hub/router/coordinator.test.ts`: the FIFO queue with `install`: install shares a running or queued install or reinstall; restart and reinstall wait for an install; install waits for a restart; all orderings of three requests keep one run at a time; existing restart/reinstall sharing unchanged
- [x] 1.6 `src/cli/run.test.ts`: `ui box` dispatches with the host; `ui --print-code` dispatches print mode; `ui box --print-code` and `ui a b` exit 2 with usage; help lists `ui [<host>] [--print-code]`; `--version` names browser protocol 10
- [x] 1.7 `src/hub/links`: `HubOpener` against fake processes: login URL reported once, 30 s budget only without a URL, stdout over 4096 bytes kills the process and fails, exit 2/127/undecodable gives outdated, 255 gives failed with the last stderr line, cancel kills and suppresses every callback; `forward` pipes both ways and ends both sides when either ends
- [x] 1.8 `src/web/client`: fragment reading (remote, else home, else none; malformed ignored; remote values kept in and read back from session storage; title derivation); `src/web/ui`: the Hubs menu model (entries, marked entry, hidden without remote hosts, target URLs on a remote page) and the status-line reducer (latest-only, login, outdated → installing → reopen, failed with ×, unknown `#hub` name)

## 2. Tests — process, e2e, integration

- [x] 2.1 `test/support/fake-ssh.ts`: support `-W 127.0.0.1:<port>` by relaying stdio to that TCP port on the fake remote; scriptable print-code behaviour (banner then wait, exit 2/127/255, oversized output, refused forward printing `channel 0: open failed: administratively prohibited`); existing behaviour unchanged
- [x] 2.2 `test/process/hub-server.test.ts`: any-port `Host` accepted for `GET /`, the API and upgrades with a matching `Origin`; `127.0.0.1`, `127.0.0.1:07417` and a mismatched `Origin` refused (403); the existing Host and Origin cases still pass
- [x] 2.3 `test/process/hub-cli.test.ts`: `wtd ui --print-code` starts a hub and prints a line whose code the hub accepts once, opens no browser, and replaces a hub of another version; `wtd ui box` passes `#code=…&hub=box` to `$WTD_BROWSER`; `wtd ui nope` exits 1 with the exact message and starts no hub
- [x] 2.4 `test/process/hub-router.test.ts` (fake remote with its own hub): `openHub` writes `port` 7418, replies `hubOpened` with the URL from the spec, and `GET /` and a code upgrade through 127.0.0.1:7418 reach the remote hub; login banner then release after a delay → `hubLogin` then `hubOpened`; exit 2 and 127 → `hub-outdated` with no listener; 255 → `hub-failed` with the line; 30 s silence → `hub-failed` (injected short budget); port held → `hub-failed` naming it; refused forward → `hub-failed` with its line; local index → `unknown-host`
- [x] 2.5 `test/process/hub-router.test.ts`: a second `openHub` kills the first's SSH process and only the second replies; two sessions share one listener; closing a session kills its opening SSH process; closing a tunneled connection ends its forward process; a host removed from config gets its connections closed without SSH; a changed `port` rebinds and retires the old listener; `SIGTERM` closes listeners and forwards
- [x] 2.6 `test/process/hub-router.test.ts`: `installHub` installs while a daemon terminal keeps running in the same instance; it shares a running `reinstallDaemon`; a `restartDaemon` waits for it
- [x] 2.7 `test/e2e` (fake remote hub reachable through fake SSH): Hubs menu lists "This machine" and the remote; picking it lands the tab on the remote origin titled `worktree-term — box` with the remote's repos; "This machine" goes back home and reconnects with the stored token; a remote → other remote pick goes through `home/#hub=`; status line for login (anchor `target=_blank`, `rel` with `noopener noreferrer`), outdated → "Reinstall on box" → installing → navigation, failure with ×; `#hub=nope` shows `no host named nope`
- [x] 2.8 `test/integration` (opt-in, real SSH): `-W` over an existing master and with none, a refused forward reported, master loss ends forwards, no child processes left behind

## 3. Implementation

- [x] 3.1 `src/protocol`: new messages, `hubErrorCode`, the `hubOpened` URL schema, the print-code line and fragment schemas with encoders and decoders, version 10, goldens; tests 1.1–1.3 pass
- [x] 3.2 Architecture: apply the two approved hub.arc42.md edits verbatim; add `net` to `hub.server` in `test/architecture/dependencies.ts`; `la-arch-check` passes with no new arrows
- [x] 3.3 `src/hub/server/listener.ts`: Host `127.0.0.1:<port>` for any port, same-origin `Origin` for the API and upgrades; test 2.2 passes
- [x] 3.4 `src/hub/config`: the `port` field and the assignment edit in `ConfigEditor`; test 1.4 passes
- [x] 3.5 `src/hub/router/coordinator.ts`: the FIFO queue with `install`; test 1.5 passes
- [x] 3.6 `src/hub/links`: `HubOpener` and `forward`; test 1.7 passes
- [x] 3.7 `src/hub/server`: `TunnelListeners` (127.0.0.1 only, serialised bind/repoint/retire/close, per-connection authorisation against the latest config map, close on shutdown)
- [x] 3.8 `src/hub/router`: `openHub` (fresh config, port assignment, opener, one per session with cancellation, `HubTunnels.ensure`, probe, URL) and `installHub`; `src/hub/main` wires `HubTunnels` and the config map; tests 2.4–2.6 pass
- [x] 3.9 `src/hub/main` + `src/cli/run.ts`: `ui [<host>] [--print-code]`, optional positional, mutual exclusion, unknown host, the `--print-code` line, usage text; tests 1.6 and 2.3 pass
- [x] 3.10 `src/web`: fragment reading and session storage in `client`, title, Hubs menu, status line, `location.assign` navigation; tests 1.8 and 2.7 pass
- [x] 3.11 Docs: README usage (the Hubs menu, `wtd ui <host>`, `wtd ui --print-code`), configuration (the per-host `port`, written by the hub), remote-host requirements (`AllowTcpForwarding`), and the README architecture section's two-machine diagram gains the hub tunnel (laptop hub's per-host port → `ssh -W` → remote hub); `wtd --help` text matches; every doc example still runs as written

## 4. Final gates

- [x] 4.1 `pnpm test` green (incl. Playwright); `pnpm lint` exits 0; `tsc -b` clean; `la-arch-check` passes; `openspec validate dev-2107-worktree-term-open-a-remote-hosts-hub-in-its-own-window --strict` passes
