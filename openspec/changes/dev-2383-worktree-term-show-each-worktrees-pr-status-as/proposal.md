## Why

The sidebar shows what each worktree's terminals are doing, but not where its branch stands on GitHub. To see whether a branch has a pull request, and whether it is open, failing, merged or closed, the user has to leave the page.

## What Changes

- Each sidebar row whose branch has a pull request shows a PR status icon directly left of its attention mark or ring: GitHub's glyph and colour for open, draft, merged or closed, and for an open or draft PR a corner badge for checks failing or conflicts (red ✕) or checks pending (amber dot). Hover gives one line such as `#123 open · checks failing · changes requested`; a click opens the PR in a new window without selecting the worktree.
- The daemon of the host that holds the repo fetches the status with that host's `gh` CLI, one GraphQL request per repo per refresh: when the repo's watch starts, when its set of worktree branches changes, and every 60 s while it is watched. Requests time out, run at most four at a time per daemon, and are cancelled on shutdown. The last status per repo is kept in memory.
- A new daemon event `prStatus` carries a repo's PR statuses, separate from the worktree list; it is sent after `repoState` on `watchRepo` when known and to every watcher when it changes. Listing, watching and switching never wait for it. **BREAKING** (wire): `DAEMON_PROTOCOL_VERSION` 11 → 12 and `BROWSER_PROTOCOL_VERSION` 15 → 16.
- Architecture: a new daemon component `prs`; daemon principle 6 allows polling forge state while a repo is watched; daemon principle 1, which restated the model's import law, is removed.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `daemon`: adds pull request status fetching, caching and the `prStatus` event.
- `protocol`: adds `prStatus` to the daemon-link catalogue (and so to the browser link), with its value limits, and bumps both protocol versions.
- `web`: adds the PR status icon to worktree rows; performance budgets hold while a status request is slow or hangs.

## Impact

- Code: new `src/daemon/prs/`; `src/daemon/server/daemon.ts` and `src/daemon/main/index.ts` compose it; `src/protocol/messages.ts`, `constants.ts`, wire goldens; `src/web/client/store.ts`, `src/web/ui/app.tsx`, `src/web/main/styles.css`.
- Architecture: `architecture/model.c4` (component `daemon.prs`, arrows from `daemon.server` and `daemon.main`), regenerated view diagrams, `architecture/typescript.daemon.arc42.md`, `test/architecture/dependencies.ts` allowlist.
- Runtime dependency: the `gh` CLI on each host, optional; without it, or without a login, no icons are shown.
- Every hub and daemon must be updated together (protocol version bump).
