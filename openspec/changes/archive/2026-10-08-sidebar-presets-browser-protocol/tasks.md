## 1. Architecture

- [x] 1.1 Restate `protocol.arc42.md` purpose and principle 4 for two link versions (enforced by `wire.golden.test.ts`); verify `la-arch-check`, `likec4 validate architecture` and the architecture tests pass

## 2. Protocol

- [x] 2.1 Split `PROTOCOL_VERSION` into `DAEMON_PROTOCOL_VERSION` (5) and `BROWSER_PROTOCOL_VERSION` (6); daemon link (daemon, hub links, one-shot links, restarter, `wtd connect`) uses the first, browser link (hub listener, web client) the second (design D1)
- [x] 2.2 Golden guard per link: `protocolVersions {daemon, browser}`, schema and corpus changes need their link's bump, constants need both; guard unit tests for each case; verify the guard accepts this change against the previous golden with only the browser version raised, then re-bless `wire.golden.json`
- [x] 2.3 `addPreset{req, preset}` and `removePreset{req, name}` in the browser-to-hub catalogue, samples, correlation and rejection tests

## 3. Hub

- [x] 3.1 Default presets `shell`, `claude`, `codex` (design D4); config tests
- [x] 3.2 Config editor generalised over an array field; `addPreset` / `removePreset` with the refusals of design D2; editor unit tests incl. concurrent repo and preset edits
- [x] 3.3 Session handling of `addPreset` / `removePreset`, `done` then `presets` to every open session (design D3); `test/process` tests for add, remove from defaults, unknown name, refusals; default-preset expectations in hub-server and hub-router tests

## 4. Web

- [x] 4.1 Client `addPreset` / `removePreset`; view methods; add form validation (`presetFromForm`) with unit tests; "+ Add preset" and × in the picker and the choices; e2e: add from the choices (saved, shown in every page, runs), add in the new-tab picker, remove (every page, config, last offers none), refused name and Escape
- [x] 4.2 Per-repo filter (`filterOf`, `withFilter`, `wtd.filters`) with unit tests; e2e: filter belongs to its repo and persists; switching repos does not animate the switch, a click does (fails without the fix)
- [x] 4.3 Sidebar width (`clampSidebarWidth`, `parseSidebarWidth`, `wtd.sidebarWidth`) with unit tests; draggable and arrow-key separator; e2e: drag, bounds, keys, reload
- [x] 4.4 Pane headers only in splits, terminal box at the pane's top otherwise (design D6); accent-coloured active repo and terminal tabs; e2e: lone pane has no header and its terminal fills it, split panes have one each; update the attention and exited-terminal e2e tests to read the tab's mark
- [x] 4.5 e2e: adding an already-listed repo selects its tab and adds none

## 5. CLI, development, documentation

- [x] 5.1 `wtd --version` prints both protocol versions; unit and process tests
- [x] 5.2 `pnpm dev`: Vite proxy for `/api` and `/ws` with `Host`/`Origin` rewritten, `/login` redirect with a fresh code (design D7)
- [x] 5.3 README: default presets and editing them from the picker; the daemon protocol in `wtd --version`

## 6. Final gates

- [x] 6.1 `pnpm test` green (incl. Playwright); `pnpm lint`, `la-typecheck`, `la-arch-check`, `likec4 validate architecture` exit 0; `pnpm build` succeeds; `openspec validate sidebar-presets-browser-protocol --strict` passes
