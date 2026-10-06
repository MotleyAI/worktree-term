## MODIFIED Requirements

### Requirement: Handshake and version mismatch
On every new connection the daemon SHALL send `hello` with `protocol` equal to `PROTOCOL_VERSION`, its package version, and an `instance` chosen at random once per process start. If the client's first message is not `hello`, the daemon SHALL send `error{req: null, code: bad-message}` and close. If the client's `hello` carries a different `protocol`, the connection SHALL accept only the frozen `shutdown` message; every other frame, including undecodable ones, SHALL get `error{req: null, code: version-mismatch}`.

#### Scenario: Daemon hello
- **WHEN** a client connects
- **THEN** the first frame it receives is the daemon's `hello` with `protocol` 3

#### Scenario: Message before hello
- **WHEN** a client's first message is a `watchRepo`
- **THEN** the daemon replies `error` with code `bad-message` and closes the connection

#### Scenario: Mismatched client can only shut down
- **WHEN** a client sends `hello` with `protocol` 1, then a `watchRepo`, then `shutdown`
- **THEN** the `watchRepo` gets `error{req: null, code: version-mismatch}` and the `shutdown` stops the daemon
