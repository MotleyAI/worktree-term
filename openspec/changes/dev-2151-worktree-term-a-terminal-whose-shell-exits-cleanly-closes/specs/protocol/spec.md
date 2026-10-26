## MODIFIED Requirements

### Requirement: Protocol version and frozen handshake messages
The protocol SHALL define two integer versions: `DAEMON_PROTOCOL_VERSION`, equal to 7, for the daemon link (client ↔ daemon), and `BROWSER_PROTOCOL_VERSION`, equal to 10, for the browser link (browser ↔ hub). A change to the messages of one link SHALL raise that link's version; a change to the shared constants SHALL raise both. The `hello` message SHALL be `{t: "hello", protocol, version, instance}` where `protocol` is an integer ≥ 1 carrying the sender's version of the link it is sent on, `version` is a string of 1–64 characters, and `instance` is a string of 1–64 characters from `[A-Za-z0-9_-]`. The `shutdown` message SHALL be `{t: "shutdown"}`. The shapes of `hello` and `shutdown` and the stream frame header SHALL be identical in every version of either link, so that peers of different versions can always exchange them. The print-code line and the page fragments, exchanged between `wtd` installations of any versions, SHALL likewise never change shape.

#### Scenario: Hello round-trips
- **WHEN** a `hello` with `protocol` 1, `version` "0.1.0" and `instance` "a1B2_c3" is encoded and decoded
- **THEN** the decoded value equals the original

#### Scenario: Hello from another protocol version is still decodable
- **WHEN** a `hello` carrying `protocol` 8 is decoded
- **THEN** decoding succeeds and yields `protocol` 8

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
