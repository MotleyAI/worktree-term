## ADDED Requirements

### Requirement: Hub and configuration paths
The configuration directory SHALL be `$XDG_CONFIG_HOME/worktree-term` when `XDG_CONFIG_HOME` is an absolute path, and `~/.config/worktree-term` otherwise, with `config.json` the hub configuration. Under the state directory, `hub-token` SHALL be the hub token, `hub.log` the log of a detached hub, and `run/hub.lock` and `run/hub.json` the hub start lock and hub record. Files and directories created for them SHALL be owner-only, as for the daemon's.

#### Scenario: XDG_CONFIG_HOME honoured
- **WHEN** `XDG_CONFIG_HOME` is `/tmp/c`
- **THEN** the configuration file is `/tmp/c/worktree-term/config.json`

#### Scenario: Relative XDG_CONFIG_HOME ignored
- **WHEN** `XDG_CONFIG_HOME` is `rel/dir`
- **THEN** the configuration file is `~/.config/worktree-term/config.json`
