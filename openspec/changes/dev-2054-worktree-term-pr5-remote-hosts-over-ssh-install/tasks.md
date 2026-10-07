## 1. Feasibility gate (STOP and flag on any failure)

- [x] 1.1 Probe OpenSSH ControlPersist against a reachable sshd (needs `openssh-server` on localhost with key auth — the user installs it with sudo; ask for it): whether the first `ssh -o ControlMaster=auto -o ControlPersist=10m -o ControlPath=…` client forks a backgrounded master, which of the client's stdio the master keeps open, whether killing the client leaves the master serving a second client, and whether killing the master ends every client; record the outcome in a handoff comment on DEV-2054 (design D5, D11a)
- [x] 1.2 Probe the window class GNOME on Wayland reports for `google-chrome --app=http://127.0.0.1:<port>/` (and whether it depends on the port), for the launcher's `StartupWMClass`; record it on DEV-2054 (design D11b)
- [x] 1.3 Probe `$SHELL -l -i -c 'command -v node'` run through `ssh localhost` without a tty for bash, zsh (if present) and dash: stdout noise, stderr warnings, hangs; record it on DEV-2054 (design D11c)

## 2. Architecture (approved edits)

- [x] 2.1 Add `platform.install` to `architecture/model/typescript.c4` with arrows `platform.install -> platform.files`, `platform.install -> platform.dialer`, `cli -> platform.install`, `hub.links -> platform.install`; set the `platform.arc42.md` purpose to "Node-only infrastructure shared by daemon, hub and CLI: XDG paths and file I/O (`files`); reaching a host's daemon over its socket, with auto-start, or over `ssh` (`dialer`); installing the bundle locally or over `ssh` (`install`)."; add `platform.install`: `fs`, `child_process` to the dependency allowlist in `test/architecture/dependencies.test.ts`; placeholder `src/platform/install/index.ts` keeping every new arrow live; regenerate the arc42 diagrams; verify `la-arch-check`, `likec4 validate architecture` and the architecture tests pass

## 3. Tests (pr-tests stage; all fail before implementation)

- [x] 3.1 Protocol v5 unit tests: `PROTOCOL_VERSION` 5; host entry `reason` (required, nullable, 1024 limit) and `instance` for `outdated`; discovery roots `~`, `~/x` accepted, `GitHub`, `~user/x`, `~/` rejected; `~/x` repos rejected in `watchRepo` and `addRepo`; `wire.golden.json` expectations for version 5; CLI `--version` and connect hello show 5; verify they fail
- [x] 3.2 Daemon unit/process tests: discovery expands `~` and `~/…` against the daemon's home (temp `HOME`) and dedupes; protocol-5 hello; verify they fail
- [x] 3.3 Platform unit tests: SSH command line (option order, `--`, `WTD_SSH`, alias refusal incl. leading `-`, whitespace, control characters, 256 chars); control path and unit file paths (XDG handling, 107-byte limit); dialer through systemd (unit present → `WTD_SYSTEMCTL --user start`, failure falls back, absent → detached spawn); verify they fail
- [x] 3.4 `platform.install` unit tests: ustar writer (names > 100 bytes via prefix, modes, symlink-free, round trip through `tar -t`); bootstrap command (fixed, no quote or backslash inside the single-quoted part); escaping for shim (paths with space, `'`, `$`, `%`, `\`), Desktop Entry `Exec` and systemd `ExecStart`, each checked by unescaping per its format; Node path validation (relative, NUL, newline refused); release naming and the keep-current-and-previous rule; verify they fail
- [x] 3.5 Hub unit tests: config schema (`roots`, `hosts`, alias refusal, remote `~/` repos refused, duplicate names, 63 hosts, unknown host key); host transitions carrying `reason` and `instance` for `outdated`; stderr tail (4 KiB bound, control characters, last non-empty line, 1024 cut, invalid UTF-8); config editor (local/remote host, `~/` forms kept, absent file, duplicate add, remove by `~/` form, 256 limit, invalid file, host gone); host coordinator (sharing, restart-during-reinstall, queueing); verify they fail
- [x] 3.6 `test/process` installers: `wtd install-local` into a temp `HOME` (layout, `current`, shim runs `--version`, launcher, home path with a space); `--systemd` with a fake `WTD_SYSTEMCTL` recording calls (daemon-reload, enable, start only without a running daemon); same-version reinstall keeps the first release; third install prunes the first; a process started from release 1 keeps working across two reinstalls; planted symlink / foreign-type paths refused with nothing written; `wtd install-remote` through a fake `WTD_SSH` that runs the remote command with `sh -c` under a second temp `HOME` and a PATH without Node, Node found through `--node`, through PATH and through `$SHELL -l -i`, Node 18 on PATH passed over for the login shell's Node 22; hostile `--node` creates no file; missing Node and unreachable host fail with one line and exit 1; verify they fail
- [x] 3.7 `test/process/hub-router.test.ts` / `hub-server.test.ts` with a fake remote (fake `WTD_SSH`, second temp `HOME`, installed with `install-remote`): remote host connected with name, index and `remote`; round trip through host 1; killed SSH process → `reconnecting` → `connected` with the same instance; failing SSH (stderr line) → `down` with that `reason`; 8 MiB unterminated stderr keeps RSS bounded; restart of a remote host; reinstall of an outdated (protocol-4 fake) and of a never-installed remote; restart during reinstall shares it; reinstall on host 0 refused; restart of a fake daemon speaking protocol 6 with non-v5 messages after `hello`; discover with configured roots and request-id isolation; add (done + `hosts` to two sessions, `not-a-repo`), remove (done, `busy` for running and for exited-unclosed terminals, deleted repo removed, `~/` form); config edits (invalid file untouched, host gone; the concurrent writer between read and replace is covered by the `ConfigEditor` unit test of 3.5); verify they fail
- [x] 3.8 `test/e2e/`: fixture with a fake remote host; every new and modified `web` scenario — host status on remote tabs, down banner with reason and "Install", banner cleared on recovery, outdated local "Restart daemon" and remote "Reinstall & restart" through the in-page dialog, dialog naming terminals after a reload (stored by instance), unknown-instance wording, cancel sends nothing; remote link loss keeps terminal objects; repo added from another page is watched; Add repo (discovered pick, configured repos not offered, typed path error, Escape); Remove repo (removed, busy); update PR 3/4 tests that used `window.confirm` for restart; verify they fail
- [x] 3.9 `test/integration/` (opt-in, real `ssh localhost`, needs sshd): install-remote then connect round trip; reconnect after killing the hub's SSH process; outdated remote daemon reinstalled and restarted; closing one session spares the shared master; verify they fail

## 4. Protocol v5

- [ ] 4.1 `PROTOCOL_VERSION` 5, host entry `reason` and `instance` for `outdated`, discovery-root schema; re-bless `wire.golden.json` (`frozen.golden.json` unchanged); verify 3.1 and the existing protocol tests pass

## 5. Daemon

- [ ] 5.1 `daemon.worktrees` discovery expands `~` roots against the daemon's home before resolving real paths (design D2); verify 3.2 passes

## 6. Platform

- [ ] 6.1 `platform.files`: control path and unit file paths, `lstat`-based ownership/type checks (design D7); `platform.dialer`: SSH command builder and systemd auto-start with fallback (design D4, D8); verify 3.3 passes
- [ ] 6.2 `platform.install`: bundle source resolution, ustar writer, release assembly and atomic `current` swap with pruning, shim/launcher/unit writers with per-format escaping, local and remote installation with the fixed bootstrap and in-archive script (design D3, D7, D8); verify 3.4 and 3.6 pass

## 7. Hub

- [ ] 7.1 `hub.config`: `roots`, `hosts`, remote repo rules; raw-file editor with identity/content check and retries (design D2, D9); verify the config parts of 3.5 pass
- [ ] 7.2 `hub.links`: `RemoteDaemon` over the SSH command with the D5 lifecycle and stderr tail; one-shot links; `installRemote` delegating to `platform.install`; verify the link parts of 3.5 and 3.7 pass
- [ ] 7.3 `hub.router`: per-session remote hosts, `reason`, outdated `instance`; endpoint-generic restarter; host coordinator; `reinstallDaemon`; hub-level `discoverRepos`, `addRepo`, `removeRepo`; edits pushed to every session (design D6, D9); verify 3.5 and 3.7 pass

## 8. CLI

- [ ] 8.1 Per-command option parsing, `install-local [--systemd]`, `install-remote <alias> [--node <path>]` delegating to `platform.install`, help text; remove the installer forward pointers; verify the CLI unit tests and 3.6 pass

## 9. Web

- [ ] 9.1 `web.client`: terminal memory per host key and instance (design D10); hub-level discover/add/remove/reinstall requests; watches follow `hosts` while connected, keeping repos with live terminals; verify their unit tests pass
- [ ] 9.2 `web.ui`: host status on repo tabs, down/outdated banners with actions, in-page restart/reinstall/install dialog naming terminals, Add repo dialog, Remove repo action; `icon.svg` in the web bundle as favicon; verify 3.8 passes

## 10. Documentation

- [ ] 10.1 README: remote hosts (config `hosts`, `roots`, absolute remote repos, `install-remote`, `--node`, sshd `MaxSessions`), `install-local`, the launcher, `--systemd` with `loginctl enable-linger`, `WTD_SSH`; verify the README's configuration examples parse in a unit test

## 11. Final gates

- [ ] 11.1 `pnpm test` green (incl. Playwright); `pnpm test:integration` green with sshd on localhost; `la-typecheck`, `la-arch-check`, `likec4 validate architecture` exit 0; `pnpm build` succeeds; `openspec validate dev-2054-worktree-term-pr5-remote-hosts-over-ssh-install --strict` passes
