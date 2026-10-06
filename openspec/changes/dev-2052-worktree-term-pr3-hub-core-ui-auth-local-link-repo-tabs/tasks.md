## 1. Dependencies and feasibility gate (STOP and flag on any failure)

- [ ] 1.1 Add exact pins `ws` (+ `@types/ws` dev), `preact`, `@preact/signals`, `@xterm/xterm@6.0.0` and the `@xterm/addon-webgl`, `@xterm/addon-fit`, `@xterm/addon-web-links`, `@xterm/addon-unicode11` versions declared compatible with it; verify `pnpm install` from clean succeeds and `pnpm ls` shows them
- [ ] 1.2 Probe and record the outcome in a handoff comment on DEV-2052: Playwright Chrome headless with `--enable-gpu --use-angle=vulkan` reports a hardware WebGL renderer (verified during planning: NVIDIA via ANGLE/Vulkan; default headless is SwiftShader); the `ws` server exposes a hook to select the subprotocol and reject an upgrade with a chosen status before the handshake; xterm 6 `write(data, callback)` invokes callbacks in order after parsing; `WebglAddon.onContextLoss` fires on `WEBGL_lose_context.loseContext()`; Vite builds a Preact JSX entry with the esbuild `automatic` runtime

## 2. Tests (pr-tests stage; all fail before implementation)

- [x] 2.1 Protocol v3 unit tests: `PROTOCOL_VERSION` 3, host entry `instance`, `token` (hub→browser only, 64 lowercase hex), `host-unavailable`, `codeResponse`; `wire.golden.json` expectations for version 3; CLI `--version` shows `(protocol 3)`; verify they fail on the current tree
- [x] 2.2 `src/platform/files/files.test.ts`: config and hub paths (`XDG_CONFIG_HOME` honoured / relative ignored); verify they fail
- [x] 2.3 Hub unit tests: config schema (defaults, port range, `~/` expansion without symlink resolution, unknown key, 256 repos), one-time code store with injected clock (single use, 30 s boundary, 16 outstanding), subprotocol credential parser (prefix/suffix, duplicates, two credentials, casing, length, whitespace), static file list (traversal, encoded traversal), host status/backoff machine, host name normalisation (oversized, empty), token file classification (symlink, directory, foreign owner via typed `fs` mock, loose mode, malformed); verify they fail
- [x] 2.4 Web unit tests: `web.layout` tab ops; `WebglLru` (capacity, eviction order, creation failure, context loss of the current and of a disposed instance, ≤ 8 after every transition); `visibleWorktrees` filter and selected-stays-listed; sidebar labels and repo tab disambiguation; reload decision (once per hub instance); ack accounting (multibyte output, queued frames, re-attach with pending callbacks, drain ack below `ACK_EVERY`, never decreasing); restore ordering (watch done before attach, instance change disposes); verify they fail
- [x] 2.5 `test/support/`: browser-side WebSocket test client for the hub (handshake, envelopes, WS data frames, raw upgrade with arbitrary headers) and a hub host fixture (temporary `XDG_STATE_HOME`/`XDG_CONFIG_HOME`/`HOME`, free port, built `dist/wtd.mjs`, stub `WTD_BROWSER` that records its arguments)
- [x] 2.6 `test/process/hub-server.test.ts`: every `hub` scenario of loopback listener, token, request checks and headers, static bundle, one-time codes, identity and shutdown, WebSocket authentication (incl. concurrent upgrades with one code, expiry, oversized message), session handshake, malformed traffic; verify they fail
- [x] 2.7 `test/process/hub-router.test.ts`: configuration snapshots per session, daemon links and host status (start, kill → reconnecting → new instance, fake protocol-99 daemon → outdated), routing (byte-identical envelopes, acks only from the browser, unavailable host, unknown host, independent sessions, not-implemented requests, maximum-size snapshot relayed), back-pressure (unacked bound; 20 flooding terminals to a non-reading session with hub RSS growth < 64 MiB while another session keeps receiving), restart (outdated, concurrent restarts, timeout), session end and shutdown; verify they fail
- [x] 2.8 `test/process/hub-cli.test.ts` and updates to `src/cli/run.test.ts` / `test/process/cli.test.ts`: every `cli` scenario for `wtd hub` and `wtd ui` (start, reuse, replace another version, stale record naming a live non-hub process is not signalled, browser missing, URL carries a code and never the token); verify they fail
- [x] 2.9 `test/process/rss.test.ts`: hub + daemon resident memory < 150 MB with a 58-worktree repo watched and 10 attached terminals after settling; verify it fails
- [x] 2.10 `test/e2e/`: fixture (repos incl. one with 58 worktrees × 2 terminals, page opened through `wtd ui` with the stub browser's URL); every `web` scenario: authentication, stale bundle, reconnect and restore (hub restart keeps terminal objects; daemon restart drops them), repo tabs, sidebar (labels, prunable, vanished worktree, shared checkbox), filter, selection, terminal tabs (new, missing-from-layout, exited), terminal identity, hidden output, restore after reload, 50 MiB numbered output, lagging re-attach, switch sends no request (WS frames observed), renderer budget and forced context loss, outdated host restart; remove `--pass-with-no-tests` from `pnpm test`; verify they fail
- [x] 2.11 `test/e2e/perf.spec.ts`: Chrome with `--enable-gpu --use-angle=vulkan`, renderer assertion, median of 20 switches ≤ 16 ms (recently viewed) and ≤ 50 ms (WebGL reattach) from the `wtd:switch` measure, p95 and max logged; `git worktree add`/`remove` → sidebar ≤ 250 ms; verify they fail

## 3. Protocol v3

- [ ] 3.1 `PROTOCOL_VERSION` 3, host entry `instance`, `token` message, `host-unavailable`, token/code value, `codeResponse`; re-bless `wire.golden.json` (`frozen.golden.json` unchanged); verify 2.1 and the existing protocol tests pass

## 4. Platform

- [ ] 4.1 `platform.files`: configuration and hub paths; `platform.dialer`: export the detached spawn (`dial` uses it); verify 2.2 and the existing platform tests pass

## 5. Hub

- [ ] 5.1 `hub.config`: schema, defaults, `~/` expansion, read through `platform.files`, per-session snapshot with last-valid fallback (design D6); verify its unit tests pass
- [ ] 5.2 `hub.server`: listener under the hub lock, hub record, token file, request checks and headers, static list, code store, identity/shutdown endpoints, WebSocket authentication, session handshake and malformed-traffic handling, HTTP client for a running hub (design D2–D5); verify its unit tests and the 2.6 scenarios pass
- [ ] 5.3 `hub.links`: local daemon link over `platform.dialer`, detached start of `wtd hub` and the browser (design D6); verify with the router tests
- [ ] 5.4 `hub.router`: host status machine, per-session links, forwarding and re-framing, unavailable/unknown host errors, not-implemented requests, back-pressure, serialized restart, session end (design D7–D9); verify 2.7 passes
- [ ] 5.5 `hub.main` `runHub` / `openUi` and CLI verbs `hub` / `ui` (design D5, D6); verify 2.8 and 2.9 pass and `la-arch-check` exits 0

## 6. Web

- [ ] 6.1 Build: Vite JSX and version `define`, web unit-test tsconfig project, hub serving `dist/web` (design D14); verify `pnpm build` and `tsc -b` succeed
- [ ] 6.2 `web.client`: authentication, handshake and stale-bundle reload, reconnect, request correlation, signals store, data dispatch, restore protocol (design D10); verify its unit tests pass
- [ ] 6.3 `web.layout`: tab operations; verify its unit tests pass
- [ ] 6.4 `web.terminals`: terminal manager outside Preact, attach generations and acks, lagging re-attach, fit/resize, addons, `WebglLru`, the read-only inspection hook (design D11, D12); verify its unit tests pass
- [ ] 6.5 `web.ui` and `web.main`: repo tabs, sidebar, filter, selection, terminal tabs, empty and outdated states, switch measurement (design D13); verify 2.10 and 2.11 pass
- [ ] 6.6 Spike: open the UI in a headed Chrome `--app` window, run `claude` in a terminal, take screenshots at three window sizes (incl. a resize while running) and inspect box drawing, colours, wide characters, the input box and redraw; record the outcome with the screenshots' findings on DEV-2052; STOP and flag any rendering defect

## 7. Architecture (each edit shown to the user for approval when it lands)

- [ ] 7.1 Remove `@xterm/addon-search` from the `web.terminals` allowlist in `test/architecture/dependencies.ts`; verify the dependency tests pass
- [ ] 7.2 Once their tests are green, propose tagging `hub.arc42.md` principle 3 `[enforced: test:test/process/hub-server.test.ts]`, principles 4 and 5 `[enforced: test:test/process/hub-router.test.ts]`; `web.arc42.md` principles 4, 5, 6 `[enforced: test:<e2e spec>]` (6 also `[enforced: test:src/web/terminals/<lru test>]`), 7 stays `[review]`; `system.arc42.md` principle 7 additionally `[enforced: test:test/process/hub-server.test.ts]`; verify `la-arch-check` exits 0
- [ ] 7.3 Propose `specs ['hub']` on `hub` and `specs ['web']` on `web` in `architecture/model/typescript.c4`; verify `la-arch-check` and `likec4 validate architecture` exit 0 (if the check needs the archived specs, land this edit with the archive in pr-review)

## 8. Final gates

- [ ] 8.1 `pnpm test` green (incl. Playwright without `--pass-with-no-tests`); `la-typecheck`, `la-arch-check`, `likec4 validate architecture` exit 0; `pnpm build` succeeds; `openspec validate dev-2052-worktree-term-pr3-hub-core-ui-auth-local-link-repo-tabs --strict` passes
