## MODIFIED Requirements

### Requirement: Protocol version and frozen handshake messages
The protocol SHALL define two integer versions: `DAEMON_PROTOCOL_VERSION`, equal to 9, for the daemon link (client ↔ daemon), and `BROWSER_PROTOCOL_VERSION`, equal to 12, for the browser link (browser ↔ hub). A change to the messages of one link SHALL raise that link's version; a change to the shared constants SHALL raise both. The `hello` message SHALL be `{t: "hello", protocol, version, instance}` where `protocol` is an integer ≥ 1 carrying the sender's version of the link it is sent on, `version` is a string of 1–64 characters, and `instance` is a string of 1–64 characters from `[A-Za-z0-9_-]`. The `shutdown` message SHALL be `{t: "shutdown"}`. The shapes of `hello` and `shutdown` and the stream frame header SHALL be identical in every version of either link, so that peers of different versions can always exchange them. The print-code line and the page fragments, exchanged between `wtd` installations of any versions, SHALL likewise never change shape.

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

### Requirement: Layout validity
A layout SHALL be `{tabs, active}` with at most 64 tabs, each `{id, root}` with an optional `name` of 1–64 characters containing at least one non-whitespace character. A pane SHALL be either `{term}` or `{split, ratio, a, b}` with `split` one of `right` or `down` and `ratio` from 0.05 to 0.95. Pane nesting SHALL be at most 16 levels deep, a lone terminal pane counting as one level, a tab SHALL hold at most 8 terminal panes, each terminal id SHALL appear at most once in a layout, tab ids SHALL be unique, and `active` SHALL index an existing tab, or be 0 when there are no tabs.

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

#### Scenario: Named tab accepted
- **WHEN** a layout whose tab has `name` "build" is decoded
- **THEN** decoding succeeds and the tab keeps its name

#### Scenario: Blank tab name rejected
- **WHEN** a layout whose tab has `name` "" or "   " is decoded
- **THEN** decoding fails with a protocol error

#### Scenario: Overlong tab name rejected
- **WHEN** a layout whose tab has a `name` of 65 characters is decoded
- **THEN** decoding fails with a protocol error
