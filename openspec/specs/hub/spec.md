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

### Requirement: Malformed browser traffic
After the handshake, a message that fails to decode, a second `hello`, or an output or snapshot frame from the browser SHALL get `error{req: null, host: null, code: bad-message}` and close that session only.

#### Scenario: Malformed message closes one session
- **WHEN** one of two sessions sends invalid JSON
- **THEN** that session is closed and the other keeps working

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
- **WHEN** host 0 is served by a daemon speaking a newer protocol than the hub's, whose messages after `hello` are not valid messages of the hub's protocol, and the browser sends `restartDaemon`
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

### Requirement: Editing presets
`addPreset{req, preset}` SHALL append the preset to the presets, `removePreset{req, name}` SHALL remove the preset of exactly that name and `movePreset{req, name, to}` SHALL move the preset of exactly that name to position `to`, or to the last position when `to` is beyond it, each as a configuration edit. The requester SHALL receive `done`, and only then every open session `presets`. `addPreset` SHALL be refused with `error{req, host: null, code: internal}` naming the reason when a preset of that name exists or there would be more than 64 presets; `removePreset` SHALL be refused that way when it would remove the last preset. A `removePreset` or `movePreset` naming no preset, and a `movePreset` to the preset's own position, SHALL answer `done`, leave the file unchanged and send no `presets`.

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

#### Scenario: Preset moved
- **WHEN** `config.json` lists `shell`, `claude` and `htop`, two sessions are open and one moves `htop` to position 0
- **THEN** the requester receives `done`, both sessions then receive `presets` listing `htop`, `shell` and `claude`, and `config.json` lists them in that order

#### Scenario: Move beyond the end
- **WHEN** a session moves the first of three presets to position 63
- **THEN** it becomes the last preset

### Requirement: Tailscale SSH check login
While a remote link has received no frame from its daemon, the hub SHALL read its SSH process's standard error as it is written, line by line. A line containing `To authenticate, visit:` followed by a URL that, with control characters removed, starts with `https://login.tailscale.com/` and has at most 1024 characters SHALL make the host `needs-login` with that URL as `login`, within 1 s of being written, with `reason`, `daemonVersion` and `instance` null, keeping the link open and counting no failure. A line naming any other URL SHALL change nothing, as SHALL a repeat of the URL the host already shows. Standard error read after the link's first daemon frame, after the link was closed or ended, or after the link was replaced SHALL change no host. A `needs-login` host SHALL become `connected` or `outdated` when its link exchanges `hello`, and `reconnecting` or `down` when its link is lost, as for any other link, counting the consecutive failures from before it was `needs-login`; `login` SHALL be null in every status other than `needs-login`. A request for a `needs-login` host SHALL fail with `host-unavailable`. When a link of one session to a host exchanges `hello`, every other session's link to the same host that is `needs-login` SHALL be closed and at once replaced by a new link, that session's host becoming `connecting` with `login` null; links of other sessions in any other status SHALL be left alone.

#### Scenario: Login link surfaced
- **WHEN** the SSH process for host `box` writes `# Tailscale SSH requires an additional check.` and `# To authenticate, visit: https://login.tailscale.com/a/abc123` to standard error and then waits
- **THEN** within 1 s the session receives `box` as `needs-login` with `login` `https://login.tailscale.com/a/abc123` and a null `reason`, and no second SSH process is started

#### Scenario: Approval connects without retry
- **WHEN** a `needs-login` host's waiting SSH process proceeds and the daemon greets
- **THEN** the session receives the host as `connected` with a null `login`, over the same SSH process

#### Scenario: Other URL ignored
- **WHEN** the SSH process for a host writes `To authenticate, visit: https://login.tailscale.com.evil/a/x` to standard error and waits
- **THEN** the host stays `connecting`

#### Scenario: Expired check falls back to retrying
- **WHEN** a `needs-login` host's SSH process exits writing `Tailscale SSH check timed out` to standard error, and the next SSH process writes a new login URL
- **THEN** the session receives the host as `reconnecting` with that reason and a null `login`, then as `needs-login` with the new URL

#### Scenario: Banner from a closed link ignored
- **WHEN** a session's link is closed and its SSH process writes a login banner while it is being terminated
- **THEN** no host entry changes

#### Scenario: Request to a needs-login host
- **WHEN** a browser sends `host{host: 1, m: watchRepo}` while host 1 is `needs-login`
- **THEN** the session receives an `error` with code `host-unavailable`

#### Scenario: One approval connects every session
- **WHEN** sessions A and B each hold a `needs-login` link to `box` over their own SSH processes, a session C is `connected` to `box`, and only A's SSH process proceeds and greets
- **THEN** B's original SSH process is terminated, B receives `box` as `connecting` and then `connected` over a new SSH process, and C receives no change to `box`

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
