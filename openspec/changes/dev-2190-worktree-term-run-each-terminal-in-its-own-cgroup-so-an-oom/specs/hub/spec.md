## ADDED Requirements

### Requirement: Hub placement
Once it holds the hub start lock and before it listens, the hub SHALL find whether it has a lasting user manager (see `platform`) and, when it has one, enter a hub scope; however it was started — by `wtd ui`, by `wtd hub` in the foreground, or by a script. A failure to enter SHALL be reported on its standard error and the hub SHALL run on in its cgroup. In every case it SHALL then lower its own `oom_score_adj` to the lowest value the kernel permits it, so that a hub started from a terminal does not keep the terminal's adjustment.

#### Scenario: Hub started by the UI command in its own scope
- **WHEN** `wtd ui --print-code` starts a hub from a process under the user manager
- **THEN** the serving hub's pid, as its hub record names it, has a `wtd-<h>-hub-<r>.scope` cgroup under `app-wtd.slice`, neither the starting process's cgroup nor a terminal's

#### Scenario: Foreground hub in its own scope
- **WHEN** the user runs `wtd hub` in a terminal
- **THEN** the hub's cgroup is a hub scope, not that terminal's scope

#### Scenario: Hub started in a terminal gives up the terminal's adjustment
- **WHEN** the user runs `wtd hub` in a terminal
- **THEN** the hub's `oom_score_adj` is below 500

#### Scenario: No lasting user manager
- **WHEN** the hub starts without a lasting user manager
- **THEN** it serves from the cgroup it was started in

### Requirement: Preset memory limits
Each preset a session receives in `presets` SHALL carry its effective limits as `memory`, omitted when they are empty. Configuration edits SHALL keep the `memory` stored with every preset they do not remove, and `addPreset` SHALL store the `memory` it carries, if any.

#### Scenario: Effective limits sent
- **WHEN** `config.json` holds `terminalMemory` `{high: "16G", max: "32G"}` and presets `shell` without `memory` and `tests` with `memory` `{max: "24G"}`
- **THEN** sessions receive `shell` with `memory` `{high: "16G", max: "32G"}` and `tests` with `memory` `{high: "16G", max: "24G"}`

#### Scenario: No limits configured
- **WHEN** `config.json` holds no `terminalMemory` and no preset `memory`
- **THEN** no preset in `presets` carries `memory`

#### Scenario: Edits keep stored limits
- **WHEN** a preset `tests` with `memory` `{max: "24G"}` is moved and another preset is added and removed
- **THEN** `config.json` still holds `tests` with `memory` `{max: "24G"}` and no merged `terminalMemory` keys

## MODIFIED Requirements

### Requirement: Configuration
The configuration SHALL be `config.json` holding a JSON object with optional `port` (an integer from 1024 to 65535, default 7417), optional `repos` (at most 256 paths, each absolute or starting with `~/`, which is expanded against the home directory without resolving symbolic links), optional `roots` (1 to 32 discovery roots, each an absolute path, `~`, or `~/` followed by at least one character; default `["~"]`; never expanded by the hub), optional `presets` (1 to 64 objects `{name, command, memory}`, `memory` optional, each name 1–64 characters with at least one non-whitespace character and unique by exact comparison, each `command` null or 1–4096 characters, each `memory` memory limits as the protocol states), optional `terminalMemory` (memory limits) and optional `hosts` (at most 63 objects `{name, ssh, port, repos, roots}`, `port`, `repos` and `roots` optional). A host's `name` SHALL be 1–64 characters from `[A-Za-z0-9._-]`, unique among hosts; its `ssh` alias SHALL be 1–255 characters without whitespace or control characters and SHALL NOT start with `-`; its `port` SHALL be an integer from 1024 to 65535, unique among hosts and different from the hub's `port` (its default included); its `repos` SHALL be at most 256 absolute paths; its `roots` SHALL follow the rules and default of the top-level `roots`. The top-level `repos` and `roots` SHALL belong to the local host. Any other key, in the object, in a preset, in memory limits or in a host, SHALL make it invalid. A preset's **effective limits** SHALL be `terminalMemory` with each key the preset's `memory` holds replaced by its value; effective limits whose `high` exceeds their `max`, both being sizes without `%`, SHALL make the configuration invalid, naming the preset. Without `presets` the presets SHALL be exactly `[{name: "shell", command: null}, {name: "claude", command: "claude"}, {name: "codex", command: "codex"}]`; with it, exactly the listed presets in their order. A missing file SHALL mean the defaults; the hub SHALL create it only to record a repo or preset edit from the page. An invalid configuration at start SHALL fail the start with one line naming the file and the first problem. Each new browser session SHALL use a snapshot of the configuration read when it starts; if that read is invalid, the session SHALL receive `error{req: null, host: null, code: internal}` naming the problem and use the last valid configuration. A changed port SHALL take effect only when the hub restarts.

#### Scenario: Defaults without a file
- **WHEN** no `config.json` exists and the hub starts
- **THEN** it listens on port 7417, lists no repos and no remote hosts, and sessions receive the presets `shell` (command null), `claude` (command `claude`) and `codex` (command `codex`), in that order

#### Scenario: Unknown key refused
- **WHEN** `config.json` holds the key `theme` and the hub starts
- **THEN** the start fails with a line naming the file and `theme`

#### Scenario: Configured presets replace the default
- **WHEN** `config.json` lists presets `claude` (command `claude`) and `shell` (command null), in that order
- **THEN** sessions receive exactly those two presets in that order

#### Scenario: Invalid presets refused
- **WHEN** `config.json` holds an empty `presets` list, two presets named `a`, or a preset whose command is ""
- **THEN** the start fails with a line naming the file and `presets`

#### Scenario: Remote hosts listed in order
- **WHEN** `config.json` lists hosts `b` and `a`, in that order
- **THEN** sessions receive `hosts` with the local host at index 0, `b` at index 1 and `a` at index 2, both remote

#### Scenario: Option-like alias refused
- **WHEN** a host's `ssh` is `-oProxyCommand=x` or contains a space
- **THEN** the start fails with a line naming the file and `ssh`

#### Scenario: Home-relative remote repo refused
- **WHEN** a host's `repos` holds `~/app`
- **THEN** the start fails with a line naming the file and `repos`

#### Scenario: Duplicate host names refused
- **WHEN** two hosts are named `box`
- **THEN** the start fails with a line naming the file and `hosts`

#### Scenario: Clashing host ports refused
- **WHEN** two hosts have `port` 7420, or a host has `port` 7417 while the top-level `port` is absent
- **THEN** the start fails with a line naming the file and `port`

#### Scenario: Edit picked up by a new session
- **WHEN** a repo or a preset is added to `config.json` by hand while a session is open, and a new session starts
- **THEN** the new session's `hosts` lists the repo, its `presets` lists the preset, and the open session's do not change

#### Scenario: Invalid edit keeps the last valid configuration
- **WHEN** `config.json` becomes invalid and a new session starts
- **THEN** that session receives an `internal` error and the repos and presets of the last valid configuration

#### Scenario: Memory limits accepted
- **WHEN** `config.json` holds `terminalMemory` `{high: "16G"}` and a preset `tests` with `memory` `{max: "24G", swapMax: "0"}`
- **THEN** the hub starts

#### Scenario: Malformed memory limits refused
- **WHEN** `config.json` holds `terminalMemory` `{max: "lots"}`, or a preset whose `memory` holds the key `min`
- **THEN** the start fails with a line naming the file and `terminalMemory` or `presets`

#### Scenario: High above max after the merge refused
- **WHEN** `config.json` holds `terminalMemory` `{high: "32G"}` and a preset `tests` with `memory` `{max: "16G"}`
- **THEN** the start fails with a line naming the file and the preset `tests`

#### Scenario: Percent and size not compared
- **WHEN** a preset's effective limits are `{high: "50%", max: "16G"}`
- **THEN** the hub starts
