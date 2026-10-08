## MODIFIED Requirements

### Requirement: Protocol version and frozen handshake messages
The protocol SHALL define two integer versions: `DAEMON_PROTOCOL_VERSION`, equal to 5, for the daemon link (client ↔ daemon), and `BROWSER_PROTOCOL_VERSION`, equal to 6, for the browser link (browser ↔ hub). A change to the messages of one link SHALL raise that link's version; a change to the shared constants SHALL raise both. The `hello` message SHALL be `{t: "hello", protocol, version, instance}` where `protocol` is an integer ≥ 1 carrying the sender's version of the link it is sent on, `version` is a string of 1–64 characters, and `instance` is a string of 1–64 characters from `[A-Za-z0-9_-]`. The `shutdown` message SHALL be `{t: "shutdown"}`. The shapes of `hello` and `shutdown` and the stream frame header SHALL be identical in every version of either link, so that peers of different versions can always exchange them.

#### Scenario: Hello round-trips
- **WHEN** a `hello` with `protocol` 1, `version` "0.1.0" and `instance` "a1B2_c3" is encoded and decoded
- **THEN** the decoded value equals the original

#### Scenario: Hello from another protocol version is still decodable
- **WHEN** a `hello` carrying `protocol` 7 is decoded
- **THEN** decoding succeeds and yields `protocol` 7

#### Scenario: Invalid instance rejected
- **WHEN** a `hello` whose `instance` contains a space is decoded
- **THEN** decoding fails with a protocol error

#### Scenario: Browser-link change leaves the daemon version
- **WHEN** a message is added to the browser-to-hub catalogue and only `BROWSER_PROTOCOL_VERSION` is raised
- **THEN** the wire golden check passes, and it fails if a daemon-link schema changed as well

#### Scenario: Shared constant needs both versions
- **WHEN** `MAX_FRAME` changes and only one of the two versions is raised
- **THEN** the wire golden check fails

### Requirement: Browser-link message catalogue
Browser-to-hub messages SHALL be exactly: `hello`; `host{host, m}` where `m` is any client-to-daemon message except `hello` and `shutdown`; `addRepo{req, host, repo}`; `removeRepo{req, host, repo}`; `discoverRepos{req, host}`; `restartDaemon{req, host}`; `reinstallDaemon{req, host}`; `addPreset{req, preset}`; `removePreset{req, name}` where `name` is a preset name.
Hub-to-browser messages SHALL be exactly: `hello`; `token{token}`; `host{host, m}` where `m` is any daemon-to-client message except `hello`; `hosts{hosts}`; `presets{presets}`; `done{req}`; `error{req, host, code, message}` with `req` and `host` each nullable; `reposDiscovered{req, host, repos}`.
A host entry SHALL be `{idx, name, remote, status, reason, daemonVersion, instance, repos}` with `status` one of `connecting`, `connected`, `reconnecting`, `down`, `outdated`, and `reason`, `daemonVersion` and `instance` nullable; `instance` SHALL be the `hello.instance` of the daemon the host is `connected` to or found `outdated`, and null in every other status. A preset SHALL be `{name, command}` with `command` nullable.

#### Scenario: Envelope cannot carry a handshake message
- **WHEN** a browser `host` envelope whose `m` is a `hello` or a `shutdown` is decoded
- **THEN** decoding fails with a protocol error

#### Scenario: Every browser-link message round-trips
- **WHEN** a valid instance of each browser-link message is encoded and decoded
- **THEN** each decoded value equals its original

#### Scenario: Host entry without instance rejected
- **WHEN** a `hosts` message whose entry lacks `instance` is decoded
- **THEN** decoding fails with a protocol error

#### Scenario: Host entry without reason rejected
- **WHEN** a `hosts` message whose entry lacks `reason` is decoded
- **THEN** decoding fails with a protocol error

#### Scenario: Outdated host carries its instance
- **WHEN** a `hosts` entry with `status` "outdated" and a non-null `instance` is decoded
- **THEN** decoding succeeds and yields that instance

#### Scenario: Token message only from the hub
- **WHEN** a `token` message is decoded as a browser-to-hub message
- **THEN** decoding fails with a protocol error

#### Scenario: Preset edits only from the browser
- **WHEN** a `removePreset` message is decoded as a hub-to-browser message, or an `addPreset` as a client-to-daemon message
- **THEN** decoding fails with a protocol error

#### Scenario: Invalid preset edit rejected
- **WHEN** an `addPreset` whose preset has a blank name or an empty command, or a `removePreset` with an empty name, is decoded
- **THEN** decoding fails with a protocol error

### Requirement: Shared constants
The protocol SHALL export: `DAEMON_PROTOCOL_VERSION` = 5; `BROWSER_PROTOCOL_VERSION` = 6; `MAX_FRAME` = 16 MiB; `MAX_INPUT` = 64 KiB; `FLOW_HIGH` = 512 KiB; `FLOW_LOW` = 128 KiB; `ACK_EVERY` = 64 KiB; `LAG_EVICT_MS` = 2000.

#### Scenario: Constants hold their values
- **WHEN** the exported constants are read
- **THEN** each equals the value stated above
