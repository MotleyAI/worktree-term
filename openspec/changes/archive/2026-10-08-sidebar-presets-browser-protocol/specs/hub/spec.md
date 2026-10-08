## MODIFIED Requirements

### Requirement: Browser session handshake
On an accepted upgrade the hub SHALL send `hello` with `protocol` equal to `BROWSER_PROTOCOL_VERSION`, its package version and its `instance`, then, if the session authenticated with a code, `token{token}`. After the browser's `hello` it SHALL send `presets` with the presets of the session's configuration snapshot, then `hosts`. A message before the browser's `hello` SHALL get `error{req: null, host: null, code: bad-message}` and close the session; a browser `hello` with another `protocol` SHALL get `error{req: null, host: null, code: version-mismatch}` and close it.

#### Scenario: Code session receives the token
- **WHEN** a browser connects with a valid code
- **THEN** it receives `hello`, then `token` with the hub token

#### Scenario: Token session receives no token
- **WHEN** a browser connects with the token
- **THEN** it receives `hello` and no `token` message

#### Scenario: Presets before hosts
- **WHEN** a browser completes the handshake
- **THEN** it receives `presets` and then `hosts`

#### Scenario: Message before hello
- **WHEN** a browser's first message is a `host` envelope
- **THEN** it receives `error` with `bad-message` and the session closes

#### Scenario: Browser of another protocol refused
- **WHEN** a browser sends `hello` with `protocol` equal to `BROWSER_PROTOCOL_VERSION` + 1
- **THEN** it receives `error` with `version-mismatch` and the session closes

### Requirement: Configuration
The configuration SHALL be `config.json` holding a JSON object with optional `port` (an integer from 1024 to 65535, default 7417), optional `repos` (at most 256 paths, each absolute or starting with `~/`, which is expanded against the home directory without resolving symbolic links), optional `roots` (1 to 32 discovery roots, each an absolute path, `~`, or `~/` followed by at least one character; default `["~"]`; never expanded by the hub), optional `presets` (1 to 64 objects `{name, command}`, each name 1–64 characters with at least one non-whitespace character and unique by exact comparison, each `command` null or 1–4096 characters) and optional `hosts` (at most 63 objects `{name, ssh, repos, roots}`, `repos` and `roots` optional). A host's `name` SHALL be 1–64 characters from `[A-Za-z0-9._-]`, unique among hosts; its `ssh` alias SHALL be 1–255 characters without whitespace or control characters and SHALL NOT start with `-`; its `repos` SHALL be at most 256 absolute paths; its `roots` SHALL follow the rules and default of the top-level `roots`. The top-level `repos` and `roots` SHALL belong to the local host. Any other key, in the object, in a preset or in a host, SHALL make it invalid. Without `presets` the presets SHALL be exactly `[{name: "shell", command: null}, {name: "claude", command: "claude"}, {name: "codex", command: "codex"}]`; with it, exactly the listed presets in their order. A missing file SHALL mean the defaults; the hub SHALL create it only to record a repo or preset edit from the page. An invalid configuration at start SHALL fail the start with one line naming the file and the first problem. Each new browser session SHALL use a snapshot of the configuration read when it starts; if that read is invalid, the session SHALL receive `error{req: null, host: null, code: internal}` naming the problem and use the last valid configuration. A changed port SHALL take effect only when the hub restarts.

#### Scenario: Defaults without a file
- **WHEN** no `config.json` exists and the hub starts
- **THEN** it listens on port 7417, lists no repos and no remote hosts, and sessions receive the presets `shell` (command null), `claude` (command `claude`) and `codex` (command `codex`), in that order

#### Scenario: Unknown key refused
- **WHEN** `config.json` holds the key `theme` and the hub starts
- **THEN** the start fails with a line naming the file and `theme`

#### Scenario: Configured presets replace the default
- **WHEN** `config.json` lists presets `claude` (command `claude`) and `shell` (command null), in that order
- **THEN** sessions receive exactly those two presets in that order

#### Scenario: Invalid presets refused
- **WHEN** `config.json` holds an empty `presets` list, two presets named `a`, or a preset whose command is ""
- **THEN** the start fails with a line naming the file and `presets`

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

#### Scenario: Edit picked up by a new session
- **WHEN** a repo or a preset is added to `config.json` by hand while a session is open, and a new session starts
- **THEN** the new session's `hosts` lists the repo, its `presets` lists the preset, and the open session's do not change

#### Scenario: Invalid edit keeps the last valid configuration
- **WHEN** `config.json` becomes invalid and a new session starts
- **THEN** that session receives an `internal` error and the repos and presets of the last valid configuration

### Requirement: Configuration edits
A configuration edit — a repo edit or a preset edit — SHALL read the current `config.json` (an absent file read as `{}`), change only the edited list — for a repo edit the `repos` of the edited host, the top-level `repos` for the local host, otherwise those of the host entry with the session's host name; for a preset edit the top-level `presets`, starting from the default presets when the file has none — keeping every other value as written, and replace the file atomically with an owner-only file holding the result as JSON indented by 2 spaces. It SHALL fail with `error{code: internal}` naming the problem when the current file is invalid, no longer lists the host of a repo edit, the result would hold more than 256 repos for the host, or a preset edit is refused. If the file changed between the read and the replacement, the edit SHALL start over, at most 3 times in all, and then fail with `error{code: internal}`. Edits of either kind SHALL be applied one at a time. After a repo edit, every open session whose snapshot lists that host SHALL have the host's repos replaced by those of the edited file, `~/` expanded, and receive `hosts`; after a preset edit that changed the file, every open session SHALL receive `presets` with the edited presets; nothing else in any session's snapshot SHALL change.

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

## ADDED Requirements

### Requirement: Editing presets
`addPreset{req, preset}` SHALL append the preset to the presets and `removePreset{req, name}` SHALL remove the preset of exactly that name, each as a configuration edit. The requester SHALL receive `done`, and only then every open session `presets`. `addPreset` SHALL be refused with `error{req, host: null, code: internal}` naming the reason when a preset of that name exists or there would be more than 64 presets; `removePreset` SHALL be refused that way when it would remove the last preset. A `removePreset` naming no preset SHALL answer `done`, leave the file unchanged and send no `presets`.

#### Scenario: Preset added
- **WHEN** a session adds the preset `htop` (command `htop`) while `config.json` lists `shell` and two sessions are open
- **THEN** the requester receives `done`, both sessions then receive `presets` listing `shell` and `htop`, and `config.json` lists both

#### Scenario: Preset removed from the defaults
- **WHEN** `config.json` has no `presets` and a session removes `claude`
- **THEN** `config.json` lists `shell` and `codex`, and every open session receives those presets

#### Scenario: Taken name refused
- **WHEN** a session adds a preset named `shell` while `shell` exists
- **THEN** it receives `error` with code `internal` saying a preset named `shell` exists, and the file is unchanged

#### Scenario: Last preset kept
- **WHEN** `config.json` lists only `shell` and a session removes it
- **THEN** it receives `error` with code `internal` saying the last preset cannot be removed, and the file is unchanged

#### Scenario: Unknown name
- **WHEN** a session removes a preset named `nope` that does not exist
- **THEN** it receives `done`, no session receives `presets`, and the file is unchanged
