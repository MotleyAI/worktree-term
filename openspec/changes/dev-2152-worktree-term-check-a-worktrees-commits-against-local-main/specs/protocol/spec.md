## MODIFIED Requirements

### Requirement: Protocol version and frozen handshake messages
The protocol SHALL define two integer versions: `DAEMON_PROTOCOL_VERSION`, equal to 8, for the daemon link (client ↔ daemon), and `BROWSER_PROTOCOL_VERSION`, equal to 11, for the browser link (browser ↔ hub). A change to the messages of one link SHALL raise that link's version; a change to the shared constants SHALL raise both. The `hello` message SHALL be `{t: "hello", protocol, version, instance}` where `protocol` is an integer ≥ 1 carrying the sender's version of the link it is sent on, `version` is a string of 1–64 characters, and `instance` is a string of 1–64 characters from `[A-Za-z0-9_-]`. The `shutdown` message SHALL be `{t: "shutdown"}`. The shapes of `hello` and `shutdown` and the stream frame header SHALL be identical in every version of either link, so that peers of different versions can always exchange them. The print-code line and the page fragments, exchanged between `wtd` installations of any versions, SHALL likewise never change shape.

#### Scenario: Hello round-trips
- **WHEN** a `hello` with `protocol` 1, `version` "0.1.0" and `instance` "a1B2_c3" is encoded and decoded
- **THEN** the decoded value equals the original

#### Scenario: Hello from another protocol version is still decodable
- **WHEN** a `hello` carrying `protocol` 9 is decoded
- **THEN** decoding succeeds and yields `protocol` 9

#### Scenario: Invalid instance rejected
- **WHEN** a `hello` whose `instance` contains a space is decoded
- **THEN** decoding fails with a protocol error

#### Scenario: Browser-link change leaves the daemon version
- **WHEN** a message is added to the browser-to-hub catalogue and only `BROWSER_PROTOCOL_VERSION` is raised
- **THEN** the wire golden check passes, and it fails if a daemon-link schema changed as well

#### Scenario: Shared constant needs both versions
- **WHEN** `MAX_FRAME` changes and only one of the two versions is raised
- **THEN** the wire golden check fails

#### Scenario: Frozen print-code and fragment shapes
- **WHEN** the print-code line or a page fragment schema accepts or rejects a sample differently from the frozen golden
- **THEN** the frozen golden check fails

### Requirement: Daemon-link message catalogue
Client-to-daemon messages SHALL be exactly: `hello`; `shutdown`; `watchRepo{req, repo}`; `unwatchRepo{req, repo}`; `discoverRepos{req, roots, depth}`; `createTerm{req, worktree, preset, command, cols, rows}`; `attach{req, termId}`; `detach{req, termId}`; `resize{termId, cols, rows}`; `closeTerm{req, termId}`; `ack{termId, offset}`; `setVisible{termIds}`; `setChecked{req, worktree, checked}`; `setLayout{req, worktree, layout}`; `removeWorktree{req, worktree, force}` with `force` a boolean.
Daemon-to-client messages SHALL be exactly: `hello`; `done{req}`; `error{req, code, message}`; `repoState{repo, worktrees, terminals, checked, layouts}`; `worktreesChanged{repo, worktrees}`; `termCreated{req, term}` with `req` a request id or null; `termExited{termId, code, signal}`; `termClosed{termId}`; `detached{termId, reason}`; `activity{termId, unseen, state}`; `checkedChanged{worktree, checked}`; `layoutChanged{worktree, layout}`; `reposDiscovered{req, repos}`; `worktreeAtRisk{req, worktree, local, remote, ahead, fetchFailed, changes, running}` where `local` and `remote` are each null or at most 4096 characters, `ahead` is null or an integer from 0 to 2^32−1 and is null exactly when `local` and `remote` are both null, `fetchFailed` is null or `{ref, reason}` with `ref` at most 4096 characters and `reason` at most 1024 characters, `changes` is an integer from 0 to 2^32−1 and `running` is at most 1024 terminal ids.
A worktree SHALL be `{path, head, branch, detached, locked, prunable, bare, main}`; a terminal SHALL be `{termId, worktree, preset, cols, rows, exit, unseen, state}` where `exit` is null or `{code, signal}`; `state` SHALL be one of `working`, `idle`, `input`; a `layouts` entry SHALL be `{worktree, layout}`; `reason` SHALL be `"lagging"`; `detached`, `locked`, `prunable`, `bare`, `main`, `checked`, `unseen` and `remote` SHALL be booleans; `code` SHALL be an integer; `error.req` SHALL be a request id or null.

#### Scenario: Broadcast termCreated carries a null req
- **WHEN** a `termCreated` with `req` null is decoded as a daemon-to-client message
- **THEN** decoding succeeds and yields `req` null

#### Scenario: Every daemon-link message round-trips
- **WHEN** a valid instance of each daemon-link message is encoded and decoded
- **THEN** each decoded value equals its original

#### Scenario: Detached carries a known reason
- **WHEN** a `detached` message with `reason` "closed" is decoded
- **THEN** decoding fails with a protocol error

#### Scenario: Activity carries an attention state
- **WHEN** an `activity` with `state` "input" is decoded
- **THEN** decoding succeeds and yields `state` "input"

#### Scenario: Bell flag no longer accepted
- **WHEN** an `activity` carrying `bell` instead of `state`, or a terminal entry carrying `bell`, is decoded
- **THEN** decoding fails with a protocol error

#### Scenario: Unknown attention state rejected
- **WHEN** an `activity` with `state` "busy" is decoded
- **THEN** decoding fails with a protocol error

#### Scenario: Worktree removal needs force
- **WHEN** a `removeWorktree` without `force` is decoded
- **THEN** decoding fails with a protocol error

#### Scenario: Worktree risks are counts
- **WHEN** a `worktreeAtRisk` with `ahead` −1 or `changes` 0.5 is decoded
- **THEN** decoding fails with a protocol error

#### Scenario: Commit count present exactly with a base
- **WHEN** a `worktreeAtRisk` with `ahead` null and `local` "main", or with `ahead` 0 and both `local` and `remote` null, is encoded or decoded
- **THEN** it fails with a protocol error

#### Scenario: Failed fetch carries its ref and reason
- **WHEN** a `worktreeAtRisk` with `fetchFailed` `{ref: "origin/main", reason: "ssh: connect to host github.com port 22: No route to host"}` is encoded and decoded
- **THEN** the decoded value equals the original

#### Scenario: Worktree risks are bounded and complete
- **WHEN** a `worktreeAtRisk` without `fetchFailed`, or whose `local`, `remote` or `fetchFailed.ref` exceeds 4096 characters, or whose `fetchFailed.reason` exceeds 1024 characters, is encoded or decoded
- **THEN** it fails with a protocol error

#### Scenario: Old risk shape rejected
- **WHEN** a `worktreeAtRisk` carrying `base` instead of `local` and `remote` is decoded
- **THEN** decoding fails with a protocol error

### Requirement: Shared constants
The protocol SHALL export: `DAEMON_PROTOCOL_VERSION` = 8; `BROWSER_PROTOCOL_VERSION` = 11; `MAX_FRAME` = 16 MiB; `MAX_INPUT` = 64 KiB; `FLOW_HIGH` = 512 KiB; `FLOW_LOW` = 128 KiB; `ACK_EVERY` = 64 KiB; `LAG_EVICT_MS` = 2000.

#### Scenario: Constants hold their values
- **WHEN** the exported constants are read
- **THEN** each equals the value stated above
