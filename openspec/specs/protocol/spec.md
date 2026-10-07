# protocol Specification

## Purpose
The wire contract between the browser UI, the hub and every daemon: which messages exist, how they are framed on each transport, and which values are valid, so that every peer encodes and decodes identically.

## Requirements

### Requirement: Protocol version and frozen handshake messages
The protocol SHALL define an integer `PROTOCOL_VERSION`, equal to 4. The `hello` message SHALL be `{t: "hello", protocol, version, instance}` where `protocol` is an integer ≥ 1, `version` is a string of 1–64 characters, and `instance` is a string of 1–64 characters from `[A-Za-z0-9_-]`. The `shutdown` message SHALL be `{t: "shutdown"}`. The shapes of `hello` and `shutdown` and the stream frame header SHALL be identical in every protocol version, so that peers of different versions can always exchange them.

#### Scenario: Hello round-trips
- **WHEN** a `hello` with `protocol` 1, `version` "0.1.0" and `instance` "a1B2_c3" is encoded and decoded
- **THEN** the decoded value equals the original

#### Scenario: Hello from another protocol version is still decodable
- **WHEN** a `hello` carrying `protocol` 7 is decoded
- **THEN** decoding succeeds and yields `protocol` 7

#### Scenario: Invalid instance rejected
- **WHEN** a `hello` whose `instance` contains a space is decoded
- **THEN** decoding fails with a protocol error

### Requirement: Strict control-message decoding
A control message SHALL be one UTF-8 JSON object whose `t` names a message of the decoding direction and whose fields are exactly those of that message. Decoding SHALL reject, with a protocol error and without coercion or repair: invalid UTF-8, invalid JSON, a non-object, an unknown `t`, a message of the opposite direction, a missing field, an extra field, a value of the wrong type, and a value outside its bounds. Encoding SHALL reject any value that would not decode.

#### Scenario: Extra field rejected
- **WHEN** an `attach` message carrying an additional field `x` is decoded
- **THEN** decoding fails with a protocol error

#### Scenario: No numeric coercion
- **WHEN** a `resize` message whose `cols` is the string "80" is decoded
- **THEN** decoding fails with a protocol error

#### Scenario: Wrong direction rejected
- **WHEN** a `repoState` message is decoded as a client-to-daemon message
- **THEN** decoding fails with a protocol error

#### Scenario: Invalid UTF-8 rejected
- **WHEN** a control payload containing the byte 0xFF is decoded
- **THEN** decoding fails with a protocol error

#### Scenario: Encoder refuses invalid values
- **WHEN** a `resize` message with `cols` 0 is encoded
- **THEN** encoding fails with a protocol error

### Requirement: Daemon-link message catalogue
Client-to-daemon messages SHALL be exactly: `hello`; `shutdown`; `watchRepo{req, repo}`; `unwatchRepo{req, repo}`; `discoverRepos{req, roots, depth}`; `createTerm{req, worktree, preset, command, cols, rows}`; `attach{req, termId}`; `detach{req, termId}`; `resize{termId, cols, rows}`; `closeTerm{req, termId}`; `ack{termId, offset}`; `setVisible{termIds}`; `setChecked{req, worktree, checked}`; `setLayout{req, worktree, layout}`.
Daemon-to-client messages SHALL be exactly: `hello`; `done{req}`; `error{req, code, message}`; `repoState{repo, worktrees, terminals, checked, layouts}`; `worktreesChanged{repo, worktrees}`; `termCreated{req, term}` with `req` a request id or null; `termExited{termId, code, signal}`; `termClosed{termId}`; `detached{termId, reason}`; `activity{termId, unseen, state}`; `checkedChanged{worktree, checked}`; `layoutChanged{worktree, layout}`; `reposDiscovered{req, repos}`.
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
Decoding and encoding SHALL enforce: paths are absolute, at most 4096 characters, without NUL; terminal ids are integers from 1 to 2^32−1; offsets are integers from 0 to 2^53−1; `cols` and `rows` are integers from 1 to 1000; host indices are integers from 0 to 65535; `depth` is 1–6; `head` is null or 40 or 64 lowercase hex digits; host names and tab ids are 1–64 characters; preset names are 1–64 characters with at least one non-whitespace character; `branch` and `command` are null or at most 4096 characters, and a preset's `command` is null or 1–4096 characters; `signal` is null or at most 32 characters; `version` is 1–64 characters; tokens and one-time codes are exactly 64 lowercase hex digits; error messages are at most 1024 characters; error codes are one of `bad-message`, `unknown-host`, `unknown-term`, `unknown-worktree`, `not-watched`, `busy`, `spawn-failed`, `version-mismatch`, `not-a-repo`, `host-unavailable`, `internal`. Collections SHALL hold at most: 1024 worktrees, terminals, checked paths or layout entries per message; 32 discovery roots (at least 1); 4096 discovered repos; 4096 visible terminal ids; 64 hosts; 256 repos per host; 64 presets.

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

#### Scenario: Blank preset name rejected
- **WHEN** a `presets` message with a preset named "   " is decoded
- **THEN** decoding fails with a protocol error

#### Scenario: Empty preset command rejected
- **WHEN** a `presets` message with a preset whose `command` is "" is decoded
- **THEN** decoding fails with a protocol error

### Requirement: Layout validity
A layout SHALL be `{tabs, active}` with at most 64 tabs, each `{id, root}`. A pane SHALL be either `{term}` or `{split, ratio, a, b}` with `split` one of `right` or `down` and `ratio` from 0.05 to 0.95. Pane nesting SHALL be at most 16 levels deep, a lone terminal pane counting as one level, a tab SHALL hold at most 8 terminal panes, each terminal id SHALL appear at most once in a layout, tab ids SHALL be unique, and `active` SHALL index an existing tab, or be 0 when there are no tabs.

#### Scenario: Duplicate terminal rejected
- **WHEN** a layout whose split has the same `term` in both children is decoded
- **THEN** decoding fails with a protocol error

#### Scenario: Depth limit enforced
- **WHEN** a layout nested 17 levels deep is decoded
- **THEN** decoding fails with a protocol error

#### Scenario: Pane limit enforced
- **WHEN** a layout whose tab holds 9 terminal panes is decoded
- **THEN** decoding fails with a protocol error

#### Scenario: Eight panes accepted
- **WHEN** a layout whose tab holds 8 terminal panes is decoded
- **THEN** decoding succeeds

#### Scenario: Active index out of range
- **WHEN** a layout with 2 tabs and `active` 2 is decoded
- **THEN** decoding fails with a protocol error

#### Scenario: Empty layout accepted
- **WHEN** a layout with no tabs and `active` 0 is decoded
- **THEN** decoding succeeds

### Requirement: Stream framing
On a byte stream (unix socket, SSH stdio) every frame SHALL be a 4-byte big-endian payload length, a 1-byte kind, and the payload. Kinds SHALL be 0 control (UTF-8 JSON), 1 output, 2 snapshot, 3 input. The payload SHALL be at most `MAX_FRAME` bytes. A stream decoder SHALL yield exactly the sent frames, in order, for any split of the stream into chunks. It SHALL fail on a length above `MAX_FRAME`, an unknown kind, or a partial frame at end of stream, and SHALL stay failed once it has failed.

#### Scenario: Arbitrary chunking
- **WHEN** three frames are fed to the decoder one byte at a time, and again as one chunk
- **THEN** both runs yield the same three frames in order

#### Scenario: Oversize frame
- **WHEN** a header announcing `MAX_FRAME` + 1 bytes is fed
- **THEN** the decoder fails with a protocol error before the payload arrives

#### Scenario: Truncated at end of stream
- **WHEN** the stream ends after half of a frame's payload
- **THEN** ending the decoder fails with a protocol error

#### Scenario: Failed decoder stays failed
- **WHEN** a decoder that has failed is fed a valid frame
- **THEN** it fails again and yields no frame

### Requirement: Data frames
On a stream, an output or snapshot payload SHALL be a 4-byte terminal id, an 8-byte big-endian offset and the bytes; an input payload SHALL be a 4-byte terminal id and the bytes. On a WebSocket, control messages SHALL be text messages and data frames binary messages of a 1-byte kind, a 2-byte host index, a 4-byte terminal id, for output and snapshot an 8-byte offset, and the bytes. An output frame's offset SHALL be the terminal output position of its first byte; a snapshot's offset SHALL be the output position it reflects, at which the next output frame begins; `ack.offset` SHALL be the position up to which output was consumed (exclusive). Offsets above 2^53−1 SHALL be rejected. Input bytes SHALL be at most `MAX_INPUT` per frame. All multi-byte integers SHALL be big-endian.

#### Scenario: Output frame round-trips on both transports
- **WHEN** an output frame for terminal 7 at offset 2^40 with 3 bytes is encoded and decoded for a stream and, with host 2, for a WebSocket
- **THEN** both decode to terminal 7, offset 2^40 and the same bytes, and the WebSocket frame also yields host 2

#### Scenario: Unsafe offset rejected
- **WHEN** a data frame whose offset is 2^53 is decoded
- **THEN** decoding fails with a protocol error

#### Scenario: Oversized input refused
- **WHEN** an input frame with `MAX_INPUT` + 1 bytes is encoded
- **THEN** encoding fails with a protocol error

#### Scenario: Terminal id zero rejected
- **WHEN** a data frame with terminal id 0 is decoded
- **THEN** decoding fails with a protocol error

### Requirement: Shared constants
The protocol SHALL export: `PROTOCOL_VERSION` = 4; `MAX_FRAME` = 16 MiB; `MAX_INPUT` = 64 KiB; `FLOW_HIGH` = 512 KiB; `FLOW_LOW` = 128 KiB; `ACK_EVERY` = 64 KiB; `LAG_EVICT_MS` = 2000.

#### Scenario: Constants hold their values
- **WHEN** the exported constants are read
- **THEN** each equals the value stated above

### Requirement: Hub code response
The protocol SHALL define the hub's one-time code response as the JSON object `{code}`, `code` being a one-time code, decoded strictly like a control message.

#### Scenario: Code response round-trips
- **WHEN** a code response with a valid code is encoded and decoded
- **THEN** the decoded value equals the original

#### Scenario: Extra field rejected
- **WHEN** a code response carrying an additional field `token` is decoded
- **THEN** decoding fails with a protocol error
