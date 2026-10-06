## MODIFIED Requirements

### Requirement: Protocol version and frozen handshake messages
The protocol SHALL define an integer `PROTOCOL_VERSION`, equal to 3. The `hello` message SHALL be `{t: "hello", protocol, version, instance}` where `protocol` is an integer ≥ 1, `version` is a string of 1–64 characters, and `instance` is a string of 1–64 characters from `[A-Za-z0-9_-]`. The `shutdown` message SHALL be `{t: "shutdown"}`. The shapes of `hello` and `shutdown` and the stream frame header SHALL be identical in every protocol version, so that peers of different versions can always exchange them.

#### Scenario: Hello round-trips
- **WHEN** a `hello` with `protocol` 1, `version` "0.1.0" and `instance` "a1B2_c3" is encoded and decoded
- **THEN** the decoded value equals the original

#### Scenario: Hello from another protocol version is still decodable
- **WHEN** a `hello` carrying `protocol` 7 is decoded
- **THEN** decoding succeeds and yields `protocol` 7

#### Scenario: Invalid instance rejected
- **WHEN** a `hello` whose `instance` contains a space is decoded
- **THEN** decoding fails with a protocol error

### Requirement: Browser-link message catalogue
Browser-to-hub messages SHALL be exactly: `hello`; `host{host, m}` where `m` is any client-to-daemon message except `hello` and `shutdown`; `addRepo{req, host, repo}`; `removeRepo{req, host, repo}`; `discoverRepos{req, host}`; `restartDaemon{req, host}`; `reinstallDaemon{req, host}`.
Hub-to-browser messages SHALL be exactly: `hello`; `token{token}`; `host{host, m}` where `m` is any daemon-to-client message except `hello`; `hosts{hosts}`; `presets{presets}`; `done{req}`; `error{req, host, code, message}` with `req` and `host` each nullable; `reposDiscovered{req, host, repos}`.
A host entry SHALL be `{idx, name, remote, status, daemonVersion, instance, repos}` with `status` one of `connecting`, `connected`, `reconnecting`, `down`, `outdated`, and `daemonVersion` and `instance` nullable; `instance` SHALL be the `hello.instance` of the daemon the host is `connected` to, and null in every other status. A preset SHALL be `{name, command}` with `command` nullable.

#### Scenario: Envelope cannot carry a handshake message
- **WHEN** a browser `host` envelope whose `m` is a `hello` or a `shutdown` is decoded
- **THEN** decoding fails with a protocol error

#### Scenario: Every browser-link message round-trips
- **WHEN** a valid instance of each browser-link message is encoded and decoded
- **THEN** each decoded value equals its original

#### Scenario: Host entry without instance rejected
- **WHEN** a `hosts` message whose entry lacks `instance` is decoded
- **THEN** decoding fails with a protocol error

#### Scenario: Token message only from the hub
- **WHEN** a `token` message is decoded as a browser-to-hub message
- **THEN** decoding fails with a protocol error

### Requirement: Value limits
Decoding and encoding SHALL enforce: paths are absolute, at most 4096 characters, without NUL; terminal ids are integers from 1 to 2^32−1; offsets are integers from 0 to 2^53−1; `cols` and `rows` are integers from 1 to 1000; host indices are integers from 0 to 65535; `depth` is 1–6; `head` is null or 40 or 64 lowercase hex digits; host names, preset names and tab ids are 1–64 characters; `branch` and `command` are null or at most 4096 characters; `signal` is null or at most 32 characters; `version` is 1–64 characters; tokens and one-time codes are exactly 64 lowercase hex digits; error messages are at most 1024 characters; error codes are one of `bad-message`, `unknown-host`, `unknown-term`, `unknown-worktree`, `not-watched`, `busy`, `spawn-failed`, `version-mismatch`, `not-a-repo`, `host-unavailable`, `internal`. Collections SHALL hold at most: 1024 worktrees, terminals, checked paths or layout entries per message; 32 discovery roots (at least 1); 4096 discovered repos; 4096 visible terminal ids; 64 hosts; 256 repos per host; 64 presets.

#### Scenario: Relative path rejected
- **WHEN** a `watchRepo` whose `repo` is "repo/a" is decoded
- **THEN** decoding fails with a protocol error

#### Scenario: Collection over limit rejected
- **WHEN** a `worktreesChanged` with 1025 worktrees is decoded
- **THEN** decoding fails with a protocol error

#### Scenario: Not-a-repo error code accepted
- **WHEN** an `error` whose `code` is "not-a-repo" is decoded
- **THEN** decoding succeeds

#### Scenario: Host-unavailable error code accepted
- **WHEN** a hub `error` whose `code` is "host-unavailable" is decoded
- **THEN** decoding succeeds

#### Scenario: Malformed token rejected
- **WHEN** a `token` message whose `token` has 63 hex digits, or contains an uppercase digit, is decoded
- **THEN** decoding fails with a protocol error

#### Scenario: Unknown error code rejected
- **WHEN** an `error` whose `code` is "oops" is decoded
- **THEN** decoding fails with a protocol error

### Requirement: Shared constants
The protocol SHALL export: `PROTOCOL_VERSION` = 3; `MAX_FRAME` = 16 MiB; `MAX_INPUT` = 64 KiB; `FLOW_HIGH` = 512 KiB; `FLOW_LOW` = 128 KiB; `ACK_EVERY` = 64 KiB; `LAG_EVICT_MS` = 2000.

#### Scenario: Constants hold their values
- **WHEN** the exported constants are read
- **THEN** each equals the value stated above

## ADDED Requirements

### Requirement: Hub code response
The protocol SHALL define the hub's one-time code response as the JSON object `{code}`, `code` being a one-time code, decoded strictly like a control message.

#### Scenario: Code response round-trips
- **WHEN** a code response with a valid code is encoded and decoded
- **THEN** the decoded value equals the original

#### Scenario: Extra field rejected
- **WHEN** a code response carrying an additional field `token` is decoded
- **THEN** decoding fails with a protocol error
