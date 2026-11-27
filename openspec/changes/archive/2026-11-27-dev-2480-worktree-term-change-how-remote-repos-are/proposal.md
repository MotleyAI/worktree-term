## Why

A repo cloned on several machines shows as unrelated tabs today: this machine's repo tab, and a `name:repo` tab per remote host listed by hand. Worktrees of one project are scattered across tabs, a clone made on a remote host is invisible until listed, the "Hubs" button does not say which hub the page shows, and "Open in editor" refuses every remote worktree.

## What Changes

- The header's hub button shows the name of the page's own hub instead of "Hubs".
- Daemons report each repo's normalized `origin` URL, for watched and discovered repos.
- The page discovers repos on every connected host once per session and treats every clone with the same normalized `origin` as the same repo: a repo tab is an origin group of listed repos, and its sidebar lists the worktrees of every clone in the group, on every host.
- Rows from a remote host carry a pill with the host's name and status; when a host has more than one clone in a tab, the pill also names the clone. Local rows are unchanged unless the tab holds more than one local clone.
- "Remove repo" removes every listed member of a tab's group in one all-or-nothing request (`removeRepos`).
- "Open in editor" gets a code-window icon, and opens a remote host's worktree by mounting it with `sshfs` under the hub's runtime directory and running the editor on the mount.
- **BREAKING** (wire): `DAEMON_PROTOCOL_VERSION` 12 → 13 (`repoState.origin`, `reposDiscovered.repos` entries `{path, origin}`); `BROWSER_PROTOCOL_VERSION` 16 → 17 (`openEditor.host`, `removeRepos`, `reposDiscovered` entries, `not-a-worktree` error code). Remote hosts show "Reinstall & restart" once.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `protocol`: versions, both message catalogues, value limits and shared constants change for origins, `removeRepos` and `openEditor.host`.
- `daemon`: repo watching and discovery report each repo's normalized origin.
- `hub`: group removal, editor opening for remote worktrees through hub-owned `sshfs` mounts.
- `platform`: mounting and unmounting a remote directory over `sshfs`, and finding stale mounts.
- `web`: hub button label, origin-grouped repo tabs, cross-host sidebar rows with host and clone pills, group removal, editor icon and remote editor opening.

## Impact

- Code: `src/protocol` (messages, constants, goldens), `src/daemon/worktrees` and `src/daemon/server` (origin), `src/hub/router/session.ts`, `src/hub/links` (mount registry), new `src/platform/mounts`, `src/web/ui` (repo tabs, sidebar, hubs, editor, app), `src/web/client/store.ts`.
- Architecture: new component `platform.mounts` with arrows `platform.mounts -> platform.files`, `platform.mounts -> platform.dialer`, `hub.links -> platform.mounts`; platform and hub arc42 purpose lines; dependency allowlist.
- Runtime dependencies: `sshfs` and `fusermount3` on the hub's machine, only for opening remote worktrees.
- Docs: README "Remote hosts", "Remote hubs", `editor` and the two-machine diagram.
- Related issues: DEV-2353 (remote editor mount) is delivered here; DEV-2356 (VM worktrees in their repo's sidebar) builds on the origin grouping.
