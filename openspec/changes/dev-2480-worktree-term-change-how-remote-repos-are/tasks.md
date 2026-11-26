## 1. Architecture harness (approved wording in design.md)

- [x] 1.1 Add `mounts` under `platform` and the arrows `platform.mounts -> platform.files`, `platform.mounts -> platform.dialer`, `hub.links -> platform.mounts` to `architecture/model.c4`; verify `la-arch-check` and `npx likec4 validate` pass once `src/platform/mounts/index.ts` exists
- [x] 1.2 Apply the approved purpose wording to `architecture/typescript.platform.arc42.md` and `architecture/typescript.hub.arc42.md`, run `la-arch-diagrams`; verify `la-arch-check` reports fresh diagrams
- [x] 1.3 Add `'platform.mounts': ['child_process', 'fs']` to `test/architecture/dependencies.ts` and `['platform.mounts', 'src/platform/mounts', true]` to `test/architecture/structure.test.ts`; verify the architecture tier passes

## 2. Protocol

- [x] 2.1 `repoState.origin`, `reposDiscovered.repos` as `{path, origin}` with distinct paths, normalized-origin value schema; `DAEMON_PROTOCOL_VERSION` 13; verify the protocol unit tests for the daemon-catalogue and value-limit scenarios pass
- [x] 2.2 `removeRepos{req, members}`, `openEditor{req, host, worktree}`, browser `reposDiscovered` entries, hub code `not-a-worktree`; `BROWSER_PROTOCOL_VERSION` 17; verify the browser-catalogue scenarios pass
- [x] 2.3 Regenerate `src/protocol/wire.golden.json`; verify the wire golden check passes and `frozen.golden.json` is unchanged

## 3. Daemon

- [x] 3.1 Origin normalization (pure function in `daemon.worktrees`) covering every "Repo origin" scenario; verify its unit tests
- [x] 3.2 Read `remote.origin.url` from the repo's config file (bare and non-bare, first `url`), without spawning; verify unit tests with fixture config files
- [x] 3.3 `repoState.origin` read on each send; `discoverRepos` returns `{path, origin}` with bounded concurrency; verify daemon process tests for "Repo state names the origin", "Changed origin seen at the next watch", "Discovered repos carry their origins"

## 4. Platform mounts

- [x] 4.1 `src/platform/mounts`: mount-point path (`run/mounts/<sha256-32>`, owner-only), mount/unmount command lines reusing the dialer's SSH options and alias check, `WTD_SSHFS`/`WTD_FUSERMOUNT`; verify unit tests for path distinctness, argument order, refused alias and whitespace
- [x] 4.2 Mount (exit 0 and listed in `/proc/self/mountinfo`, else last error line or `not mounted`, mount point removed), unmount (`-u -z`, then remove), list mounted under the mount dir, missing programs named; verify process tests with fake `sshfs`/`fusermount3` scripts and a fake mount table source

## 5. Hub

- [x] 5.1 Session keeps the latest worktree list per (host, repo) it relays; `openEditor` validates `(host, worktree)` → `not-a-worktree`; routing reply for a non-connected remote host; verify hub process tests "Unlisted path refused", "Remote host not connected"
- [x] 5.2 Mount registry in `hub.links`: keyed by (host name, alias, path), concurrent opens share one attempt, reuse, lazy unmount on a relayed worktree list lacking the worktree, on a new config without the host, on shutdown; stale cleanup at start; failures logged; verify hub process tests for every "Remote worktree mounts" scenario
- [x] 5.3 `openEditor` for a remote host runs the editor on the mount point (`editor-missing` message exactly `sshfs`/`fusermount3`); verify "Remote worktree opened on its mount", "Mount program missing", and the existing editor scenarios with listed worktrees
- [x] 5.4 `removeRepos`: check every member (connected, no terminals, `not-a-repo` tolerated), first failure names host and repo and changes nothing, one config edit, `hosts` to every session; verify the three "Removing repo groups" scenarios

## 6. Web

- [x] 6.1 Pure grouping in `web.ui` (replaces `repoTabs`): groups by known origin, own group for null/unknown, remembered origins, labels and order by first listed member, group keys `origin:<o>` / `<host name>:<repo>`; verify unit tests for every "Repo tabs" scenario
- [x] 6.2 Clone discovery in the page: once per session per host (first connect), watch matching clones once per (host, path), re-match when an origin arrives later, kept apart from "Add repo" by request id; verify unit tests and e2e for every "Clone discovery" scenario
- [x] 6.3 Rows identified by (host, path) across keys, selection, menus, keyboard navigation, visible terminals, PR lookups, checkboxes; sidebar order across clones; remote hover `host:path`; verify "Worktree sidebar" and "Selection" scenarios, including the same path on two hosts
- [x] 6.4 Host and clone pills (hashed hue, `host · clone`, local clone pill only with several local clones, status dimming/error colour, hover text, stays visible at minimum width); verify unit tests for pill rules and e2e for "Host and clone pills"
- [x] 6.5 Hub button labelled with the page's hub name; verify unit test of the label and e2e "Button names the page's hub" and "Hubs keep their own tabs"
- [x] 6.6 "Remove repo" confirmation names every listed member and sends one `removeRepos`; verify e2e "Group removed together" and the existing removal scenarios
- [x] 6.7 Editor control: code-window SVG icon in `currentColor`, enabled for a connected remote host's worktree on a home page, `openEditor` with host, disabled reasons (remote page, host not connected), `editor-missing` program from `sshfs`/`fusermount3` message; verify `editor.test.ts` and e2e "Open in editor" scenarios
- [x] 6.8 Host status display wording for tabs it labels and pills; verify the "Host status display" scenarios

## 7. Docs and alignment

- [x] 7.1 README: "Remote hosts", "Remote hubs" (button label), `editor` paragraph (remote worktrees via sshfs, `WTD_SSHFS`/`WTD_FUSERMOUNT`), repo tabs by origin and discovery, two-machine diagram text; verify by reading against the specs
- [ ] 7.2 Run the enforcement bundle (`la-arch-check`, `npx likec4 validate`, `la-typecheck`) and `pnpm lint`; verify all green
- [ ] 7.3 With the user's yes per issue: propose the DEV-2353 duplicate marking, the DEV-2356 narrowing to VM-only parts, and a DEV-2478 note; record outcomes on DEV-2480
