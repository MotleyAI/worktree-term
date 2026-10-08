## MODIFIED Requirements

### Requirement: Version output
`wtd --version` SHALL print `wtd <package version> (daemon protocol <DAEMON_PROTOCOL_VERSION>, browser protocol <BROWSER_PROTOCOL_VERSION>)` and a newline to stdout and exit 0.

#### Scenario: Version
- **WHEN** the user runs `wtd --version`
- **THEN** stdout is `wtd <package version> (daemon protocol 5, browser protocol 6)` followed by a newline, stderr is empty, and the exit code is 0
