## MODIFIED Requirements

### Requirement: Daemon dialing with auto-start
Dialing SHALL connect to this host's daemon socket. When the socket does not exist or refuses connections, dialing SHALL start the daemon: when the daemon's systemd user unit file exists, by running the systemctl command with `--user start worktree-term-daemon.service`; otherwise, or when that command fails, by starting the daemon command it was given, detached in its own session with stdin ignored and stdout and stderr appended to `daemon.log` (moved to `daemon.log.1` first when over 1 MiB). It SHALL then retry connecting every 50 ms for up to 5 s. If no connection succeeds, dialing SHALL fail with `daemon did not start; see <log path>`. The systemctl command SHALL be `$WTD_SYSTEMCTL` when set and non-empty, else `systemctl`.

#### Scenario: Running daemon reused
- **WHEN** a daemon serves the socket and a client dials
- **THEN** the client connects and no daemon is started

#### Scenario: Absent daemon started
- **WHEN** no daemon serves the socket, no unit file exists, and a client dials
- **THEN** a daemon is started detached, its output goes to `daemon.log`, and the client connects

#### Scenario: Absent daemon started through systemd
- **WHEN** the unit file exists, no daemon serves the socket, and a client dials
- **THEN** the systemctl command is run with `--user start worktree-term-daemon.service` and the daemon command is not started directly

#### Scenario: Failing systemctl falls back
- **WHEN** the unit file exists, the systemctl command exits non-zero, and a client dials
- **THEN** the daemon command is started detached and the client connects

#### Scenario: Concurrent dials start one daemon
- **WHEN** two clients dial at the same time with no daemon running
- **THEN** both connect to the same daemon instance

#### Scenario: Start failure reported
- **WHEN** the daemon command exits without serving the socket
- **THEN** dialing fails after 5 s with a message naming the log path

### Requirement: Hub and configuration paths
The configuration directory SHALL be `$XDG_CONFIG_HOME/worktree-term` when `XDG_CONFIG_HOME` is an absolute path, and `~/.config/worktree-term` otherwise, with `config.json` the hub configuration. The daemon's systemd user unit file SHALL be `systemd/user/worktree-term-daemon.service` under `$XDG_CONFIG_HOME` when it is an absolute path, and under `~/.config` otherwise. Under the state directory, `hub-token` SHALL be the hub token, `hub.log` the log of a detached hub, `run/hub.lock` and `run/hub.json` the hub start lock and hub record, and `run/ssh-%C` the SSH control path, `%C` standing for the 40 hexadecimal digits SSH substitutes. A control path whose UTF-8 encoding, with `%C` substituted, exceeds 107 bytes SHALL be refused with an error naming the path. Files and directories created for them SHALL be owner-only, as for the daemon's.

#### Scenario: XDG_CONFIG_HOME honoured
- **WHEN** `XDG_CONFIG_HOME` is `/tmp/c`
- **THEN** the configuration file is `/tmp/c/worktree-term/config.json` and the unit file is `/tmp/c/systemd/user/worktree-term-daemon.service`

#### Scenario: Relative XDG_CONFIG_HOME ignored
- **WHEN** `XDG_CONFIG_HOME` is `rel/dir`
- **THEN** the configuration file is `~/.config/worktree-term/config.json`

#### Scenario: Over-long control path refused
- **WHEN** the state directory is so long that the substituted control path encodes to 108 bytes
- **THEN** resolving the control path fails with an error naming the path

## ADDED Requirements

### Requirement: SSH command line
The SSH command for an alias SHALL be the SSH program followed by `-o BatchMode=yes -o ConnectTimeout=10 -o ControlMaster=auto -o ControlPersist=10m -o ControlPath=<control path> -o ServerAliveInterval=15 --`, the alias, and the remote command as one argument. The SSH program SHALL be `$WTD_SSH` when set and non-empty, else `ssh`. An alias that is empty, longer than 255 characters, starts with `-`, or contains whitespace or a control character SHALL be refused with an error naming it. Every SSH process the hub or an installer starts SHALL use this command line.

#### Scenario: Options precede the alias
- **WHEN** the SSH command for alias `box` and remote command `"$HOME/.local/bin/wtd" connect` is built
- **THEN** its arguments are the options above, `--`, `box` and `"$HOME/.local/bin/wtd" connect`, in that order

#### Scenario: Option-like alias refused
- **WHEN** the SSH command for alias `-oProxyCommand=touch /tmp/x` is built
- **THEN** building fails with an error naming the alias and nothing is run

### Requirement: Installed layout
An installation SHALL place under the data directory `~/.local/share/worktree-term` a release directory `versions/<version>-<12 random lowercase hex digits>` holding `wtd.mjs`, the web bundle as `web/`, and `node_modules/@homebridge/node-pty-prebuilt-multiarch/` with only that package's `package.json`, `LICENSE`, `lib/` and `prebuilds/`. A release SHALL be assembled under a name starting with `.` in `versions/` and renamed into place once complete, and SHALL never be changed afterwards. The symbolic link `current` in the data directory SHALL then be replaced atomically to point to the new release. Afterwards every release other than the new one and the one `current` pointed to before SHALL be removed. The shim `~/.local/bin/wtd` SHALL be a POSIX shell script that runs the installation's Node, given by absolute path, with `$HOME/.local/share/worktree-term/current/wtd.mjs` and all its arguments, written atomically with mode 0700. The Node SHALL be an absolute path without NUL or newline, of version 20 or later, and the shim SHALL run it correctly whatever other characters its path holds. Directories created for the installation SHALL be owner-only; existing parent directories outside the data directory SHALL be left as they are. A path the installation owns — the data directory and everything below it, the shim, the launcher and the unit file — that exists but is a symbolic link where a directory or file is expected (other than `current`), is of the wrong type, or is owned by another user SHALL make the installation fail naming it, changing nothing.

#### Scenario: Fresh layout
- **WHEN** an installation of version 0.2.0 runs in an empty home
- **THEN** `current` points to `versions/0.2.0-<hex>`, which holds `wtd.mjs`, `web/index.html` and the PTY package's `prebuilds/`, and `~/.local/bin/wtd --version` prints the version

#### Scenario: Same version reinstalled
- **WHEN** version 0.2.0 is installed twice
- **THEN** `current` points to a different release directory than after the first installation, and the first release still exists

#### Scenario: Old releases removed
- **WHEN** three installations run one after the other
- **THEN** only the releases of the second and third remain

#### Scenario: Running release keeps working during a swap
- **WHEN** a process started through the shim keeps running while a new release is installed
- **THEN** that process keeps working and the shim's next run uses the new release

#### Scenario: Unusual Node path
- **WHEN** the Node path contains a space, a single quote, `$` and `%`
- **THEN** the shim runs that Node

#### Scenario: Planted symbolic link refused
- **WHEN** `~/.local/share/worktree-term/versions` is a symbolic link
- **THEN** the installation fails naming that path and nothing is written

### Requirement: Local installation
A local installation SHALL install, as the installed layout states, the bundle of the running `wtd` — its `wtd.mjs`, the web bundle beside it and the PTY package it resolves — using the running Node. It SHALL then write the launcher `~/.local/share/applications/worktree-term.desktop`, owner-only, as a desktop entry of type `Application` named `worktree-term`, not run in a terminal, whose `Exec` runs the shim with `ui`, whose `Icon` is `icon.svg` of the web bundle under `current`, and whose `StartupWMClass` is the window class of the Chrome app window `wtd ui` opens; each value SHALL be escaped as desktop entries require. With the systemd option it SHALL also write the unit file, owner-only, running the shim with `daemon` (escaped as unit files require), with `Restart=on-failure` and installed for `default.target`; run the systemctl command with `--user daemon-reload` and then `--user enable worktree-term-daemon.service`; and start the unit as dialing does only when no daemon serves this host's socket, leaving a running daemon alone. A failing systemctl command SHALL fail the installation naming the command.

#### Scenario: Launcher written
- **WHEN** a local installation runs in a home whose path contains a space
- **THEN** the launcher exists and its `Exec` line, unescaped as desktop entries define, runs the shim with `ui`

#### Scenario: Unit installed and enabled
- **WHEN** a local installation runs with the systemd option and no daemon is running
- **THEN** the unit file exists, the systemctl command was run with daemon-reload, enable and start, and the unit's `ExecStart` runs the shim with `daemon`

#### Scenario: Running daemon left alone
- **WHEN** a local installation runs with the systemd option while a daemon serves the socket
- **THEN** the unit is enabled but not started, and the running daemon keeps its instance

### Requirement: Remote installation
A remote installation SHALL send the bundle of the running `wtd` as one tar archive to the SSH command for the alias, whose remote command SHALL be fixed and contain no quote inside its single-quoted part, so that every common login shell runs it alike. Every value the remote side needs — the version, the Node path given, the install script — SHALL travel inside the archive, never in the command. On the remote host it SHALL refuse a system other than Linux; take the given Node path, refusing it when it is older than 20; without one, take the first Node of version 20 or later among `node` on the command's PATH, the path `$SHELL -l -i -c 'command -v node'` prints between markers, and the Node the installed shim runs, in that order; and install as the installed layout states, without launcher or unit file. It SHALL succeed naming the release and the Node used, and fail with one line naming the cause: the remote installer's message, or else the last non-empty line SSH wrote to standard error.

#### Scenario: Remote installed
- **WHEN** a remote installation runs to a host with Node 22 only in its login shell's PATH
- **THEN** the remote `~/.local/bin/wtd connect` bridges to a daemon of the installed version, run by that Node

#### Scenario: Old Node on the command's PATH passed over
- **WHEN** the command's PATH holds Node 18 and the login shell's PATH holds Node 22
- **THEN** the installation uses the login shell's Node 22

#### Scenario: Hostile Node path is data
- **WHEN** the given Node path is `/opt/n'; touch x; '/node`
- **THEN** no file `x` is created and the installation fails naming that path as not a usable Node

#### Scenario: Missing Node reported
- **WHEN** the remote host has no Node of version 20 or later
- **THEN** the installation fails with a line naming the alias and the missing Node, and the remote layout is unchanged

#### Scenario: Unreachable host reported
- **WHEN** SSH cannot reach the alias
- **THEN** the installation fails with SSH's last error line
