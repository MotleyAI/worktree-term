## Why

worktree-term (DEV-1989) replaces GitKraken's worktree + terminal workflow with a fast, worktree-centric terminal manager that works over SSH. The whole v1 is too large for one PR, so this first change lays a foundation that every later PR builds into: an enforced architecture, a strict toolchain, the complete wire protocol, and a walking skeleton in which every node and import boundary already exists.

## What Changes

- Toolchain scaffold: pnpm, TypeScript 6 (strict family), ESLint `strictTypeChecked`, Prettier, Vitest projects (`unit`, `process`, `architecture`, `integration`), Playwright, esbuild (`dist/wtd.mjs`) and Vite (`dist/web`).
- Living architecture: LikeC4 model with nodes `protocol`, `platform` (`files`, `dialer`), `daemon` (`worktrees`, `terminals`, `state`, `server`, `main`), `hub` (`server`, `links`, `config`, `router`, `main`), `cli`, `web` (`client`, `terminals`, `layout`, `ui`, `main`); arc42 principles per node; `living-architecture.yaml`; green enforcement bundle (`la-arch-check`, `likec4 validate`, `la-typecheck`).
- Architecture fitness tests: structure (element entry points, type-only imports), third-party and I/O built-in allowlist per element, static checks (tsc + eslint), architecture checks.
- Complete wire protocol: message schemas for the daemon link and the browser link, stream and WebSocket frame codecs, flow-control constants, layout invariants, version handshake with frozen `hello`/`shutdown`, golden guard against unversioned wire changes.
- Walking skeleton: every element exists as a module whose placeholder entry throws `not implemented`; every model arrow is a real import.
- `wtd` CLI: `--version`, `--help`, usage errors; remaining verbs (`ui`, `hub`, `daemon`, `connect`, `install-local`, `install-remote`) exit `not implemented` until their PRs land.
- Repo config: SonarCloud properties, OpenSpec project context, editor/ignore files, README.

## Capabilities

### New Capabilities
- `protocol`: the wire contract between web, hub and daemons — handshake and versioning, message catalogue for both links, strict decoding, stream and WebSocket framing, data-frame offsets and flow control, request correlation, layout validity, resource limits.
- `cli`: the `wtd` command line surface — version, help and usage-error behaviour.

### Modified Capabilities

## Impact

- New repository content only (greenfield): `src/**`, `test/**`, `architecture/**`, build and lint configuration, `package.json`, `pnpm-lock.yaml`.
- Runtime dependency: `zod` (exact pin). Dev dependencies: TypeScript, ESLint, Prettier, Vitest, Playwright, esbuild, Vite, `living-architecture`, `likec4`.
- Review bots: CodeRabbit and SonarCloud (Automatic Analysis). No CI in this change.
- Follow-up PRs (sub-issues of DEV-1989): local daemon (DEV-2051); hub and core UI (DEV-2052); splits, keyboard, activity, presets (DEV-2053); remote hosts and polish (DEV-2054).
