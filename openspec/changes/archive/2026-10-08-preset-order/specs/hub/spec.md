## MODIFIED Requirements

### Requirement: Editing presets
`addPreset{req, preset}` SHALL append the preset to the presets, `removePreset{req, name}` SHALL remove the preset of exactly that name and `movePreset{req, name, to}` SHALL move the preset of exactly that name to position `to`, or to the last position when `to` is beyond it, each as a configuration edit. The requester SHALL receive `done`, and only then every open session `presets`. `addPreset` SHALL be refused with `error{req, host: null, code: internal}` naming the reason when a preset of that name exists or there would be more than 64 presets; `removePreset` SHALL be refused that way when it would remove the last preset. A `removePreset` or `movePreset` naming no preset, and a `movePreset` to the preset's own position, SHALL answer `done`, leave the file unchanged and send no `presets`.

#### Scenario: Preset added
- **WHEN** a session adds the preset `htop` (command `htop`) while `config.json` lists `shell` and two sessions are open
- **THEN** the requester receives `done`, both sessions then receive `presets` listing `shell` and `htop`, and `config.json` lists both

#### Scenario: Preset removed from the defaults
- **WHEN** `config.json` has no `presets` and a session removes `claude`
- **THEN** `config.json` lists `shell` and `codex`, and every open session receives those presets

#### Scenario: Taken name refused
- **WHEN** a session adds a preset named `shell` while `shell` exists
- **THEN** it receives `error` with code `internal` saying a preset named `shell` exists, and the file is unchanged

#### Scenario: Last preset kept
- **WHEN** `config.json` lists only `shell` and a session removes it
- **THEN** it receives `error` with code `internal` saying the last preset cannot be removed, and the file is unchanged

#### Scenario: Unknown name
- **WHEN** a session removes a preset named `nope` that does not exist
- **THEN** it receives `done`, no session receives `presets`, and the file is unchanged

#### Scenario: Preset moved
- **WHEN** `config.json` lists `shell`, `claude` and `htop`, two sessions are open and one moves `htop` to position 0
- **THEN** the requester receives `done`, both sessions then receive `presets` listing `htop`, `shell` and `claude`, and `config.json` lists them in that order

#### Scenario: Move beyond the end
- **WHEN** a session moves the first of three presets to position 63
- **THEN** it becomes the last preset
