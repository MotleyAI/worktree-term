# worktree-term

A fast, worktree-centric terminal manager for coding agents. One tab per repo (local or over SSH), every git worktree in a sidebar, and persistent terminals per worktree that outlive the UI.

The CLI is `wtd`: a daemon per host owns the PTYs and git watches, and a local hub serves the browser UI and reaches every daemon over one protocol. See `architecture/` for the structure and its principles.

## Development

Requires Node 22 (`.nvmrc`) and pnpm.

```sh
pnpm install
pnpm build              # dist/wtd.mjs and dist/web
pnpm test               # unit, process, architecture and e2e tiers
pnpm test:integration   # opt-in real-SSH tests
pnpm lint               # tsc -b and ESLint
pnpm format             # Prettier
```
