## MODIFIED Requirements

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
