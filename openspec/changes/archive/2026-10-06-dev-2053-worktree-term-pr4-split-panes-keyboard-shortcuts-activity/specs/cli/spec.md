## MODIFIED Requirements

### Requirement: Version output
`wtd --version` SHALL print `wtd <package version> (protocol <PROTOCOL_VERSION>)` and a newline to stdout and exit 0.

#### Scenario: Version
- **WHEN** the user runs `wtd --version`
- **THEN** stdout is `wtd <package version> (protocol 4)` followed by a newline, stderr is empty, and the exit code is 0
