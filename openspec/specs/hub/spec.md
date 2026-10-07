# hub Specification

## Purpose
The local gateway between the browser UI and every daemon: it serves the UI on loopback only, authenticates every browser session, and relays each session's traffic to the daemons over links of its own, without holding state other than its configuration.

## Requirements

### Requirement: Loopback listener and single instance
The hub SHALL listen only on `127.0.0.1` at the configured port. It SHALL bind while holding the hub start lock, then write the hub record `{pid, port, instance}` (`instance` random per process start) and release the lock. A hub record whose hub answers an authenticated identity request SHALL make a new hub refuse to start as already running. On exit the hub SHALL remove the hub record only if it still names its own `instance`.

#### Scenario: Loopback only
- **WHEN** the hub is running
- **THEN** its only listening TCP socket is bound to `127.0.0.1` at the configured port

#### Scenario: Record written and removed
- **WHEN** a hub starts and later exits on `SIGTERM`
- **THEN** the hub record names its pid, port and instance while it runs, and no hub record remains after it exits

### Requirement: Persistent token
The hub token SHALL be 32 random bytes as 64 lowercase hex digits in the owner-only `hub-token` file, created on first start and kept across restarts. A token path that is not a regular file or is owned by another user SHALL fail the start. A token file with a looser mode SHALL be tightened to 0600. A missing or malformed token SHALL be replaced atomically by a new one.

#### Scenario: Token persists across restarts
- **WHEN** the hub is restarted
- **THEN** it accepts the same token as before

#### Scenario: Symbolic link refused
- **WHEN** `hub-token` is a symbolic link
- **THEN** the hub does not start and names the token path

#### Scenario: Loose mode tightened
- **WHEN** `hub-token` holds a valid token with mode 0644
- **THEN** the hub starts, keeps the token, and the file's mode becomes 0600

#### Scenario: Malformed token replaced
- **WHEN** `hub-token` holds text that is not 64 lowercase hex digits
- **THEN** the hub starts with a new valid token in the file

### Requirement: Request checks and headers
Every HTTP request and WebSocket upgrade SHALL carry exactly one `Host` header equal to `127.0.0.1:<port>`; any other request SHALL be refused with status 403. Every response SHALL carry `Content-Security-Policy: default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; object-src 'none'`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.

#### Scenario: Foreign Host refused
- **WHEN** a request carries `Host: localhost:<port>` or `Host: evil.example`
- **THEN** the response status is 403

#### Scenario: Duplicate Host refused
- **WHEN** a request carries two `Host` headers
- **THEN** the response status is 403

#### Scenario: Security headers present
- **WHEN** `index.html` is requested
- **THEN** the response carries the content security policy, `nosniff` and `no-referrer` headers above

### Requirement: Static bundle
The hub SHALL serve exactly the files of the web bundle present at its start, `/` serving `index.html`. `index.html` SHALL be served with `Cache-Control: no-cache` and every other bundle file with `Cache-Control: public, max-age=31536000, immutable`. Any other path SHALL get status 404. A missing web bundle SHALL fail the start.

#### Scenario: Index not cached
- **WHEN** `/` is requested
- **THEN** `index.html` is returned with `Cache-Control: no-cache`

#### Scenario: Traversal refused
- **WHEN** `/../package.json` or `/%2e%2e/package.json` is requested
- **THEN** the response status is 404

### Requirement: One-time codes
`POST /api/code` with `Authorization: Bearer <token>` and no `Origin` header other than the hub's own SHALL return a code response with `Cache-Control: no-store`. A code SHALL be valid for one successful use within 30 s of its issue; at most 16 codes SHALL be outstanding, issuing another invalidating the oldest. A request without the valid token SHALL get status 401. A request body over 1 KiB SHALL be refused.

#### Scenario: Code issued
- **WHEN** the CLI requests a code with the token
- **THEN** the response is a code response with `Cache-Control: no-store`

#### Scenario: Wrong token refused
- **WHEN** a code is requested with a wrong token or without one
- **THEN** the response status is 401

#### Scenario: Cross-origin request refused
- **WHEN** a code is requested with the token and `Origin: http://evil.example`
- **THEN** the response status is 403

### Requirement: Hub identity and shutdown
`GET /api/identity` with the token SHALL return the hub's package version and `instance`. `POST /api/shutdown` with the token SHALL answer and then shut the hub down as `SIGTERM` does. Both SHALL refuse a request without the valid token with status 401 and an `Origin` other than the hub's own with status 403.

#### Scenario: Identity reported
- **WHEN** identity is requested with the token
- **THEN** the response names the hub's version and the instance in its hub record

#### Scenario: Shutdown requires the token
- **WHEN** shutdown is requested without the token
- **THEN** the response status is 401 and the hub keeps running

### Requirement: WebSocket authentication
A WebSocket upgrade SHALL be accepted only at `/ws`, with exactly one `Origin` header equal to `http://127.0.0.1:<port>`, and a `Sec-WebSocket-Protocol` list that, parsed as exact comma-separated tokens, holds `wtd` and exactly one credential: `wtd.token.<token>` with the hub token, or `wtd.code.<code>` with a valid unused code, which the accepted upgrade consumes. The hub SHALL select the subprotocol `wtd` and SHALL never record the offered subprotocols. A refused upgrade SHALL get status 401 for a missing or invalid credential and 403 otherwise. The largest accepted browser message SHALL be `MAX_FRAME` bytes.

#### Scenario: Missing or wrong Origin refused
- **WHEN** an upgrade with the token carries no `Origin`, or `Origin: http://evil.example`
- **THEN** it is refused with status 403

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

### Requirement: Browser session handshake
On an accepted upgrade the hub SHALL send `hello` with `protocol` equal to `PROTOCOL_VERSION`, its package version and its `instance`, then, if the session authenticated with a code, `token{token}`. After the browser's `hello` it SHALL send `presets` with the presets of the session's configuration snapshot, then `hosts`. A message before the browser's `hello` SHALL get `error{req: null, host: null, code: bad-message}` and close the session; a browser `hello` with another `protocol` SHALL get `error{req: null, host: null, code: version-mismatch}` and close it.

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

### Requirement: Malformed browser traffic
After the handshake, a message that fails to decode, a second `hello`, or an output or snapshot frame from the browser SHALL get `error{req: null, host: null, code: bad-message}` and close that session only.

#### Scenario: Malformed message closes one session
- **WHEN** one of two sessions sends invalid JSON
- **THEN** that session is closed and the other keeps working

### Requirement: Configuration
The configuration SHALL be `config.json` holding a JSON object with optional `port` (an integer from 1024 to 65535, default 7417), optional `repos` (at most 256 paths, each absolute or starting with `~/`, which is expanded against the home directory without resolving symbolic links), optional `roots` (1 to 32 discovery roots, each an absolute path, `~`, or `~/` followed by at least one character; default `["~"]`; never expanded by the hub), optional `presets` (1 to 64 objects `{name, command}`, each name 1–64 characters with at least one non-whitespace character and unique by exact comparison, each `command` null or 1–4096 characters) and optional `hosts` (at most 63 objects `{name, ssh, repos, roots}`, `repos` and `roots` optional). A host's `name` SHALL be 1–64 characters from `[A-Za-z0-9._-]`, unique among hosts; its `ssh` alias SHALL be 1–255 characters without whitespace or control characters and SHALL NOT start with `-`; its `repos` SHALL be at most 256 absolute paths; its `roots` SHALL follow the rules and default of the top-level `roots`. The top-level `repos` and `roots` SHALL belong to the local host. Any other key, in the object, in a preset or in a host, SHALL make it invalid. Without `presets` the presets SHALL be exactly `[{name: "shell", command: null}]`; with it, exactly the listed presets in their order. A missing file SHALL mean the defaults; the hub SHALL create it only to record a repo added from the page. An invalid configuration at start SHALL fail the start with one line naming the file and the first problem. Each new browser session SHALL use a snapshot of the configuration read when it starts; if that read is invalid, the session SHALL receive `error{req: null, host: null, code: internal}` naming the problem and use the last valid configuration. A changed port SHALL take effect only when the hub restarts.

#### Scenario: Defaults without a file
- **WHEN** no `config.json` exists and the hub starts
- **THEN** it listens on port 7417, lists no repos and no remote hosts, and sessions receive the single preset `shell` with command null

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
- **WHEN** a repo or a preset is added to `config.json` while a session is open, and a new session starts
- **THEN** the new session's `hosts` lists the repo, its `presets` lists the preset, and the open session's do not change

#### Scenario: Invalid edit keeps the last valid configuration
- **WHEN** `config.json` becomes invalid and a new session starts
- **THEN** that session receives an `internal` error and the repos and presets of the last valid configuration

### Requirement: Daemon links and host status
For each session the hub SHALL hold one link per host of its configuration snapshot: index 0 the local host, `remote` false, named by the host name truncated to 64 characters (`local` when empty); then each configured remote host in configuration order at indices 1 and up, `remote` true, named by its configured `name`. The local link SHALL dial this host's daemon, starting it when absent. A remote link SHALL run the SSH command for the host's alias with the remote command `"$HOME/.local/bin/wtd" connect` and exchange stream frames over that process's standard input and output exactly as over the daemon socket. Every link SHALL exchange `hello`. A daemon `hello` with the same `protocol` SHALL make the host `connected` with its `daemonVersion` and `instance`; another `protocol` SHALL make it `outdated` with its `daemonVersion` and `instance`, keeping the link open. A failed dial or a lost link SHALL make the host `reconnecting` and retry after 250 ms, doubling up to 5 s; after 3 consecutive failures it SHALL be `down` while retrying continues. A remote link SHALL be lost when its SSH process exits or its standard output ends. A host's `reason` SHALL name the cause of the latest failure while it is `reconnecting` or `down`, and be null otherwise: for a remote host, the last non-empty line the SSH process wrote to standard error, taken from a tail of at most 4 KiB with control characters removed and cut to 1024 characters, or else the process's exit status; for the local host, the dial error. Closing a remote link SHALL end its SSH process's standard input and terminate that process if it has not exited 1 s later, and SHALL signal no other process. Every change of a host entry SHALL be sent to the session as `hosts`.

#### Scenario: Local host connected
- **WHEN** a session starts and no daemon is running
- **THEN** a daemon is started and the session receives `hosts` with host 0 `connected` and the daemon's instance

#### Scenario: Daemon restart observed
- **WHEN** the local daemon is killed while a session is open
- **THEN** the session receives host 0 as `reconnecting`, then `connected` with a different instance

#### Scenario: Outdated daemon
- **WHEN** the local socket is served by a daemon speaking another protocol version
- **THEN** the session receives host 0 as `outdated` with that daemon's version and instance

#### Scenario: Remote host connected
- **WHEN** a host `box` is configured and its SSH command reaches an installed `wtd`
- **THEN** the session receives host 1 named `box`, `remote` true, `connected` with the remote daemon's instance and a null `reason`

#### Scenario: Killed SSH process reconnects to the same daemon
- **WHEN** the SSH process of a connected remote link is killed
- **THEN** the session receives host 1 as `reconnecting` and then `connected` with the same instance as before

#### Scenario: Down host names the cause
- **WHEN** the SSH command for a host fails three times in a row, writing `ssh: Could not resolve hostname box` to standard error
- **THEN** the session receives that host as `down` with `reason` `ssh: Could not resolve hostname box`

#### Scenario: Unbounded standard error stays bounded
- **WHEN** the SSH process writes 8 MiB to standard error without a newline and exits
- **THEN** the hub's resident memory grows by less than 16 MiB and the host's `reason` has at most 1024 characters

#### Scenario: Closing a session spares the shared SSH master
- **WHEN** a session whose remote link created the SSH control master closes, and another session then links to the same host
- **THEN** only the closed session's SSH process ends, and the new link connects through the still-running master

### Requirement: Routing
The hub SHALL forward a browser `host{host, m}` envelope's `m` to that host's link unchanged, and every daemon message other than `hello` to the session as `host{host, m}` unchanged, never rewriting request or terminal ids. It SHALL re-frame data frames between the stream and WebSocket encodings, adding or removing only the host index. It SHALL forward `ack` unchanged and never send an `ack` of its own. A request to a host that is not `connected` SHALL get `error{req, host, code}` with `version-mismatch` when the host is `outdated` and `host-unavailable` otherwise; `ack`, `resize`, `setVisible` and input for such a host SHALL be dropped. A message naming an unknown host index SHALL get `unknown-host`.

#### Scenario: Round trip through the hub
- **WHEN** a browser watches a repo, creates and attaches a terminal and types into it
- **THEN** it receives `repoState`, `termCreated`, the snapshot and the echoed output, each daemon message byte-identical inside its envelope

#### Scenario: Round trip to a remote host
- **WHEN** a browser does the same through host 1, a remote host
- **THEN** it receives the same messages inside envelopes for host 1

#### Scenario: Acks only from the browser
- **WHEN** a browser receives output and sends no `ack`
- **THEN** the daemon receives no `ack` for that terminal

#### Scenario: Request to an unavailable host
- **WHEN** a browser sends `host{host: 0, m: watchRepo}` while host 0 is `reconnecting`
- **THEN** it receives `error` with that `req`, host 0 and `host-unavailable`

#### Scenario: Unknown host
- **WHEN** a browser sends an envelope for host 5
- **THEN** it receives `error` with `unknown-host`

#### Scenario: Sessions are independent
- **WHEN** two sessions use the same request ids and watch the same repo
- **THEN** each receives only the replies to its own requests

### Requirement: Back-pressure
While a session's unsent WebSocket data is at least 1 MiB, the hub SHALL stop reading that session's links, and SHALL resume below 256 KiB; it SHALL keep forwarding the session's messages to its links meanwhile. Output bytes in flight through the hub per terminal SHALL therefore stay bounded by the daemon's flow window.

#### Scenario: Unacked output stays bounded
- **WHEN** a terminal floods output and the browser never acks
- **THEN** the browser receives at most `FLOW_HIGH` bytes plus one output chunk of that terminal's output

#### Scenario: Non-reading browser keeps the hub bounded
- **WHEN** 20 terminals flood output to a session that stops reading its WebSocket
- **THEN** the hub's resident memory grows by less than 64 MiB and other sessions keep receiving output

### Requirement: Daemon restart
`restartDaemon{req, host}` for a `connected` or `outdated` host, local or remote, SHALL send the daemon answering on that host the frozen `hello` and `shutdown`, then dial that host — starting a daemon when none serves — until a daemon whose `hello` has another `instance` and the hub's `protocol` answers, and then reply `done`; if that does not happen within 10 s it SHALL reply `error{code: internal}`. Only the frozen `hello` SHALL be decoded from a daemon being restarted. Restart and reinstall requests for one host, from any sessions, SHALL be coordinated: concurrent requests of the same kind SHALL share one run, a restart requested while a reinstall of that host runs SHALL share the reinstall, and any other request SHALL wait until the running one ends. For any other status it SHALL reply `host-unavailable`.

#### Scenario: Outdated daemon restarted
- **WHEN** host 0 is `outdated` and the browser sends `restartDaemon`
- **THEN** the old daemon exits, host 0 becomes `connected` with a new instance and the hub's protocol, and the browser receives `done`

#### Scenario: Newer daemon restarted
- **WHEN** host 0 is served by a daemon speaking protocol 6, whose messages after `hello` are not valid protocol-5 messages, and the browser sends `restartDaemon`
- **THEN** that daemon exits and host 0 becomes `connected` with a new instance and the hub's protocol

#### Scenario: Remote daemon restarted
- **WHEN** a remote host is `connected` and the browser sends `restartDaemon` for it
- **THEN** the remote daemon is replaced by a new instance and the browser receives `done`

#### Scenario: Concurrent restarts start one daemon
- **WHEN** two sessions send `restartDaemon` for host 0 at the same time
- **THEN** exactly one new daemon instance serves and both receive `done`

#### Scenario: Restart during a reinstall shares it
- **WHEN** a session sends `restartDaemon` for a remote host while another session's `reinstallDaemon` of that host runs
- **THEN** exactly one new daemon instance serves and both receive `done` when the reinstall ends

### Requirement: Session end and hub shutdown
When a session's WebSocket closes, the hub SHALL close that session's links; terminals SHALL keep running. On `SIGTERM`, `SIGINT` or an authenticated shutdown request the hub SHALL close every session with WebSocket code 1001, close all links, stop listening, remove its hub record and exit 0.

#### Scenario: Closing the browser keeps terminals
- **WHEN** a browser with an attached terminal closes its session and a new session watches the repo
- **THEN** the terminal is listed and still running

#### Scenario: Shutdown closes sessions
- **WHEN** the hub receives `SIGTERM` with a session open
- **THEN** the session is closed with code 1001 and the hub exits 0

### Requirement: Daemon reinstall
`reinstallDaemon{req, host}` for a remote host in any status SHALL install the hub's own bundle on that host as `wtd install-remote` does, within 120 s; then dial the host until a daemon answers whose `hello` carries the hub's package version and `protocol`, sending the frozen `hello` and `shutdown` to any daemon that answers with another version or protocol, within 10 s; and then reply `done`. A failure SHALL reply `error{code: internal}` with a message naming the failed step (`install` or `restart`) and its cause. For the local host it SHALL reply `error{code: internal}` saying the local daemon is restarted, not reinstalled. It SHALL be coordinated with restarts as the daemon restart requirement states.

#### Scenario: Outdated remote reinstalled
- **WHEN** a remote host runs a daemon of another protocol from an older installation and the browser sends `reinstallDaemon`
- **THEN** the hub's bundle is installed there, the old daemon exits, the host becomes `connected` with the hub's version and protocol, and the browser receives `done`

#### Scenario: Never-installed remote installed
- **WHEN** a remote host is `down` because `wtd` is not installed and the browser sends `reinstallDaemon`
- **THEN** `wtd` is installed there, the host becomes `connected`, and the browser receives `done`

#### Scenario: Installation failure reported
- **WHEN** the remote host has no Node of version 20 or later and the browser sends `reinstallDaemon`
- **THEN** the browser receives `error` with code `internal` and a message starting `install:` that names the missing Node

#### Scenario: Local host not reinstalled
- **WHEN** the browser sends `reinstallDaemon` for host 0
- **THEN** it receives `error` with code `internal` and no daemon is touched

### Requirement: Repo discovery through the hub
`discoverRepos{req, host}` for a `connected` host SHALL send that host's daemon, over a link of the hub's own, `discoverRepos` with the host's configured roots and depth 3, and reply `reposDiscovered{req, host, repos}` with the daemon's repos, or `error{req, host, code}` with the daemon's error code. For a host that is not `connected` it SHALL reply as routing does.

#### Scenario: Discovery uses the configured roots
- **WHEN** host 0's roots are `["~/src"]` and the browser sends `discoverRepos` for host 0
- **THEN** the daemon receives `discoverRepos` with roots `["~/src"]` and depth 3, and the browser receives `reposDiscovered` for host 0 with the repos found

#### Scenario: Discovery does not disturb the session
- **WHEN** a browser uses request id 7 for both a `host` envelope and a hub-level `discoverRepos`
- **THEN** it receives each reply exactly once, correlated with its own request

### Requirement: Adding repos
`addRepo{req, host, repo}` for a `connected` host SHALL check `repo` with `watchRepo` over a link of the hub's own, replying `error{req, host, code}` with the daemon's code if that fails; otherwise it SHALL add `repo` to that host's repos by a configuration edit and reply `done`. A repo already listed, as given or by a `~/` form expanding to it, SHALL reply `done` without an edit. For a host that is not `connected` it SHALL reply as routing does.

#### Scenario: Repo added
- **WHEN** the browser sends `addRepo` for host 0 with the path of a repository's main worktree
- **THEN** `config.json` lists the path, the browser receives `done`, and then `hosts` listing the repo for host 0

#### Scenario: Not a repo refused
- **WHEN** the browser sends `addRepo` with a directory that is not a repository's main worktree
- **THEN** it receives `error` with `not-a-repo` and `config.json` is unchanged

#### Scenario: Added repo reaches every session
- **WHEN** two sessions are open and one adds a repo to a remote host
- **THEN** both sessions receive `hosts` listing the repo for that host

### Requirement: Removing repos
`removeRepo{req, host, repo}` for a `connected` host SHALL `watchRepo` it over a link of the hub's own; if the daemon lists any terminal for the repo, running or exited, it SHALL reply `busy` and change nothing. A `not-a-repo` error SHALL NOT prevent the removal; any other error SHALL be replied with the daemon's code. It SHALL then remove every entry of that host's repos naming `repo`, as given or by a `~/` form expanding to it, by a configuration edit, and reply `done`; a repo not listed SHALL reply `done` without an edit. The terminal check SHALL be made once, before the edit. For a host that is not `connected` it SHALL reply as routing does.

#### Scenario: Repo removed
- **WHEN** the browser removes a repo without terminals that is listed as `~/app`
- **THEN** `config.json` no longer lists it, the browser receives `done`, and then `hosts` without it

#### Scenario: Repo with terminals refused
- **WHEN** the browser removes a repo that has a running terminal, or an exited terminal not yet closed
- **THEN** it receives `error` with `busy` and `config.json` is unchanged

#### Scenario: Deleted repo removed
- **WHEN** the browser removes a listed repo whose directory no longer exists
- **THEN** it is removed from `config.json` and the browser receives `done`

### Requirement: Configuration edits
A configuration edit SHALL read the current `config.json` (an absent file read as `{}`), change only the `repos` of the edited host — the top-level `repos` for the local host, otherwise those of the host entry with the session's host name — keeping every other value as written, and replace the file atomically with an owner-only file holding the result as JSON indented by 2 spaces. It SHALL fail with `error{code: internal}` naming the problem when the current file is invalid, no longer lists the host, or the result would hold more than 256 repos for the host. If the file changed between the read and the replacement, the edit SHALL start over, at most 3 times in all, and then fail with `error{code: internal}`. Edits SHALL be applied one at a time. After an edit, every open session whose snapshot lists that host SHALL have the host's repos replaced by those of the edited file, `~/` expanded, and receive `hosts`; nothing else in any session's snapshot SHALL change.

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
