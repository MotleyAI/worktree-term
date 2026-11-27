## ADDED Requirements

### Requirement: Removing repo groups
`removeRepos{req, members}` SHALL remove every member `{host, repo}` from its host's repos, all or none. It SHALL first check every member as `removeRepo` does — the member's host `connected`, and its daemon, over a link of the hub's own, listing no terminal for the repo, a `not-a-repo` error not preventing the removal — and on the first failing member reply the error `removeRepo` would give, its message naming that member's host and repo, and change nothing. When every member passes, it SHALL remove, in one configuration edit, every entry of each member's host repos naming the member's repo, as given or by a `~/` form expanding to it, and reply `done`; members not listed SHALL change nothing. The terminal checks SHALL be made once, before the edit. Every session SHALL then receive `hosts` without the removed repos.

#### Scenario: Group removed in one edit
- **WHEN** the browser sends `removeRepos` for `/r/app` on the local host and `/srv/app` on remote host `box`, neither with terminals
- **THEN** `config.json` lists neither, it was written once, and the browser receives `done` and then `hosts` without both

#### Scenario: Busy member keeps the whole group
- **WHEN** the second member of a `removeRepos` has a running terminal
- **THEN** the browser receives `error` with `busy` naming that member's host and repo, and `config.json` is unchanged

#### Scenario: Unreachable member keeps the whole group
- **WHEN** a member's host is `down`
- **THEN** the browser receives `error` with `host-unavailable` naming that member, and `config.json` is unchanged

### Requirement: Remote worktree mounts
The hub SHALL keep the mounts of remote worktrees as its own, shared by every session and outliving the session that made them. A mount SHALL be identified by the host's name, its SSH alias and the worktree path, and SHALL be made as the platform's remote directory mount requirement states, at most once at a time: concurrent requests for the same mount SHALL wait for the one attempt, and a mount that exists SHALL be reused. The hub SHALL unmount, lazily, a mount whose worktree is absent from a worktree list that its host's daemon sends on any session's link for the repo holding it, every mount of a host that a newly read configuration no longer lists under the same name and alias, and every mount on shutdown. On start it SHALL unmount every mount and remove every leftover directory under its mount directory. A failed unmount SHALL be reported in the hub's log and SHALL NOT fail anything else.

#### Scenario: Mount reused
- **WHEN** two sessions open the same remote worktree in the editor, one after the other
- **THEN** the mount program runs once and both editors receive the same mount point

#### Scenario: Concurrent first opens share one attempt
- **WHEN** two `openEditor` requests for the same remote worktree arrive before its mount is ready
- **THEN** the mount program runs once and both requests are answered after it is ready

#### Scenario: Session end keeps the mount
- **WHEN** the session that opened a remote worktree closes
- **THEN** the mount stays

#### Scenario: Removed worktree unmounted
- **WHEN** a mounted worktree is removed on its host and the host's daemon sends the repo's worktree list without it
- **THEN** the hub unmounts it lazily and removes its mount point

#### Scenario: Removed host unmounted
- **WHEN** `config.json` no longer lists the host of a mount and a new session starts
- **THEN** the hub unmounts it

#### Scenario: Unmounted on shutdown
- **WHEN** the hub shuts down with two mounts
- **THEN** both are unmounted before it exits

#### Scenario: Stale mounts cleaned at start
- **WHEN** a hub that held a mount was killed and a new hub starts
- **THEN** the new hub unmounts it and its mount directory holds no leftover directories

## MODIFIED Requirements

### Requirement: Opening a worktree in an editor
`openEditor{req, host, worktree}` SHALL first check that `worktree` is the path of a worktree in the latest worktree list that `host`'s daemon sent on this session's link for a repo the session watches; otherwise it SHALL answer `error{req, host: null, code: not-a-worktree}` naming the path and start nothing. A request for a remote host that is not `connected` SHALL be answered as routing does. For the local host the editor's path SHALL be `worktree`; for a remote host it SHALL be the mount point of the worktree's mount, as the remote worktree mounts requirement states, and a failure to mount SHALL be answered with the mount's error, `editor-missing` whose message is exactly the missing program's name, or `editor-failed` with the reason. The hub SHALL start the session's editor command on the hub's machine, with the arguments the editor command yields for the editor's path, the path always being a single argument and no shell being involved, in a new session of its own, with the editor's path as its working directory, standard input from `/dev/null` and its output discarded, without waiting for it to exit. When a lasting user manager is reachable, the started editor SHALL be moved into a transient scope of its own; a failure to do so SHALL be reported in the hub's log and SHALL NOT fail the request. Once the editor has started the hub SHALL answer `done`. When the editor's path is not an existing directory, before or after an attempt to start, the hub SHALL answer `error{req, host: null, code: editor-failed}` naming the path; when the program cannot be found it SHALL answer `error{req, host: null, code: editor-missing}` naming the program; any other failure to start SHALL answer `error{req, host: null, code: editor-failed}` with the reason. The editor's later exit SHALL NOT be observed.

#### Scenario: Path is one argument
- **WHEN** the editor command is a program that records its arguments followed by `--wait {path}`, and `openEditor` names the listed local worktree `/tmp/a b/$x;y`
- **THEN** the requester receives `done` and the program received exactly the arguments `--wait` and `/tmp/a b/$x;y`, with that directory as its working directory

#### Scenario: Path appended without placeholder
- **WHEN** the editor command is a recording program with the argument `-n` and no `{path}`
- **THEN** the program receives `-n` followed by the worktree path

#### Scenario: Editor outlives the request
- **WHEN** the editor started by `openEditor` keeps running and the session closes
- **THEN** the editor keeps running

#### Scenario: Missing program
- **WHEN** the editor command's program `kate-nope` is not on the hub's `PATH`
- **THEN** the requester receives `error` with code `editor-missing` naming `kate-nope`

#### Scenario: Missing directory
- **WHEN** `openEditor` names a listed local worktree whose directory was deleted before the session received the new list
- **THEN** the requester receives `error` with code `editor-failed` naming the path, not `editor-missing`

#### Scenario: Program not executable
- **WHEN** the editor command's program is a file without execute permission
- **THEN** the requester receives `error` with code `editor-failed`

#### Scenario: Editor in its own scope
- **WHEN** a lasting user manager is reachable and `openEditor` starts the editor
- **THEN** the editor runs in a transient scope of its own, not in the hub's

#### Scenario: Unlisted path refused
- **WHEN** `openEditor` names a directory that is no worktree of a repo the session watches on that host, an unknown host, or a worktree of another host
- **THEN** the requester receives `error` with code `not-a-worktree`, and nothing is mounted or started

#### Scenario: Remote worktree opened on its mount
- **WHEN** a session watching remote host `box`'s repo `/srv/app` sends `openEditor` for `box` and its worktree `/srv/app-wt`
- **THEN** the hub mounts `box:/srv/app-wt` and starts the editor with the mount point as its path and working directory, and the requester receives `done`

#### Scenario: Remote host not connected
- **WHEN** `openEditor` names a worktree of a remote host that is `reconnecting`
- **THEN** the requester receives `error` with `host-unavailable`, and nothing is mounted

#### Scenario: Mount program missing
- **WHEN** `openEditor` names a remote worktree and `sshfs` is not on the hub's `PATH`
- **THEN** the requester receives `error` with code `editor-missing` naming `sshfs`
