## MODIFIED Requirements

### Requirement: Browser session handshake
On an accepted upgrade the hub SHALL send `hello` with `protocol` equal to `BROWSER_PROTOCOL_VERSION`, its package version and its `instance`, then, if the session authenticated with a code, `token{token}`. After the browser's `hello` it SHALL send `presets` with the presets of the session's configuration snapshot, then `editor` with the session's editor command, then `hosts`. A message before the browser's `hello` SHALL get `error{req: null, host: null, code: bad-message}` and close the session; a browser `hello` with another `protocol` SHALL get `error{req: null, host: null, code: version-mismatch}` and close it.

#### Scenario: Code session receives the token
- **WHEN** a browser connects with a valid code
- **THEN** it receives `hello`, then `token` with the hub token

#### Scenario: Token session receives no token
- **WHEN** a browser connects with the token
- **THEN** it receives `hello` and no `token` message

#### Scenario: Presets before hosts
- **WHEN** a browser completes the handshake
- **THEN** it receives `presets`, then `editor`, and then `hosts`

#### Scenario: Message before hello
- **WHEN** a browser's first message is a `host` envelope
- **THEN** it receives `error` with `bad-message` and the session closes

#### Scenario: Browser of another protocol refused
- **WHEN** a browser sends `hello` with `protocol` equal to `BROWSER_PROTOCOL_VERSION` + 1
- **THEN** it receives `error` with `version-mismatch` and the session closes

### Requirement: Configuration
The configuration SHALL be `config.json` holding a JSON object with optional `port` (an integer from 1024 to 65535, default 7417), optional `repos` (at most 256 paths, each absolute or starting with `~/`, which is expanded against the home directory without resolving symbolic links), optional `roots` (1 to 32 discovery roots, each an absolute path, `~`, or `~/` followed by at least one character; default `["~"]`; never expanded by the hub), optional `presets` (1 to 64 objects `{name, command, memory}`, `memory` optional, each name 1–64 characters with at least one non-whitespace character and unique by exact comparison, each `command` null or 1–4096 characters, each `memory` memory limits as the protocol states), optional `terminalMemory` (memory limits), optional `editor` (an editor command as the protocol states; default `kate`) and optional `hosts` (at most 63 objects `{name, ssh, port, repos, roots}`, `port`, `repos` and `roots` optional). A host's `name` SHALL be 1–64 characters from `[A-Za-z0-9._-]`, unique among hosts; its `ssh` alias SHALL be 1–255 characters without whitespace or control characters and SHALL NOT start with `-`; its `port` SHALL be an integer from 1024 to 65535, unique among hosts and different from the hub's `port` (its default included); its `repos` SHALL be at most 256 absolute paths; its `roots` SHALL follow the rules and default of the top-level `roots`. The top-level `repos` and `roots` SHALL belong to the local host. Any other key, in the object, in a preset, in memory limits or in a host, SHALL make it invalid. A preset's **effective limits** SHALL be `terminalMemory` with each key the preset's `memory` holds replaced by its value; effective limits whose `high` exceeds their `max`, both being sizes without `%`, SHALL make the configuration invalid, naming the preset. Without `presets` the presets SHALL be exactly `[{name: "shell", command: null}, {name: "claude", command: "claude"}, {name: "codex", command: "codex"}]`; with it, exactly the listed presets in their order. A missing file SHALL mean the defaults; the hub SHALL create it only to record a repo, preset or editor edit from the page. An invalid configuration at start SHALL fail the start with one line naming the file and the first problem. Each new browser session SHALL use a snapshot of the configuration read when it starts; if that read is invalid, the session SHALL receive `error{req: null, host: null, code: internal}` naming the problem and use the last valid configuration. A changed port SHALL take effect only when the hub restarts.

#### Scenario: Defaults without a file
- **WHEN** no `config.json` exists and the hub starts
- **THEN** it listens on port 7417, lists no repos and no remote hosts, and sessions receive the presets `shell` (command null), `claude` (command `claude`) and `codex` (command `codex`), in that order, and the editor command `kate`

#### Scenario: Unknown key refused
- **WHEN** `config.json` holds the key `theme` and the hub starts
- **THEN** the start fails with a line naming the file and `theme`

#### Scenario: Configured presets replace the default
- **WHEN** `config.json` lists presets `claude` (command `claude`) and `shell` (command null), in that order
- **THEN** sessions receive exactly those two presets in that order

#### Scenario: Invalid presets refused
- **WHEN** `config.json` holds an empty `presets` list, two presets named `a`, or a preset whose command is ""
- **THEN** the start fails with a line naming the file and `presets`

#### Scenario: Configured editor command
- **WHEN** `config.json` holds `editor` `code --new-window {path}`
- **THEN** sessions receive the editor command `code --new-window {path}`

#### Scenario: Invalid editor command refused
- **WHEN** `config.json` holds `editor` "", "   ", `code "{path}` or a string of 4097 characters
- **THEN** the start fails with a line naming the file and `editor`

#### Scenario: Remote hosts listed in order
- **WHEN** `config.json` lists hosts `b` and `a`, in that order
- **THEN** sessions receive `hosts` with the local host at index 0, `b` at index 1 and `a` at index 2, both remote

#### Scenario: Option-like alias refused
- **WHEN** a host's `ssh` is `-oProxyCommand=x` or contains a space
- **THEN** the start fails with a line naming the file and `ssh`

#### Scenario: Home-relative remote repo refused
- **WHEN** a host's `repos` holds `~/app`
- **THEN** the start fails with a line naming the file and `repos`

#### Scenario: Duplicate host names refused
- **WHEN** two hosts are named `box`
- **THEN** the start fails with a line naming the file and `hosts`

#### Scenario: Clashing host ports refused
- **WHEN** two hosts have `port` 7420, or a host has `port` 7417 while the top-level `port` is absent
- **THEN** the start fails with a line naming the file and `port`

#### Scenario: Edit picked up by a new session
- **WHEN** a repo or a preset is added to `config.json` by hand while a session is open, and a new session starts
- **THEN** the new session's `hosts` lists the repo, its `presets` lists the preset, and the open session's do not change

#### Scenario: Invalid edit keeps the last valid configuration
- **WHEN** `config.json` becomes invalid and a new session starts
- **THEN** that session receives an `internal` error and the repos and presets of the last valid configuration

#### Scenario: Memory limits accepted
- **WHEN** `config.json` holds `terminalMemory` `{high: "16G"}` and a preset `tests` with `memory` `{max: "24G", swapMax: "0"}`
- **THEN** the hub starts

#### Scenario: Malformed memory limits refused
- **WHEN** `config.json` holds `terminalMemory` `{max: "lots"}`, or a preset whose `memory` holds the key `min`
- **THEN** the start fails with a line naming the file and `terminalMemory` or `presets`

#### Scenario: High above max after the merge refused
- **WHEN** `config.json` holds `terminalMemory` `{high: "32G"}` and a preset `tests` with `memory` `{max: "16G"}`
- **THEN** the start fails with a line naming the file and the preset `tests`

#### Scenario: Percent and size not compared
- **WHEN** a preset's effective limits are `{high: "50%", max: "16G"}`
- **THEN** the hub starts

### Requirement: Configuration edits
A configuration edit — a repo edit, a preset edit, an editor edit or a host port assignment — SHALL read the current `config.json` (an absent file read as `{}`), change only the edited value — for a repo edit the `repos` of the edited host, the top-level `repos` for the local host, otherwise those of the host entry with the session's host name; for a preset edit the top-level `presets`, starting from the default presets when the file has none; for an editor edit the top-level `editor`, which a reset removes; for a port assignment the `port` of the named host entry — keeping every other value as written, and replace the file atomically with an owner-only file holding the result as JSON indented by 2 spaces. It SHALL fail with `error{code: internal}` naming the problem when the current file is invalid, no longer lists the host of a repo edit, the result would hold more than 256 repos for the host, or a preset edit is refused. If the file changed between the read and the replacement, the edit SHALL start over from the changed file, recomputing its result, at most 3 times in all, and then fail with `error{code: internal}`. Edits of every kind SHALL be applied one at a time. After a repo edit, every open session whose snapshot lists that host SHALL have the host's repos replaced by those of the edited file, `~/` expanded, and receive `hosts`; after a preset edit that changed the file, every open session SHALL receive `presets` with the edited presets; after an editor edit that changed the file, every open session SHALL have its editor command replaced by the edited one and receive `editor`; nothing else in any session's snapshot SHALL change.

#### Scenario: Other entries kept as written
- **WHEN** `config.json` lists `~/a` for the local host and a repo is added for it
- **THEN** the file still lists `~/a` unexpanded, followed by the added path, and every other key is unchanged

#### Scenario: Invalid file not overwritten
- **WHEN** `config.json` is invalid and the browser adds a repo
- **THEN** it receives `error` with code `internal` naming the problem and the file is unchanged

#### Scenario: Concurrent hand edit kept
- **WHEN** `config.json` is changed by another writer after an edit read it and before the edit replaced it
- **THEN** the edit starts over from the changed file, and the result holds both the other writer's change and the added repo

#### Scenario: Host gone from the file
- **WHEN** a session's host `box` was removed from `config.json` and that session adds a repo for `box`
- **THEN** it receives `error` with code `internal` and the file is unchanged

#### Scenario: Repo and preset edits do not lose each other
- **WHEN** a repo is added and a preset removed at the same time
- **THEN** the file holds both changes

#### Scenario: Port assignment recomputed after a concurrent edit
- **WHEN** a port assignment for host `a` read a file where the highest held port is 7420, and before it replaced the file another writer gave host `b` the `port` 7421
- **THEN** the assignment starts over and gives `a` the `port` 7422, and `b` keeps 7421

#### Scenario: Editor reset removes the key
- **WHEN** `config.json` holds `editor`, `repos` and `presets` and a session resets the editor command
- **THEN** the file no longer holds `editor`, and `repos` and `presets` are unchanged as written

## ADDED Requirements

### Requirement: Editing the editor command
`setEditor{req, command}` SHALL set the top-level `editor` to `command`, and `setEditor{req, command: null}` SHALL remove it, each as a configuration edit. The requester SHALL receive `done`, and only then, if the file changed, every open session `editor` with the resulting editor command, `kate` when `editor` was removed. A `setEditor` that leaves the file as it is — the same command, or a reset of a file without `editor` — SHALL answer `done`, leave the file unchanged and send no `editor`. The edited command SHALL survive a hub restart.

#### Scenario: Command set
- **WHEN** two sessions are open and one sends `setEditor` with `command` `code {path}`
- **THEN** the requester receives `done`, both sessions then receive `editor` with `code {path}`, and `config.json` holds `editor` `code {path}`

#### Scenario: Command reset
- **WHEN** `config.json` holds `editor` `code {path}` and a session sends `setEditor` with `command` null
- **THEN** the requester receives `done`, every open session receives `editor` with `kate`, and `config.json` holds no `editor`

#### Scenario: Reset without an override
- **WHEN** `config.json` holds no `editor` and a session sends `setEditor` with `command` null
- **THEN** it receives `done`, no session receives `editor`, and the file is unchanged

#### Scenario: Command survives a restart
- **WHEN** a session sets the command `subl {path}` and the hub restarts
- **THEN** a new session receives `editor` with `subl {path}`

#### Scenario: Another page's edit used for the next launch
- **WHEN** session A sets the command to a program that writes its arguments to a file, and session B then sends `openEditor`
- **THEN** the hub starts that program for B's request

### Requirement: Opening a worktree in an editor
`openEditor{req, worktree}` SHALL start the session's editor command on the hub's machine, with the arguments the editor command yields for the path `worktree`, the path always being a single argument and no shell being involved, in a new session of its own, with `worktree` as its working directory, standard input from `/dev/null` and its output discarded, without waiting for it to exit. When a lasting user manager is reachable, the started editor SHALL be moved into a transient scope of its own; a failure to do so SHALL be reported in the hub's log and SHALL NOT fail the request. Once the editor has started the hub SHALL answer `done`. When `worktree` is not an existing directory, before or after an attempt to start, the hub SHALL answer `error{req, host: null, code: editor-failed}` naming the path; when the program cannot be found it SHALL answer `error{req, host: null, code: editor-missing}` naming the program; any other failure to start SHALL answer `error{req, host: null, code: editor-failed}` with the reason. The editor's later exit SHALL NOT be observed.

#### Scenario: Path is one argument
- **WHEN** the editor command is a program that records its arguments followed by `--wait {path}`, and `openEditor` names the existing directory `/tmp/a b/$x;y`
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
- **WHEN** `openEditor` names a path that does not exist
- **THEN** the requester receives `error` with code `editor-failed` naming the path, not `editor-missing`

#### Scenario: Program not executable
- **WHEN** the editor command's program is a file without execute permission
- **THEN** the requester receives `error` with code `editor-failed`

#### Scenario: Editor in its own scope
- **WHEN** a lasting user manager is reachable and `openEditor` starts the editor
- **THEN** the editor runs in a transient scope of its own, not in the hub's
