## MODIFIED Requirements

### Requirement: Request checks and headers
Every HTTP request and WebSocket upgrade SHALL carry exactly one `Host` header of the form `127.0.0.1:<port>`, `<port>` a decimal integer from 1 to 65535 without leading zeros; any other request SHALL be refused with status 403. Any port is accepted so that a loopback port forwarded from another host reaches the hub. Every response SHALL carry `Content-Security-Policy: default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; object-src 'none'`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.

#### Scenario: Foreign Host refused
- **WHEN** a request carries `Host: localhost:<port>`, `Host: evil.example`, `Host: 127.0.0.1` or `Host: 127.0.0.1:07417`
- **THEN** the response status is 403

#### Scenario: Duplicate Host refused
- **WHEN** a request carries two `Host` headers
- **THEN** the response status is 403

#### Scenario: Forwarded port accepted
- **WHEN** a hub listening on port 7417 receives `GET /` with `Host: 127.0.0.1:7420`
- **THEN** it serves `index.html` with status 200

#### Scenario: Security headers present
- **WHEN** `index.html` is requested
- **THEN** the response carries the content security policy, `nosniff` and `no-referrer` headers above

### Requirement: Hub identity and shutdown
`GET /api/identity` with the token SHALL return the hub's package version and `instance`. `POST /api/shutdown` with the token SHALL answer and then shut the hub down as `SIGTERM` does. Both, and `POST /api/code`, SHALL refuse a request without the valid token with status 401, and a request carrying an `Origin` other than `http://` followed by the request's own `Host` value with status 403.

#### Scenario: Identity reported
- **WHEN** identity is requested with the token
- **THEN** the response names the hub's version and the instance in its hub record

#### Scenario: Shutdown requires the token
- **WHEN** shutdown is requested without the token
- **THEN** the response status is 401 and the hub keeps running

#### Scenario: Cross-origin API request refused
- **WHEN** identity is requested with the token, `Host: 127.0.0.1:7420` and `Origin: http://127.0.0.1:7417`
- **THEN** the response status is 403

### Requirement: WebSocket authentication
A WebSocket upgrade SHALL be accepted only at `/ws`, with exactly one `Origin` header equal to `http://` followed by the request's own `Host` value, and a `Sec-WebSocket-Protocol` list that, parsed as exact comma-separated tokens, holds `wtd` and exactly one credential: `wtd.token.<token>` with the hub token, or `wtd.code.<code>` with a valid unused code, which the accepted upgrade consumes. The hub SHALL select the subprotocol `wtd` and SHALL never record the offered subprotocols. A refused upgrade SHALL get status 401 for a missing or invalid credential and 403 otherwise. The largest accepted browser message SHALL be `MAX_FRAME` bytes.

#### Scenario: Missing or wrong Origin refused
- **WHEN** an upgrade with the token carries no `Origin`, `Origin: http://evil.example`, or `Host: 127.0.0.1:7420` with `Origin: http://127.0.0.1:8080`
- **THEN** it is refused with status 403

#### Scenario: Forwarded origin accepted
- **WHEN** a hub listening on port 7417 receives an upgrade with the token, `Host: 127.0.0.1:7420` and `Origin: http://127.0.0.1:7420`
- **THEN** it is accepted and the session greets

#### Scenario: Wrong credential refused
- **WHEN** an upgrade carries a wrong token, a credential with a different prefix or suffix, two credentials, or none
- **THEN** it is refused and no session starts

#### Scenario: Code used once
- **WHEN** two upgrades present the same valid code
- **THEN** exactly one is accepted

#### Scenario: Expired code refused
- **WHEN** an upgrade presents a code issued more than 30 s earlier
- **THEN** it is refused with status 401

#### Scenario: Oversized browser message closes the session
- **WHEN** a browser sends a message of `MAX_FRAME` + 1 bytes
- **THEN** the session is closed

### Requirement: Configuration
The configuration SHALL be `config.json` holding a JSON object with optional `port` (an integer from 1024 to 65535, default 7417), optional `repos` (at most 256 paths, each absolute or starting with `~/`, which is expanded against the home directory without resolving symbolic links), optional `roots` (1 to 32 discovery roots, each an absolute path, `~`, or `~/` followed by at least one character; default `["~"]`; never expanded by the hub), optional `presets` (1 to 64 objects `{name, command}`, each name 1–64 characters with at least one non-whitespace character and unique by exact comparison, each `command` null or 1–4096 characters) and optional `hosts` (at most 63 objects `{name, ssh, port, repos, roots}`, `port`, `repos` and `roots` optional). A host's `name` SHALL be 1–64 characters from `[A-Za-z0-9._-]`, unique among hosts; its `ssh` alias SHALL be 1–255 characters without whitespace or control characters and SHALL NOT start with `-`; its `port` SHALL be an integer from 1024 to 65535, unique among hosts and different from the hub's `port` (its default included); its `repos` SHALL be at most 256 absolute paths; its `roots` SHALL follow the rules and default of the top-level `roots`. The top-level `repos` and `roots` SHALL belong to the local host. Any other key, in the object, in a preset or in a host, SHALL make it invalid. Without `presets` the presets SHALL be exactly `[{name: "shell", command: null}, {name: "claude", command: "claude"}, {name: "codex", command: "codex"}]`; with it, exactly the listed presets in their order. A missing file SHALL mean the defaults; the hub SHALL create it only to record a repo or preset edit from the page. An invalid configuration at start SHALL fail the start with one line naming the file and the first problem. Each new browser session SHALL use a snapshot of the configuration read when it starts; if that read is invalid, the session SHALL receive `error{req: null, host: null, code: internal}` naming the problem and use the last valid configuration. A changed port SHALL take effect only when the hub restarts.

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

#### Scenario: Clashing host ports refused
- **WHEN** two hosts have `port` 7420, or a host has `port` 7417 while the top-level `port` is absent
- **THEN** the start fails with a line naming the file and `port`

#### Scenario: Edit picked up by a new session
- **WHEN** a repo or a preset is added to `config.json` by hand while a session is open, and a new session starts
- **THEN** the new session's `hosts` lists the repo, its `presets` lists the preset, and the open session's do not change

#### Scenario: Invalid edit keeps the last valid configuration
- **WHEN** `config.json` becomes invalid and a new session starts
- **THEN** that session receives an `internal` error and the repos and presets of the last valid configuration

### Requirement: Configuration edits
A configuration edit — a repo edit, a preset edit or a host port assignment — SHALL read the current `config.json` (an absent file read as `{}`), change only the edited value — for a repo edit the `repos` of the edited host, the top-level `repos` for the local host, otherwise those of the host entry with the session's host name; for a preset edit the top-level `presets`, starting from the default presets when the file has none; for a port assignment the `port` of the named host entry — keeping every other value as written, and replace the file atomically with an owner-only file holding the result as JSON indented by 2 spaces. It SHALL fail with `error{code: internal}` naming the problem when the current file is invalid, no longer lists the host of a repo edit, the result would hold more than 256 repos for the host, or a preset edit is refused. If the file changed between the read and the replacement, the edit SHALL start over from the changed file, recomputing its result, at most 3 times in all, and then fail with `error{code: internal}`. Edits of every kind SHALL be applied one at a time. After a repo edit, every open session whose snapshot lists that host SHALL have the host's repos replaced by those of the edited file, `~/` expanded, and receive `hosts`; after a preset edit that changed the file, every open session SHALL receive `presets` with the edited presets; nothing else in any session's snapshot SHALL change.

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

### Requirement: Session end and hub shutdown
When a session's WebSocket closes, the hub SHALL close that session's links and end any hub opening that session started, killing its SSH process; terminals SHALL keep running. On `SIGTERM`, `SIGINT` or an authenticated shutdown request the hub SHALL close every session with WebSocket code 1001, close all links, close every hub tunnel listener and end every forward, stop listening, remove its hub record and exit 0.

#### Scenario: Closing the browser keeps terminals
- **WHEN** a browser with an attached terminal closes its session and a new session watches the repo
- **THEN** the terminal is listed and still running

#### Scenario: Shutdown closes sessions
- **WHEN** the hub receives `SIGTERM` with a session open
- **THEN** the session is closed with code 1001 and the hub exits 0

#### Scenario: Shutdown closes tunnels
- **WHEN** the hub receives `SIGTERM` while a hub tunnel listener is bound and one forward is open
- **THEN** the listener's port accepts no more connections, the forward's SSH process exits, and the hub exits 0

## ADDED Requirements

### Requirement: Host port assignment
Opening a remote host's hub SHALL use that host's `port` from the current `config.json`. A host without `port` SHALL first be assigned one by a configuration edit: one more than the highest of the hub's `port` and every host's `port`; when that exceeds 65535, the lowest port from 1024 upward that is neither the hub's `port` nor any host's `port`; when no such port exists, the opening SHALL fail with `hub-failed` saying there is no free port for the host. A host's `port` that is present SHALL never be changed by the hub.

#### Scenario: First port above the hub's
- **WHEN** the hub's `port` is 7417, no host has a `port`, and host `box` is opened
- **THEN** `config.json` gives `box` the `port` 7418, keeping every other value as written

#### Scenario: Next port above the highest held
- **WHEN** hosts hold ports 7418 and 7425 and host `new` without a port is opened
- **THEN** `new` is given 7426

#### Scenario: Removed host's port not reused while a higher one is held
- **WHEN** hosts `a` (7418) and `b` (7419) exist, `a` is removed from `config.json`, and host `c` is opened
- **THEN** `c` is given 7420

#### Scenario: Wrap-around search
- **WHEN** the hub's `port` is 65535, host `a` holds 1024, and host `b` without a port is opened
- **THEN** `b` is given 1025

#### Scenario: Hand-written port kept
- **WHEN** host `box` has `port` 9000 in `config.json` and is opened
- **THEN** the hub forwards port 9000 for it and the file is unchanged

### Requirement: Opening a remote hub
`openHub{req, host}` SHALL open the hub of the remote host at index `host` of the session's `hosts`, its name, `ssh` alias and `port` read afresh from the current valid `config.json` by the host's name; a local host index, an index outside the snapshot, or a host no longer configured SHALL reply `error{code: unknown-host}`. The hub SHALL run `"$HOME/.local/bin/wtd" ui --print-code` on the host over SSH with the same options as a remote link, reading its standard error as it is written: a Tailscale check login URL, recognised as for a remote link, SHALL be sent once per URL as `hubLogin{req, login}`. Without such a URL the run SHALL be ended after 30 s, replying `error{code: hub-failed}` saying the host did not answer within 30 s; after one, no time limit SHALL apply until SSH ends. Standard output beyond 4096 bytes SHALL end the run with `hub-failed`. An exit status of 127 or 2, or status 0 with output that is not exactly one print-code line, SHALL reply `error{code: hub-outdated}` saying `wtd` on the host is missing or too old to serve its hub; any other failure SHALL reply `error{code: hub-failed}` with SSH's last standard error line or, without one, the exit status. On success the hub SHALL make sure a tunnel listener for the host is bound on `127.0.0.1:<port>` forwarding to the printed remote port, failing with `hub-failed` saying the port is in use when another process holds it; then fetch `GET /` through that listener, failing with `hub-failed` and the forward's last standard error line unless it answers 200 within 10 s; and then reply `hubOpened{req, url}` with `url` = `http://127.0.0.1:<port>/#` followed by the remote page fragment carrying the printed code, the host's name, the hub's own port, and the names of every configured remote host in configuration order. Every error reply SHALL carry the host's index. A session SHALL have at most one opening in progress: a new `openHub` SHALL end the previous one, killing its SSH process, and an ended opening SHALL change no listener and send nothing further.

#### Scenario: Remote hub opened
- **WHEN** host 1 is `box` with no `port`, the hub listens on 7417, `wtd ui --print-code` on `box` prints port 7417 and a code, and the browser sends `openHub{req: 4, host: 1}`
- **THEN** `config.json` gives `box` the `port` 7418, the browser receives `hubOpened{req: 4}` whose `url` starts `http://127.0.0.1:7418/#code=` and names `box` and home port 7417, and `GET /` and a WebSocket upgrade with that code through `127.0.0.1:7418` reach `box`'s hub

#### Scenario: Login link while opening
- **WHEN** the SSH process for `openHub` writes `# To authenticate, visit: https://login.tailscale.com/a/abc123` to standard error, and is released 40 s later
- **THEN** the browser receives `hubLogin` with that URL, and then `hubOpened`, with no `hub-failed` in between

#### Scenario: Too old remote
- **WHEN** `wtd ui --print-code` on the host exits with status 2, or the host has no `wtd` and the shell exits with status 127
- **THEN** the browser receives `error` with code `hub-outdated` and the host's index, and no listener is bound

#### Scenario: Unreachable host
- **WHEN** SSH writes `ssh: Could not resolve hostname box: Name or service not known` and exits with status 255
- **THEN** the browser receives `error` with code `hub-failed` whose message is that line

#### Scenario: Silent host times out
- **WHEN** the SSH process prints nothing for 30 s
- **THEN** it is killed and the browser receives `error` with code `hub-failed`

#### Scenario: Oversized output refused
- **WHEN** `wtd ui --print-code` writes 5000 bytes to standard output
- **THEN** the SSH process is killed and the browser receives `error` with code `hub-failed`

#### Scenario: Port held by another process
- **WHEN** host `box` has `port` 7418 and another process listens on 127.0.0.1:7418
- **THEN** the browser receives `error` with code `hub-failed` naming port 7418

#### Scenario: Forward refused
- **WHEN** the SSH forward for the probe writes `channel 0: open failed: administratively prohibited` and exits
- **THEN** the browser receives `error` with code `hub-failed` whose message is that line

#### Scenario: Newer open supersedes the previous one
- **WHEN** a session sends `openHub` for host 1, whose SSH process waits, and then `openHub` for host 2
- **THEN** host 1's SSH process is killed, no listener for host 1 is bound, and the session receives replies only for host 2's request

#### Scenario: Local host refused
- **WHEN** the browser sends `openHub` for host 0
- **THEN** it receives `error` with code `unknown-host`

### Requirement: Hub tunnels
A tunnel listener SHALL listen on `127.0.0.1` only. Each connection it accepts SHALL be relayed byte for byte, both ways, to `127.0.0.1:<remote port>` on its host through one SSH process (`ssh -W`) started for that connection with the same options as a remote link; when either side ends, both SHALL end, the SSH process being terminated as a remote link's is. The hub SHALL buffer no more than the relay's stream buffers. At most one listener SHALL exist per port; binding, rebinding and closing listeners SHALL happen one at a time. Opening a host whose listener forwards to another remote port SHALL repoint it; a host whose `port` changed SHALL get a new listener on its new port and its old listener SHALL be closed with its forwards. A connection accepted while the listener's host, alias or port no longer matches the configuration the hub last read SHALL be closed at once without starting SSH. Listeners SHALL stay bound until the hub stops or their mapping changes.

#### Scenario: Leaving the page ends its forwards
- **WHEN** a page served through a tunnel listener is closed
- **THEN** every SSH process started for its connections exits

#### Scenario: Two sessions share one listener
- **WHEN** two sessions each open host `box`
- **THEN** each runs its own `wtd ui --print-code` and both URLs name the same port, served by one listener

#### Scenario: Removed host's listener refuses connections
- **WHEN** host `box` was opened, is then removed from `config.json`, and a session starts
- **THEN** a connection to `box`'s port is closed without starting an SSH process

### Requirement: Installing for a hub
`installHub{req, host}` for a remote host SHALL install the hub's own bundle on that host as `wtd install-remote` does, within 120 s, and reply `done`, never restarting or shutting down a daemon; a failure SHALL reply `error{code: internal}` naming the cause; a local host index SHALL reply `error{code: unknown-host}`. Installs SHALL be coordinated with the host's restarts and reinstalls, from any sessions, so that no two of them run at once: an install SHALL share a running or queued install or reinstall of that host; a restart or reinstall requested while an install runs or is queued SHALL wait until it ends; an install requested while a restart runs SHALL wait until the restart ends.

#### Scenario: Install leaves the daemon running
- **WHEN** a remote host's daemon of another version runs a terminal and the browser sends `installHub`
- **THEN** the hub's bundle is installed there, the browser receives `done`, and the terminal keeps running in the same daemon instance

#### Scenario: Install shares a running reinstall
- **WHEN** a `reinstallDaemon` for host 1 is running and another session sends `installHub` for host 1
- **THEN** only one installation runs and both requests are answered when it ends

#### Scenario: Restart waits for an install
- **WHEN** an `installHub` for host 1 is running and a `restartDaemon` for host 1 arrives
- **THEN** the restart starts only after the install ended
