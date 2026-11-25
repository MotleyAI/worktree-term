## Context

A repo tab is one (host, repo) today: this machine's `repos`, then each remote host's `hosts[].repos` as `name:repo` tabs. Remote clones are listed by hand, `discoverRepos` runs only from the "Add repo" dialog, daemons do not report a repo's remote, the hub button reads "Hubs", and `openEditor` runs the editor on a local path only. Each hub has its own `config.json`; that stays.

Related issues with local worktrees: DEV-2353 (open a remote worktree through an sshfs mount) is delivered by this change; DEV-2356 (VM worktrees in their repo's sidebar) builds on the origin grouping here instead of matching VM names; DEV-2478 (README and screenshot) should follow the new sidebar.

## Goals / Non-Goals

**Goals:**
- One tab per origin, listing worktrees from every host, local rows unchanged unless a tab holds several local clones.
- Zero-config discovery of clones on every host, once per page session.
- The hub button names the page's hub.
- "Open in editor" works for remote worktrees from a home page, with a clearer icon.

**Non-Goals:**
- Sharing tabs, presets or config between hubs.
- Grouping by `upstream` or any remote other than `origin`.
- Rediscovery during a session: no rescan button, no periodic scan, no rescan on reconnect.
- Live origin changes: an origin is re-read only when a repo is watched again (the next page session).
- Opening an editor from a remote hub's page; a remote-editor command such as `code --remote` (sshfs only).
- Tracking the editor's exit to unmount.

## Decisions

### Architecture

- Applies: system 1 (model arrows), 3 (allowlist), 5 (schema-parse at the boundary: origins in zod schemas, mount program output parsed), 6, 8; hub 2 (only `links` spawns, so the mount registry lives in `hub.links`), 4 ((host, id) addressing, never rewritten), 5 (mounts are runtime processes like links; stale mounts are re-derived from the mount table); web 1/2/5 (grouping is a pure function in `web.ui`; switching rows makes no round trip); platform 1 (`mounts` knows no hub or protocol), 3 (owner-only mount dirs).
- Model edits `(user, approved wording)`: `mounts = component 'Mounts'` under `platform`; arrows `platform.mounts -> platform.files`, `platform.mounts -> platform.dialer`, `hub.links -> platform.mounts`.
- Platform arc42 purpose `(user, approved wording)`: "…running a process in a systemd user scope of its own (`scopes`); mounting a remote directory over `sshfs` and unmounting it (`mounts`)."
- Hub arc42 purpose, appended `(user, approved wording)`: "Mounts remote worktrees for the editor; the mounts are the hub's, not a session's."
- Allowlist `(user, approved wording)`: `'platform.mounts': ['child_process', 'fs']` in `test/architecture/dependencies.ts`, and `['platform.mounts', 'src/platform/mounts', true]` in `test/architecture/structure.test.ts`. Diagrams regenerated with `la-arch-diagrams`.
- `platform.mounts` holds only primitives: mount-point paths, mount/unmount command lines, mount, unmount, list mounted. The registry (dedup of concurrent opens, reuse, unmount triggers), worktree validation and editor coordination live in `hub.links` / `hub.router`.
- Specs attach to existing groups only: `daemon`, `protocol`, `hub`, `platform`, `web`.

### Mechanics

- Origin is read by parsing the repo's config file (no `git` process per repo), so discovery of up to 4096 repos stays cheap; included files and `insteadOf` rewrites are ignored.
- Grouping is computed in the page from `hosts`, each listed repo's last known origin and the discovered clones being watched. A listed repo's origin is remembered for the session, so a reconnecting host does not split its tab.
- The page drives discovery with the existing browser `discoverRepos{host}` and watches matching clones with ordinary `host` envelopes; the hub stays a relay. Each page already holds its own links, so moving this into the hub would share nothing.
- `openEditor` validation uses the worktree lists the session's links relayed; the session keeps the latest list per (host, repo) it watches.
- Mounts are keyed by (host name, SSH alias, path), live under `<state>/run/mounts/<sha256-32>`, use `sshfs -o reconnect,ServerAliveInterval=15,ServerAliveCountMax=3 -o ssh_command=<ssh + dialer options>`; readiness is checked in `/proc/self/mountinfo`; unmount is `fusermount3 -u -z`. `WTD_SSHFS` and `WTD_FUSERMOUNT` replace the programs, as `WTD_SSH` does for SSH, for tests.

### Decisions log

1. Remote clones are found by discovery over each host's `roots`, listed repos always included. Options: only `hosts[].repos` / discovery. Taken: discovery, "all connected machines" means zero config and it covers VM hosts later. (user)
2. A tab is an origin group of listed repos; a remote-only listed repo keeps its tab and gathers other hosts' clones; a discovered clone never creates a tab. Options: origin groups / keep `name:repo` tabs and also merge. Taken: groups, no duplicate rows. (user)
3. Identity is the normalized `origin` only. Options: origin / upstream-else-origin / any shared URL. Taken: origin, predictable. (user)
4. Remote rows carry a host-name pill, coloured per host, showing the host's status. Options: pill per row / host group headers. Taken: pill, survives filters and suits one-worktree VM hosts. (user)
5. Editor icon is a code window with `</>`. Options: code window / open-externally arrow. (user)
6. Discovery covers every host including this machine, and same-host clones merge; local rows get a clone pill only when a tab holds several local clones. Options: everywhere / remote only with listed repos never merged. (user: "A, you may indicate path if multiple local clones are present")
7. Discovery runs at page session start, plus a host's first connect in the session; no rescan button, no periodic or reconnect rescan. Options: on (re)connect / periodic / manual rescan. Taken: on UI restart, avoiding UI clutter. (user)
8. DEV-2353's mount requirements are adopted. (default: the brief asks for exactly that)
9. The hub button shows the local host's name on a home page; menu entries keep "This machine", since the frozen fragments cannot carry the home machine's name. (default)
10. "Remove repo" removes every listed member of the group. (default: removing one would leave a relabelled tab)
11. A listed repo whose origin is not yet known is its own group; the last known origin is kept for the session. (default: keeps today's down-host tab and avoids flicker)
12. Grouping lives in the page as a pure function; the hub stays a relay. (default)
13. `openEditor` accepts only a worktree the host's daemon listed to this session; `not-a-worktree` otherwise. (codex)
14. Mounts are hub-owned, never a session's; unmounted lazily on worktree removal, host removal and hub exit; editor exit not tracked, since editors such as kate hand off to a running instance. (codex)
15. Group removal is one all-or-nothing `removeRepos` request: every member checked first, then one config write. (codex)
16. The origin grammar is exact: host lowercased, non-default ports kept, path case kept, credentials stripped, IPv6 kept bracketed, `file:`/local/malformed → null. (codex)
17. Rejected (codex): live origin re-read. A new page session re-watches and re-reads, which matches decision 7.
18. Discovery fan-out bounded: only matching-origin clones are watched, deduplicated by (host, path); session discovery replies kept apart from the "Add repo" dialog's by request id; origin read without a process per repo. (codex)
19. Rejected (codex): moving discovery orchestration into the hub. Links are per session already, so nothing would be shared.
20. A repo whose watch failed stays its own tab with its error; on merge or split the selected (host, path) stays selected and its tab becomes selected. (codex)
21. Rows are identified by (host, path) everywhere: keys, selection, menus, keyboard navigation, visible terminals, PR lookups, checkboxes. (codex)
22. sshfs contract: ready only when listed in the mount table; owner-only hashed mount dirs; stale cleanup by the mount table plus leftover dirs; concurrent first opens share one attempt; SSH options reused from the dialer. (codex)
23. `platform.mounts` is primitives only; policy in `hub.links`. All embedded diagrams regenerated. (codex)
24. Extra e2e coverage: hubs keep their own tabs, unrelated discovered repos are never watched, one vs two local clones, merge/split keeps selection, reload keeps preferences. (codex)
25. The protocol spec's "Shared constants" stated versions 11/15 while the code and the version requirement say 12/16; both now state 13/17. (default)

## Risks / Trade-offs

- Daemon protocol 13 makes every remote host `outdated` until reinstalled once → the existing "Reinstall & restart" banner covers it.
- Discovery scans each host's `roots` (default `~`, depth 3) once per page session → same cost as opening "Add repo" today.
- sshfs is slow for language servers on large repos → accepted; a remote-editor command is a non-goal.
- A clone made during a session appears only after the UI restarts → accepted by decision 7.
- A stored preference keyed by the old `<host idx>:<repo>` is ignored once → each tab resets its filters and selection once.
- Existing tests that pin the old shapes (`Hubs` button text, `openEditor` without `host` or with unlisted paths, `repoTabs` per (host, repo), "Disabled for remote worktrees", wire goldens) must be aligned with the plan in the tests stage, with the user's approval per file.
