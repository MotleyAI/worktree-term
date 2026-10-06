## MODIFIED Requirements

### Requirement: Protocol version and frozen handshake messages
The protocol SHALL define an integer `PROTOCOL_VERSION`, equal to 2. The `hello` message SHALL be `{t: "hello", protocol, version, instance}` where `protocol` is an integer ≥ 1, `version` is a string of 1–64 characters, and `instance` is a string of 1–64 characters from `[A-Za-z0-9_-]`. The `shutdown` message SHALL be `{t: "shutdown"}`. The shapes of `hello` and `shutdown` and the stream frame header SHALL be identical in every protocol version, so that peers of different versions can always exchange them.

#### Scenario: Hello round-trips
- **WHEN** a `hello` with `protocol` 1, `version` "0.1.0" and `instance` "a1B2_c3" is encoded and decoded
- **THEN** the decoded value equals the original

#### Scenario: Hello from another protocol version is still decodable
- **WHEN** a `hello` carrying `protocol` 7 is decoded
- **THEN** decoding succeeds and yields `protocol` 7

#### Scenario: Invalid instance rejected
- **WHEN** a `hello` whose `instance` contains a space is decoded
- **THEN** decoding fails with a protocol error

### Requirement: Daemon-link message catalogue
Client-to-daemon messages SHALL be exactly: `hello`; `shutdown`; `watchRepo{req, repo}`; `unwatchRepo{req, repo}`; `discoverRepos{req, roots, depth}`; `createTerm{req, worktree, preset, command, cols, rows}`; `attach{req, termId}`; `detach{req, termId}`; `resize{termId, cols, rows}`; `closeTerm{req, termId}`; `ack{termId, offset}`; `setVisible{termIds}`; `setChecked{req, worktree, checked}`; `setLayout{req, worktree, layout}`.
Daemon-to-client messages SHALL be exactly: `hello`; `done{req}`; `error{req, code, message}`; `repoState{repo, worktrees, terminals, checked, layouts}`; `worktreesChanged{repo, worktrees}`; `termCreated{req, term}` with `req` a request id or null; `termExited{termId, code, signal}`; `termClosed{termId}`; `detached{termId, reason}`; `activity{termId, unseen, bell}`; `checkedChanged{worktree, checked}`; `layoutChanged{worktree, layout}`; `reposDiscovered{req, repos}`.
A worktree SHALL be `{path, head, branch, detached, locked, prunable, bare, main}`; a terminal SHALL be `{termId, worktree, preset, cols, rows, exit, unseen, bell}` where `exit` is null or `{code, signal}`; a `layouts` entry SHALL be `{worktree, layout}`; `reason` SHALL be `"lagging"`; `detached`, `locked`, `prunable`, `bare`, `main`, `checked`, `unseen`, `bell` and `remote` SHALL be booleans; `code` SHALL be an integer; `error.req` SHALL be a request id or null.

#### Scenario: Broadcast termCreated carries a null req
- **WHEN** a `termCreated` with `req` null is decoded as a daemon-to-client message
- **THEN** decoding succeeds and yields `req` null

#### Scenario: Every daemon-link message round-trips
- **WHEN** a valid instance of each daemon-link message is encoded and decoded
- **THEN** each decoded value equals its original

#### Scenario: Detached carries a known reason
- **WHEN** a `detached` message with `reason` "closed" is decoded
- **THEN** decoding fails with a protocol error

### Requirement: Request correlation
Every message that asks a peer to act and can fail SHALL carry `req`, an integer from 1 to 2^32−1, and its outcome SHALL be correlated by that `req`: `termCreated` for `createTerm`, `reposDiscovered` for `discoverRepos`, `done` for every other request, `error` for any failed request. A `termCreated` or `error` with `req` null SHALL correlate with no request. `resize`, `ack`, `setVisible`, input frames, `hello` and `shutdown` SHALL carry no `req`.

#### Scenario: Request without req rejected
- **WHEN** a `closeTerm` message without `req` is decoded
- **THEN** decoding fails with a protocol error

#### Scenario: Fire-and-forget with req rejected
- **WHEN** an `ack` message carrying `req` is decoded
- **THEN** decoding fails with a protocol error

#### Scenario: Uncorrelated error allowed
- **WHEN** a daemon `error` with `req` null is decoded
- **THEN** decoding succeeds

### Requirement: Value limits
Decoding and encoding SHALL enforce: paths are absolute, at most 4096 characters, without NUL; terminal ids are integers from 1 to 2^32−1; offsets are integers from 0 to 2^53−1; `cols` and `rows` are integers from 1 to 1000; host indices are integers from 0 to 65535; `depth` is 1–6; `head` is null or 40 or 64 lowercase hex digits; host names, preset names and tab ids are 1–64 characters; `branch` and `command` are null or at most 4096 characters; `signal` is null or at most 32 characters; `version` is 1–64 characters; error messages are at most 1024 characters; error codes are one of `bad-message`, `unknown-host`, `unknown-term`, `unknown-worktree`, `not-watched`, `busy`, `spawn-failed`, `version-mismatch`, `not-a-repo`, `internal`. Collections SHALL hold at most: 1024 worktrees, terminals, checked paths or layout entries per message; 32 discovery roots (at least 1); 4096 discovered repos; 4096 visible terminal ids; 64 hosts; 256 repos per host; 64 presets.

#### Scenario: Relative path rejected
- **WHEN** a `watchRepo` whose `repo` is "repo/a" is decoded
- **THEN** decoding fails with a protocol error

#### Scenario: Collection over limit rejected
- **WHEN** a `worktreesChanged` with 1025 worktrees is decoded
- **THEN** decoding fails with a protocol error

#### Scenario: Not-a-repo error code accepted
- **WHEN** an `error` whose `code` is "not-a-repo" is decoded
- **THEN** decoding succeeds

#### Scenario: Unknown error code rejected
- **WHEN** an `error` whose `code` is "oops" is decoded
- **THEN** decoding fails with a protocol error

### Requirement: Shared constants
The protocol SHALL export: `PROTOCOL_VERSION` = 2; `MAX_FRAME` = 16 MiB; `MAX_INPUT` = 64 KiB; `FLOW_HIGH` = 512 KiB; `FLOW_LOW` = 128 KiB; `ACK_EVERY` = 64 KiB; `LAG_EVICT_MS` = 2000.

#### Scenario: Constants hold their values
- **WHEN** the exported constants are read
- **THEN** each equals the value stated above
