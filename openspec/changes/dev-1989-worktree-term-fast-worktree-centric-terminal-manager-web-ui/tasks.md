## 1. Architecture (approved text; committed with the plan)

- [x] 1.1 `architecture/model/typescript.c4`, `architecture/views.c4`, `architecture/index.yaml` and the seven `architecture/*.arc42.md` files exist with the approved text and generated diagrams (`la-arch-diagrams`); verified green against a stub tree during planning
- [ ] 1.2 After the skeleton lands, `la-arch-check` and `likec4 validate architecture` exit 0 on the real tree, and `la-arch-diagrams` leaves the docs unchanged

## 2. Toolchain scaffold

- [ ] 2.1 `package.json` (pnpm 12.8.1 `packageManager`, ESM, `engines.node >=20`, scripts per design D8, build approval for exactly `esbuild`), `.nvmrc`, `.gitignore` (`node_modules`, `dist`, `build`, test output), `.editorconfig`, Prettier config; verify `pnpm install` succeeds from a clean clone
- [ ] 2.2 Pin dependencies: `zod` (exact), TypeScript `~6.0.3`, ESLint + `typescript-eslint`, Prettier, Vitest 5, Playwright 1.63, esbuild, Vite, `living-architecture@0.2.2`, `likec4@1.59.4`, `@types/node`; verify `pnpm ls` shows them
- [ ] 2.3 tsconfig projects per D8 (base, solution, protocol, node, web, test) emitting declarations only into `build/types/<project>`; verify `tsc -b` exits 0 and `git status` shows no new untracked files outside ignored paths
- [ ] 2.4 Verify `la-typecheck --write-baseline` with `commands.typecheck.typescript: tsc -b` writes an empty `.tsc-baseline.json` and a second `la-typecheck` exits 0; if it fails, STOP and flag it as a living-architecture issue
- [ ] 2.5 ESLint flat config per D8; verify `pnpm lint` exits 0 with zero warnings
- [ ] 2.6 Vitest config with projects `unit`, `process`, `architecture`, `integration` (excluded by default) and Playwright config (`channel: chrome`, `test/e2e`, `--pass-with-no-tests` in this PR only); verify `pnpm test` runs all default tiers and `pnpm test:integration` runs only `integration`
- [ ] 2.7 Build: Vite → `dist/web`, esbuild → `dist/wtd.mjs` (node20, ESM, shebang, PTY package external); verify `pnpm build` produces both and `node dist/wtd.mjs --version` runs

## 3. Architecture fitness tests (`test/architecture/`)

- [ ] 3.1 Shared TS-AST import scanner (all forms in D7) with self-test fixtures per form; verify fixtures detect each form
- [ ] 3.2 `structure.test.ts` per D7 (units and arrows read from the model); verify a fixture violation of each rule is reported
- [ ] 3.3 `dependencies.test.ts` with the D7 allowlist; verify a fixture import outside the allowlist is reported
- [ ] 3.4 `static.test.ts` (`tsc -b`, `eslint . --max-warnings 0`) and `arch.test.ts` (`la-arch-check`, `likec4 validate architecture`); verify both pass on the finished tree

## 4. Protocol (`src/protocol`, spec `protocol`)

- [ ] 4.1 Common value schemas and limits (paths, ids, offsets, sizes, names, error codes, collection bounds); verify the "Value limits" scenarios
- [ ] 4.2 Layout schema with depth, unique-terminal, unique-tab-id and active-index refinements; verify the "Layout validity" scenarios
- [ ] 4.3 Daemon-link and browser-link message unions, `hello`/`shutdown`, request correlation; encode/decode with fatal UTF-8 and strict JSON; verify the handshake, decoding, catalogue and correlation scenarios
- [ ] 4.4 Stream frame codec with incremental decoder (`end()` rejects partial frames; failed decoder stays failed) and data-frame payload codecs; verify the "Stream framing" and "Data frames" scenarios
- [ ] 4.5 WebSocket data-frame codec; verify cross-transport equivalence for control messages and every data kind
- [ ] 4.6 Constants (`PROTOCOL_VERSION`, `MAX_FRAME`, `MAX_INPUT`, `FLOW_HIGH`, `FLOW_LOW`, `ACK_EVERY`, `LAG_EVICT_MS`); verify the "Shared constants" scenario
- [ ] 4.7 Wire goldens per D8 (`wire.golden.json` with schemas, limits and the valid/invalid corpus; permanent golden for `hello`, `shutdown`, frame header); verify the test fails when a schema or verdict changes without a version bump

## 5. CLI (`src/cli`, spec `cli`)

- [ ] 5.1 Argv parsing with `node:util.parseArgs`; `--version`, `--help`, usage errors; remaining verbs print `wtd <verb>: not implemented` and exit 2; verify unit tests and the process tests on the built `dist/wtd.mjs` for every `cli` scenario

## 6. Walking skeleton

- [ ] 6.1 `index.ts` placeholder for every element of `platform`, `daemon`, `hub`, `web` (plus `src/web/index.html` entry) wired so that each model arrow is exactly one or more runtime imports and nothing else crosses units, each with its forward-pointer comment (design D1); verify `la-arch-check` passes and the structure and dependency tests pass

## 7. Repo configuration

- [ ] 7.1 `living-architecture.yaml` per D8; verify `la-config show` prints the values and `la-doctor` passes
- [ ] 7.2 `sonar-project.properties` (`MotleyAI_worktree-term`, `motleyai`, sources `src`, tests `src,test`, test inclusions `**/*.test.ts,test/**`, exclusions `dist/**,build/**`); verify keys present
- [ ] 7.3 `openspec/config.yaml` `context:` (stack, test tiers, architecture pointer) and a short `README.md` (purpose, dev commands); verify `openspec validate --all --strict` passes

## 8. Final gates

- [ ] 8.1 Full default suite `pnpm test` green; `la-typecheck` exits 0; `la-arch-check` and `likec4 validate` exit 0; `pnpm build` succeeds
