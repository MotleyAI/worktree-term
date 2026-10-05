## Context

Greenfield repo (MIT license only). See proposal.md for motivation. The requirements brief is Linear DEV-1989; this change is PR 1 of 5. The approved architecture (LikeC4 model, views, `index.yaml`, arc42 principles per node) is committed under `architecture/` with this plan and is normative for every PR: `architecture/system.arc42.md` and the node docs.

Constraints: `la-arch-check` (living-architecture 0.2.3) enforces the model as the import law — a declared arrow without a measured runtime import is a finding, type-only imports are not measured, parent↔descendant edges are ungoverned. DEV-2027 uses this repo as acceptance for living-architecture TS support: green `la-arch-check`, `likec4 validate`, `la-typecheck`; Vitest as `commands.test`; tsconfig `strict`, `noImplicitAny`, `noImplicitOverride`; typed mocks.

## Goals / Non-Goals

**Goals:**
- Every node, nested element and arrow exists and is enforced from this commit on.
- The wire protocol is complete for PRs 2–5 and guarded against unversioned change.
- The toolchain is strict and every gate runs inside `pnpm test`.

**Non-Goals:**
- Any daemon, hub or web behaviour; `node-pty`, `ws`, `xterm`, `preact` dependencies (added by the PR that first uses them); CI.

## Decisions

### D1 Split into five PRs with a walking skeleton
PR1 foundation (this); PR2 local daemon (+ `platform`, `wtd daemon`, `wtd connect`) — DEV-2051; PR3 hub + core UI (+ `wtd ui`/`wtd hub`, perf budgets, remaining spike checks: Claude Code rendering, 58×2 switch timing, RSS) — DEV-2052; PR4 splits, keyboard, activity, presets — DEV-2053; PR5 remote hosts + polish (`install-remote`, `install-local`, `.desktop`, systemd unit, "Add repo") — DEV-2054. Placeholders keep every arrow live: each element's `index.ts` exports a placeholder entry that calls the placeholders of the elements it may import and throws `Error('not implemented')`. Placeholder signatures are not a contract. Each placeholder and each not-implemented CLI verb carries a one-line forward pointer to the issue that implements it (`platform`, `daemon`, `daemon`/`connect` verbs → DEV-2051; `hub`, `web`, `ui`/`hub` verbs → DEV-2052; `install-local`/`install-remote` → DEV-2054). Alternative — whole v1 in one PR — rejected as unreviewable.

### D2 Hub is a separate process
The hub reaches every daemon through one client: the local daemon over its unix socket, remote daemons over `ssh <alias> wtd connect`. Hub restarts never touch PTYs and local/remote share one code path. Alternative (issue: hub inside the local daemon) rejected: hub crash or upgrade would kill local agents and needs two transports. Cost: one more process against the RSS budget, verified in PR3.

### D3 Node structure
See `architecture/model/typescript.c4`. Cross-node arrows into nodes with children target a specific element (`cli → daemon.main`, `hub.links → platform.dialer`) so outsiders cannot reach other inner elements. `protocol` is reached at runtime only by `daemon`, `hub`, `cli` and `web.client`; its types are the shared vocabulary and importable everywhere. `platform` is split into `files` (paths, owner-only atomic file I/O) and `dialer` (daemon socket connect + auto-start) so that only `hub.links` and `cli` can open daemon connections.

### D4 PTY library
`@homebridge/node-pty-prebuilt-multiarch`: same API as `node-pty`, Linux prebuilds for x64/arm64/arm, glibc and musl, Node ABIs 20–26; no compiler on any host and `install-remote` is a plain copy. Upstream `node-pty@1.1.0` ships no Linux prebuilds (verified). Only `daemon.terminals` may import it.

### D5 Approved behaviour beyond the issue
Integer wire `PROTOCOL_VERSION` with frozen `hello`/`shutdown`; outdated host → confirmed "Restart daemon" / "Reinstall & restart" naming the terminals that will die. Activity tracked in the daemon from `setVisible`. CLI verbs `daemon`, `hub`, `install-local`. Fixed configurable hub port and persistent owner-only token (browser storage is per origin). Repo discovery runs in the daemon of the browsed host. Last `resize` wins. A worktree without terminals shows a preset picker; nothing auto-spawns. Presets run as `$SHELL -l -i -c <command>`; the plain shell as `$SHELL -l -i`.

### D6 Protocol peer semantics (binding on PRs 2–5)
The `protocol` spec fixes the codec. Peers SHALL also obey:
- Handshake: each side sends `hello` first; any other message before the peer's `hello` → `error{code: bad-message}` and close. After a `hello` with a different `protocol`, a daemon accepts only `shutdown` (others → `error{code: version-mismatch}`) and the hub marks the host `outdated`. A browser whose hub `hello` differs reloads; the hub serves `index.html` with `Cache-Control: no-cache`.
- Instances: `hello.instance` is random per process start. Terminal ids are never reused within a daemon instance; a changed instance means every earlier terminal is gone. A daemon discards persisted layout leaves on start.
- Flow control: per connection and terminal, the daemon tracks `sent − acked` output bytes. The PTY pauses while any attached connection exceeds `FLOW_HIGH` and resumes when all are below `FLOW_LOW`. A connection that keeps a PTY paused longer than `LAG_EVICT_MS` is detached from that terminal (`detached{reason: lagging}`) and re-attaches when the terminal is shown. With no attached connection a PTY never pauses. Snapshot bytes do not count. Clients ack at least every `ACK_EVERY` consumed bytes.
- Hub relay: the hub forwards acks unchanged and never acks for the browser, so bytes in flight through it per terminal are bounded by `FLOW_HIGH`. Each browser session gets its own daemon link per host; the hub forwards enveloped requests and replies unchanged (`req` namespace = the browser session).
- Snapshot cut: attach at output position S sends a snapshot tagged S, then output frames starting exactly at S; that connection's ack cursor starts at S. Producing the cut atomically (headless writes are asynchronous) is PR2's concern.
- Input: senders chunk input to `MAX_INPUT`; the daemon bounds its PTY write queue (PR2).
- `removeRepo` fails with `busy` while the repo has live terminals; `unwatchRepo` ends only that connection's subscription; daemon state is not pruned by repo removal.
- `discoverRepos` from the browser carries only the host; the hub adds the configured roots and depth.

### D7 Architecture fitness tests (`test/architecture/`, default suite)
All import analysis uses the TypeScript AST and module resolver, covering `import`, `import type`, `export … from`, `export *`, side-effect imports, `import x = require`, dynamic `import()` and package subpaths; each form has a self-test fixture.
- `structure.test.ts`: nodes with children (`platform`, `daemon`, `hub`, `web`) contain no `.ts/.tsx` directly; every element and leaf node has `index.ts`; an import crossing into another unit targets its `index.ts`; type-only cross-unit imports follow a model arrow or target `protocol`. Units and arrows are read from the LikeC4 model.
- `dependencies.test.ts`: per-unit allowlist of third-party packages and I/O-capable built-ins (`fs net http https http2 child_process dgram tls worker_threads cluster vm inspector repl`, incl. `/promises` and `node:` forms). Pure built-ins (`path util events buffer crypto stream string_decoder url os timers assert process`) are free in Node units; `protocol` and `web.*` import no built-ins. Allowlist: `protocol` zod · `platform.files` fs · `platform.dialer` net, child_process · `daemon.worktrees` fs, child_process · `daemon.terminals` @homebridge/node-pty-prebuilt-multiarch, @xterm/headless, @xterm/addon-serialize · `daemon.state` zod · `daemon.server` net · `hub.server` http, ws · `hub.links` net, child_process · `hub.config` zod · `cli` child_process · `web.client` @preact/signals · `web.terminals` @xterm/xterm and addons webgl, fit, web-links, unicode11, search · `web.ui` preact, @preact/signals · `web.main` preact · all other units: none. Static files for the hub are read through `platform.files`.
- `static.test.ts`: `tsc -b` and `eslint . --max-warnings 0` exit 0.
- `arch.test.ts`: `la-arch-check` and `likec4 validate architecture` exit 0.

### D8 Toolchain
- pnpm 12.8.1 (`packageManager`); build scripts approved for exactly `esbuild` (PTY package added in PR2); ESM only; `engines.node >=20`; `.nvmrc` 22.
- TypeScript `~6.0.3` (matches living-architecture's own). `tsconfig.base.json`: `strict`, `noImplicitAny`, `noImplicitOverride`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noUnusedLocals`, `noUnusedParameters`, `allowUnreachableCode: false`, `verbatimModuleSyntax`, `isolatedModules`, `forceConsistentCasingInFileNames`, ES2023. Solution `tsconfig.json` references composite projects: `src/protocol` (`types: []`, no DOM), `tsconfig.node.json` (Node, NodeNext, excludes web and protocol), `src/web` (DOM, Bundler, `jsxImportSource: preact`), `tsconfig.test.json` (`test/**`). Composite projects emit declarations only, to `build/types/<project>` with their `.tsbuildinfo` (gitignored). `index.yaml` names `tsconfig.json`.
- ESLint flat config: `strictTypeChecked` + `stylisticTypeChecked`, `explicit-module-boundary-types`, `consistent-type-assertions` (only `as const`), `switch-exhaustiveness-check`, `ban-ts-comment` (`ts-expect-error` with description only), no `require` and no dynamic `import()` in `src`, `eslint-config-prettier`; tests: `vi.fn` only with a type argument.
- Vitest projects `unit` (`src/**/*.test.ts`), `process` (`test/process`), `architecture` (`test/architecture`), `integration` (`test/integration`, excluded by default). Playwright (`channel: chrome`, `test/e2e`) runs with `--pass-with-no-tests` in PR1 only; PR3 removes the flag.
- `pnpm test` = Vitest `unit` + `process` + `architecture`, then Playwright. `pnpm test:integration` = Vitest `integration`.
- Build: Vite → `dist/web`; esbuild `src/cli/index.ts` → `dist/wtd.mjs` (node20, ESM, shebang; the PTY package external).
- zod pinned exactly. Protocol schemas are `strictObject`s; static types via `z.infer`.
- Wire guard: `src/protocol/wire.golden.json` holds `PROTOCOL_VERSION`, the JSON Schema of every message union, every limit constant, and a corpus of valid and invalid sample messages with their verdicts. The test fails if any of these change while `PROTOCOL_VERSION` does not. A second golden pins `hello`, `shutdown` and the frame header permanently.
- `living-architecture.yaml`: CodeRabbit on; Sonar on with `MotleyAI_worktree-term`; `issue_key_pattern: "DEV-\\d+"`; `commands.test: pnpm test`, `commands.lint: pnpm lint`, `commands.typecheck.typescript: tsc -b`. `.tsc-baseline.json` written once by `la-typecheck --write-baseline` (empty).

## Risks / Trade-offs

- [Protocol frozen before its first real user] → versioned, golden-guarded; later PRs amend it with a version bump and an approved spec delta.
- [`la-typecheck` with `tsc -b` untested] → first implementation task verifies it leaves the worktree clean; failure is flagged as a living-architecture issue, not worked around.
- [Lag eviction re-sends snapshots to throttled background windows] → snapshots are capped (5k lines) and only sent when a terminal is shown again.
- [Placeholders are temporary code] → each throws, is reached only through stub wiring, and is replaced by its PR.
- [Chrome background throttling] → handled by lag eviction instead of letting a hidden window stall agents.
