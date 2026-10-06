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
The configuration SHALL be `config.json` holding a JSON object with optional `port` (an integer from 1024 to 65535, default 7417), optional `repos` (at most 256 paths, each absolute or starting with `~/`, which is expanded against the home directory without resolving symbolic links) and optional `presets` (1 to 64 objects `{name, command}`, each name 1–64 characters with at least one non-whitespace character and unique by exact comparison, each `command` null or 1–4096 characters); any other key, in the object or in a preset, SHALL make it invalid. Without `presets` the presets SHALL be exactly `[{name: "shell", command: null}]`; with it, exactly the listed presets in their order. A missing file SHALL mean the defaults; the hub SHALL never create it. An invalid configuration at start SHALL fail the start with one line naming the file and the first problem. Each new browser session SHALL use a snapshot of the configuration read when it starts; if that read is invalid, the session SHALL receive `error{req: null, host: null, code: internal}` naming the problem and use the last valid configuration. A changed port SHALL take effect only when the hub restarts.

#### Scenario: Defaults without a file
- **WHEN** no `config.json` exists and the hub starts
- **THEN** it listens on port 7417, lists no repos, and sessions receive the single preset `shell` with command null

#### Scenario: Unknown key refused
- **WHEN** `config.json` holds the key `theme` and the hub starts
- **THEN** the start fails with a line naming the file and `theme`

#### Scenario: Configured presets replace the default
- **WHEN** `config.json` lists presets `claude` (command `claude`) and `shell` (command null), in that order
- **THEN** sessions receive exactly those two presets in that order

#### Scenario: Invalid presets refused
- **WHEN** `config.json` holds an empty `presets` list, two presets named `a`, or a preset whose command is ""
- **THEN** the start fails with a line naming the file and `presets`

#### Scenario: Edit picked up by a new session
- **WHEN** a repo or a preset is added to `config.json` while a session is open, and a new session starts
- **THEN** the new session's `hosts` lists the repo, its `presets` lists the preset, and the open session's do not change

#### Scenario: Invalid edit keeps the last valid configuration
- **WHEN** `config.json` becomes invalid and a new session starts
- **THEN** that session receives an `internal` error and the repos and presets of the last valid configuration

### Requirement: Daemon links and host status
For each session the hub SHALL hold one link per configured host; in this version the only host is the local host, index 0, `remote` false, named by the host name truncated to 64 characters (`local` when empty). The local link SHALL dial this host's daemon, starting it when absent, and exchange `hello`. A daemon `hello` with the same `protocol` SHALL make the host `connected` with its `daemonVersion` and `instance`; another `protocol` SHALL make it `outdated` with its `daemonVersion`, keeping the link open. A failed dial or a lost link SHALL make the host `reconnecting` and retry after 250 ms, doubling up to 5 s; after 3 consecutive failures it SHALL be `down` while retrying continues. Every change of a host entry SHALL be sent to the session as `hosts`.

#### Scenario: Local host connected
- **WHEN** a session starts and no daemon is running
- **THEN** a daemon is started and the session receives `hosts` with host 0 `connected` and the daemon's instance

#### Scenario: Daemon restart observed
- **WHEN** the local daemon is killed while a session is open
- **THEN** the session receives host 0 as `reconnecting`, then `connected` with a different instance

#### Scenario: Outdated daemon
- **WHEN** the local socket is served by a daemon speaking another protocol version
- **THEN** the session receives host 0 as `outdated` with that daemon's version

### Requirement: Routing
The hub SHALL forward a browser `host{host, m}` envelope's `m` to that host's link unchanged, and every daemon message other than `hello` to the session as `host{host, m}` unchanged, never rewriting request or terminal ids. It SHALL re-frame data frames between the stream and WebSocket encodings, adding or removing only the host index. It SHALL forward `ack` unchanged and never send an `ack` of its own. A request to a host that is not `connected` SHALL get `error{req, host, code}` with `version-mismatch` when the host is `outdated` and `host-unavailable` otherwise; `ack`, `resize`, `setVisible` and input for such a host SHALL be dropped. A message naming an unknown host index SHALL get `unknown-host`. `addRepo`, `removeRepo`, hub-level `discoverRepos` and `reinstallDaemon` SHALL get `error{code: internal}` saying they are not implemented.

#### Scenario: Round trip through the hub
- **WHEN** a browser watches a repo, creates and attaches a terminal and types into it
- **THEN** it receives `repoState`, `termCreated`, the snapshot and the echoed output, each daemon message byte-identical inside its envelope

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
`restartDaemon{req, host}` for a `connected` or `outdated` local host SHALL send the daemon `shutdown`, wait until its socket is no longer served, dial until a daemon whose `hello` has another `instance` and the hub's `protocol` answers, and then reply `done`; if that does not happen within 10 s it SHALL reply `error{code: internal}`. Concurrent restarts of one host, from any sessions, SHALL share one restart. For any other status it SHALL reply `host-unavailable`.

#### Scenario: Outdated daemon restarted
- **WHEN** host 0 is `outdated` and the browser sends `restartDaemon`
- **THEN** the old daemon exits, host 0 becomes `connected` with a new instance and the hub's protocol, and the browser receives `done`

#### Scenario: Concurrent restarts start one daemon
- **WHEN** two sessions send `restartDaemon` for host 0 at the same time
- **THEN** exactly one new daemon instance serves and both receive `done`

### Requirement: Session end and hub shutdown
When a session's WebSocket closes, the hub SHALL close that session's links; terminals SHALL keep running. On `SIGTERM`, `SIGINT` or an authenticated shutdown request the hub SHALL close every session with WebSocket code 1001, close all links, stop listening, remove its hub record and exit 0.

#### Scenario: Closing the browser keeps terminals
- **WHEN** a browser with an attached terminal closes its session and a new session watches the repo
- **THEN** the terminal is listed and still running

#### Scenario: Shutdown closes sessions
- **WHEN** the hub receives `SIGTERM` with a session open
- **THEN** the session is closed with code 1001 and the hub exits 0
