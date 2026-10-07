## Context

PR 5 of 5 for DEV-1989 (see proposal.md). Binding: PR 1's design (archived change `2026-10-05-dev-1989-…`) D2 (separate hub, one link code path), D4 (PTY prebuilds, install is a plain copy), D5 (outdated restart naming terminals), D6 (peer semantics, frozen `hello`/`shutdown`, `discoverRepos` from the browser carries only the host); PR 2's design (state paths and dialer; the daemon socket lives in the state directory, not `$XDG_RUNTIME_DIR`); PR 3's design (hub element split; `hub.links` owns every process the hub starts); PR 4's change `dev-2053-…`, still unarchived on this branch — this change's MODIFIED requirements are written on top of PR 4's text, so PR 4 must be archived first. `architecture/` is normative; principles applied: system 1–8; platform 1–4; hub 1–5; cli 1–2; protocol 2–4; daemon 6; web 1, 2, 4, 7.

Today: the hub holds one local link per session; `addRepo`, `removeRepo`, hub-level `discoverRepos` and `reinstallDaemon` answer "not implemented"; the installers are CLI placeholders; the outdated banner uses `window.confirm` without naming terminals. The bundle is `dist/wtd.mjs` (esbuild, PTY package external) plus `dist/web`; the PTY package needs only `package.json`, `lib/` and `prebuilds/` at run time (Linux x64/arm64/arm/ia32, glibc and musl, ABIs 111–147).

Environment fact that shaped D3: on Ubuntu, `~/.local/bin` and a user Node (`~/.local/node22/bin`) are put on PATH by `~/.bashrc` after its interactive guard or by `~/.profile`; `ssh host cmd` runs a non-interactive, non-login shell, so neither is on PATH there.

## Goals / Non-Goals

**Goals:**
- A remote host works with no dotfile edits on either side: `wtd install-remote <alias>` (or "Install" on the page) and it connects.
- Local and remote links share one status machine, one restart path and one installer.
- No action kills terminals without a confirmation that names them when they can be known.

**Non-Goals:**
- Adding or editing hosts from the page; changing hosts in open sessions (sessions keep their snapshot, PR 3).
- Installing on non-Linux remotes (no prebuilds); systemd units on remotes; `loginctl enable-linger`.
- A daemon-side lock making `removeRepo`'s terminal check atomic (point-in-time check, see spec).

## Decisions

### D1 Protocol 5
Host entries gain `reason`; `instance` is also set for `outdated` (from the frozen `hello`, which every version can decode) so the page can match the terminals it last saw; `discoverRepos.roots` accept `~` and `~/…`. `wire.golden.json` re-blessed, `frozen.golden.json` untouched; every protocol-4 reference (golden assertion, samples, `--version`, daemon and connect scenarios) moves to 5.

### D2 `~` is resolved where the home is
The hub expands `~/` only in local `repos` (as before); remote `repos` must be absolute, and discovery roots on every host stay unexpanded until the daemon expands them against its own home. Alternative — the hub learning a remote's `$HOME` through a second SSH command — rejected: a second channel outside `wtd connect`, an extra round trip per connect, and symlinked homes would make a configured path differ from the daemon's real path.

### D3 Remote command and shim
The hub runs `"$HOME/.local/bin/wtd" connect` (double-quoted `$HOME` parses alike in sh, bash, zsh and fish). The shim execs an absolute Node chosen at install time: the running Node locally; remotely `--node`, else the first Node ≥ 20 of `node` on the plain PATH and `$SHELL -l -i -c 'command -v node'` (stdout between markers, profile noise ignored); a stock Ubuntu remote often has apt's Node 18 on the plain PATH. Alternative — `#!/usr/bin/env node` and documenting PATH setup — rejected: broken on a stock Ubuntu remote and on this machine. Re-running the installer picks up a moved Node.

### D4 SSH command line (`platform.dialer`)
One builder used by the hub link and the installer: `BatchMode=yes` (no tty to prompt on), `ConnectTimeout=10`, `ControlMaster=auto` + `ControlPersist=10m` + `ControlPath=<state>/run/ssh-%C` (without a ControlPath, `ControlMaster=auto` does not multiplex), `ServerAliveInterval=15`, `--` before the alias, and alias validation (no leading `-`, no whitespace or control characters). `WTD_SSH` replaces the program, as `WTD_BROWSER` does for the browser; the process and e2e tiers use a fake SSH that runs the remote command under a second temporary home. Sessions share one master per host by design: a killed client reconnects alone; a killed master makes every link of that host reconnect.

### D5 Remote link lifecycle (`hub.links`)
`RemoteDaemon.open` mirrors `LocalDaemon.open`: same `Link` interface, frames over the child's stdio. The link ends on the child's `exit` or stdout end — never on stderr close, which a ControlPersist master forked from the child can keep open. Stderr feeds a 4 KiB rolling tail (control characters stripped) for `reason`. `close()` ends stdin and SIGTERMs the child after 1 s; the hub reaps only its own child. Probe first (task 1): whether the first client becomes the backgrounded master and what it inherits.

### D6 One host coordinator for restart and reinstall (`hub.router`)
`DaemonRestarter` generalises over a daemon endpoint (`LocalDaemon` | `RemoteDaemon`, both `open(events, {start})`; remote `start: false` is not distinguishable, since `wtd connect` always auto-starts — the loop tolerates it). A per-host coordinator, shared across sessions, runs one operation at a time: identical requests share a run, a restart during a reinstall shares the reinstall, others queue. The probe decodes only the frozen `hello` (first frame), so daemons of any other version, older or newer, can be shut down. Reinstall success requires the hub's own version and protocol, which proves the new release answered; a `down` host has no old instance, so the loop simply dials (auto-starting the new release) until such a daemon answers.

### D7 Installer (`platform.install`, new element)
Release directories are immutable and unique (`versions/<version>-<hex>`), assembled under a dot-name and renamed into place; `current` is a symlink swapped by creating a temporary link and renaming it over. The previous release is kept (a running hub may still serve `web/` from it; running daemons already loaded their code), older ones are removed. Alternatives: in-place flat layout (a window with a half-written tree, breaks a concurrent `wtd connect`); `versions/<version>` (cannot atomically replace the same version). Ownership checks use `lstat` on every path the installation owns; standard parents (`~/.local`, `~/.local/bin`, …) are created 0700 only when missing and never chmodded. Escaping is per format: POSIX single-quote escaping for the shim, Desktop Entry escaping for `Exec`, systemd escaping for `ExecStart`.
Remote transfer is one tar stream produced in-process (a small pure ustar writer; no local `tar`, no remote `rsync`) piped to a fixed bootstrap `exec sh -c 'cd && … tar -x -C "$T" && exec sh "$T/install.sh" "$T"'`, whose single-quoted part has no quote or backslash, so every common login shell parses it alike. The script, version and Node override are files in the archive, never interpolated into a command. The script prints a result line between markers; anything else on stdout is ignored.

### D8 systemd (`platform.dialer` + `platform.install`)
When the unit file exists, every auto-start goes through `systemctl --user start` (falling back to the detached spawn if that fails), so the daemon ends up under systemd after the first restart or login without killing a running one. `Restart=on-failure`, not `always`: a restart from the page sends `shutdown` (exit 0) and the next dial starts the unit; with `always`, systemd and the dialer would race and the loser's "already running" exit would loop. The daemon's start lock stays the final guard. `WTD_SYSTEMCTL` replaces the program so tests never touch the user's systemd.

### D9 Repo management through one-shot links
`discoverRepos`, `addRepo` and `removeRepo` each open a link of the hub's own to the host and close it after the answer, keeping the hub's requests out of the browser's `req` namespace on the session link (PR 1 D6). Config edits re-read the raw file, change one host's `repos` and keep everything else as written; before the atomic rename they compare the file's identity and content with what was read and start over on a mismatch (at most 3 tries), so a hand edit is never silently lost. Edits are serialised in the hub and pushed to every open session for that host only; the page then watches added repos and unwatches removed ones on its own session link.

### D10 Terminal memory for confirmations (`web.client`)
The page stores, per host key (`local`, `remote:<name>`), the daemon instance, a timestamp and up to 256 running terminals (worktree label, preset), refreshed from `repoState`, `termCreated`, `termExited`, `termClosed`. The confirmation dialog lists them only when the stored instance equals the host's reported instance. Every storage access is wrapped; failures lose only the list.

### D11 Feasibility probes before tests
(a) ControlPersist: does the first `ssh` become a backgrounded master, what does it inherit (stderr), and does killing the client leave the master serving others? (b) Chrome `--app=http://127.0.0.1:<port>/` window class under GNOME Wayland, for `StartupWMClass`. (c) `$SHELL -l -i -c 'command -v node'` over a non-tty SSH session: noise, hangs, job-control warnings. Outcomes go in a handoff comment on DEV-2054; a failure stops the work.

## Risks / Trade-offs

- [sshd `MaxSessions` (default 10) caps multiplexed sessions per master] → each page uses one session per host plus brief one-shot links; documented in the README.
- [A unit-managed daemon dies when the user manager stops at the last logout, unlike a detached daemon] → README recommends `loginctl enable-linger` with `--systemd`.
- [Unit daemons get the user manager's environment] → PTYs run `$SHELL -l -i`, which reloads the profile; GNOME imports the session environment into the user manager.
- [`removeRepo`'s terminal check is point-in-time] → a terminal created in the window keeps its repo's tab on the page (web spec) until it is closed.
- [`$SHELL -l -i` may print to stdout] → markers delimit the answer; probed (D11c).
- [The previous release is deleted by the second-next install] → a hub that old has been replaced by `wtd ui` (version check) long before.

## Migration Plan

Protocol 5: a protocol-4 daemon (local or remote) shows as `outdated`; the page offers "Restart daemon" (local) or "Reinstall & restart" (remote). Existing `config.json` files stay valid (all new keys optional). First remote use: `wtd install-remote <alias>` or "Install" on the page.
