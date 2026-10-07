## Why

worktree-term reaches only the local daemon: remote hosts, installation, a desktop launcher and adding repos from the UI are still missing. This change (DEV-2054, PR 5 of 5 for DEV-1989) adds them — the "Remote hosts" and "Launch and security" sections and milestone 6 "Polish" of DEV-1989.

## What Changes

- **BREAKING** (wire): `PROTOCOL_VERSION` 5 — host entries gain `reason`; `instance` is also reported for `outdated` hosts; `discoverRepos` roots may be `~` or `~/…`, expanded by the daemon against its own home.
- `hub.links`: an SSH link per remote host per session (`ssh … -- <alias> "$HOME/.local/bin/wtd" connect`, shared ControlMaster), with the existing status machine and backoff; the latest failure's cause is reported as the host's `reason`.
- `hub.config`: `roots` and `hosts: [{name, ssh, repos, roots}]`; the hub edits `config.json` for `addRepo` / `removeRepo`.
- `hub.router`: `restartDaemon` for remote hosts; `reinstallDaemon` (install the hub's bundle on a remote host, then restart its daemon); `discoverRepos`, `addRepo`, `removeRepo` through one-shot links; one coordinator per host for restart and reinstall.
- New `platform.install`: `wtd install-local [--systemd]` and `wtd install-remote <alias> [--node <path>]` — immutable release directories under `~/.local/share/worktree-term/versions/`, an atomically swapped `current` link, a `~/.local/bin/wtd` shim bound to an absolute Node path, a `.desktop` launcher and an optional systemd user unit.
- `platform.dialer`: auto-start goes through `systemctl --user start` when the user unit is installed; builds the SSH command line.
- Web: host status badges and banners with reasons; "Restart daemon" / "Reinstall & restart" / "Install" with an in-page confirmation naming the terminals last seen on that daemon instance; "Add repo" (discovered repos or a typed path) and "Remove repo".
- README: remote hosts, installation, launcher, systemd, configuration keys.
- Additions agreed during planning beyond the DEV-2054 brief: `BatchMode`, `ConnectTimeout` and `ControlPath` SSH options; `WTD_SSH` override; host `reason`; `reinstallDaemon` for `down` remote hosts ("Install"); typed path in "Add repo"; `removeRepo`; `--node`; auto-start through systemd; tar over SSH instead of rsync; versioned release directories.

## Capabilities

### New Capabilities

### Modified Capabilities
- `protocol`: version 5; host entry `reason` and `instance` for `outdated`; `~`-relative discovery roots.
- `daemon`: protocol 5 handshake; discovery expands `~` roots against the daemon's home.
- `platform`: dialing auto-starts through systemd when the unit is installed; SSH command line and control path; new installation requirements.
- `hub`: remote hosts in configuration; SSH links and host `reason`; restart for remote hosts; reinstall; repo discovery, addition and removal.
- `web`: host status display; restart and reinstall confirmation naming terminals; add and remove repo; repo watches follow `hosts`.
- `cli`: version line shows protocol 5; `install-local` and `install-remote` options and behaviour.

## Impact

- Code: `src/protocol/**`, `src/daemon/worktrees/**`, `src/platform/dialer/**`, `src/platform/files/**`, new `src/platform/install/**`, `src/hub/**`, `src/cli/**`, `src/web/**`, `README.md`.
- Architecture: new element `platform.install` with arrows `platform.install → platform.files`, `platform.install → platform.dialer`, `cli → platform.install`, `hub.links → platform.install`; `platform.arc42.md` purpose; allowlist `platform.install`: `fs`, `child_process`.
- Tests: unit beside the code; `test/process/**` (installers into temp homes, a fake SSH remote through `WTD_SSH`); `test/e2e/**` (host status, add/remove repo, restart dialog); new `test/integration/**` (real `ssh localhost`, opt-in, needs sshd).
- Wire: `wire.golden.json` re-blessed for version 5; `frozen.golden.json` unchanged. A protocol-4 daemon shows as `outdated`.
- Dependencies: none added.
